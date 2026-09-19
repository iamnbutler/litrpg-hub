/** Scheduled catalog refresh. Private evidence stays in the private release repository.
 * Importing this module opens no database and performs no network or filesystem writes. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import type { GrindOptions, GrindSummary } from '../catalog/grind.js';
import type { SeedSeries } from '../catalog/types.js';
import { verifyBackupSnapshot } from '../storage/verify-backup.js';

export const PUBLIC_REPOSITORY = 'iamnbutler/litrpg-hub';
export const DATA_REPOSITORY = 'iamnbutler/litrpg-hub-data';
export const LIMITS = Object.freeze({ sources: 25, audio: 25, extract: 10, assess: 10 });
const WORK_MS = 16 * 60_000;
const RUN_MS = 27 * 60_000;
const ARCHIVE_LIMIT = 1024 * 1024 * 1024;
const stages = ['sources', 'audio', 'extract', 'assess'] as const;
const ARCHIVE_TAG = /^catalog-[A-Za-z0-9_-]+$/;
export const PUBLIC_FILE = /^static\/data\/(?:\d{4}|catalog|series|review|meta|health)\.json$/;
const EXTRACTOR = String.raw`import gzip, hashlib, json, os, re, sys, tarfile
archive, destination, root = sys.argv[1:]
limit = 3 * 1024 * 1024 * 1024
allowed = re.compile(r"(?:books\.db|covers/[a-f0-9]{64}\.(?:jpg|png|webp))")
class Bounded:
    def __init__(self, stream):
        self.stream, self.total = stream, 0
    def read(self, size=-1):
        if size < 0: size = 1024 * 1024
        chunk = self.stream.read(min(size, 1024 * 1024))
        self.total += len(chunk)
        if self.total > limit: raise ValueError()
        return chunk
def scan(source, extract=False, expected=None, manifest=None):
    source.seek(0)
    found, names, total, raw_manifest = [], set(), 0, None
    with gzip.GzipFile(fileobj=source, mode="rb") as compressed:
        with tarfile.open(fileobj=Bounded(compressed), mode="r|") as tar:
            for entry in tar:
                name = entry.name
                if name in names or len(found) >= 20000: raise ValueError()
                names.add(name)
                directory = entry.type == tarfile.DIRTYPE
                if directory:
                    if name.rstrip("/") not in (root, root + "/covers"): raise ValueError()
                elif entry.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or entry.sparse:
                    raise ValueError()
                else:
                    if not name.startswith(root + "/"): raise ValueError()
                    relative = name[len(root) + 1:]
                    if relative != "manifest.json" and not allowed.fullmatch(relative): raise ValueError()
                    if entry.size < 0: raise ValueError()
                    total += entry.size
                    if total > limit: raise ValueError()
                identity = (name, entry.type.decode("ascii"), entry.size)
                found.append(identity)
                if extract and (len(found) > len(expected) or identity != expected[len(found)-1]): raise ValueError()
                if directory: continue
                relative = name[len(root) + 1:]
                stream = tar.extractfile(entry)
                if stream is None: raise ValueError()
                if relative == "manifest.json":
                    if entry.size > 2 * 1024 * 1024: raise ValueError()
                    raw_manifest = stream.read()
                    if len(raw_manifest) != entry.size: raise ValueError()
                    if extract and raw_manifest != manifest: raise ValueError()
                if extract:
                    target = os.path.join(destination, root, relative)
                    os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
                    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(descriptor, "wb") as output:
                        if relative == "manifest.json": output.write(raw_manifest)
                        else:
                            while True:
                                chunk = stream.read(1024 * 1024)
                                if not chunk: break
                                output.write(chunk)
    if extract and found != expected: raise ValueError()
    return found, raw_manifest
try:
    descriptor = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as source:
        entries, raw = scan(source)
        manifest = json.loads(raw)
        if manifest.get("version") != 1 or not isinstance(manifest.get("files"), list): raise ValueError()
        declared = {}
        for item in manifest["files"]:
            path, size, checksum = item.get("path"), item.get("bytes"), item.get("sha256")
            if not isinstance(path, str) or not allowed.fullmatch(path) or path in declared: raise ValueError()
            if type(size) is not int or size < 0 or size > limit: raise ValueError()
            if not isinstance(checksum, str) or not re.fullmatch("[a-f0-9]{64}", checksum): raise ValueError()
            declared[path] = size
        actual = {name[len(root)+1:]: size for name, kind, size in entries if kind in ("0", "\x00") and name != root + "/manifest.json"}
        if "books.db" not in declared or actual != declared: raise ValueError()
        # No extraction until every member and the complete manifest layout have passed.
        scan(source, True, entries, raw)
except Exception:
    sys.exit(1)
`;

export class WorkerError extends Error {
  constructor(readonly code: string) { super('Catalog automation stopped (' + code + '). Private details are not logged.'); }
}

/** Reserve a complete run before the blackout; never even restore during 22:00–02:00 UTC. */
export function assertWindow(now = new Date(), reserveMs = 0): void {
  if (!Number.isFinite(now.getTime())) throw new WorkerError('invalid-clock');
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22);
  if (now.getTime() < start || now.getTime() >= end || now.getTime() + reserveMs > end) {
    throw new WorkerError('outside-run-window');
  }
}

export interface CommandOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal }
/** Capture both streams completely; errors never expose a child command's source text or credentials. */
export function runCaptured(command: string, args: string[], options: CommandOptions = {}): Promise<string> {
  return new Promise((accept, reject) => {
    if (options.signal?.aborted) { reject(new WorkerError('command-interrupted')); return; }
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', size = 0, failed = false, force: NodeJS.Timeout | undefined;
    const stop = () => {
      if (failed) return;
      failed = true;
      child.kill('SIGINT');
      force = setTimeout(() => child.kill('SIGKILL'), 75_000);
      force.unref();
    };
    const timeout = setTimeout(stop, options.timeoutMs ?? 60_000);
    options.signal?.addEventListener('abort', stop, { once: true });
    const receive = (buffer: Buffer, output: boolean) => {
      size += buffer.length;
      if (size > 2_000_000) { stop(); return; }
      if (output) stdout += buffer.toString('utf8');
      // stderr is drained and discarded, never attached to an Error or public log.
    };
    child.stdout.on('data', buffer => receive(buffer, true));
    child.stderr.on('data', buffer => receive(buffer, false));
    child.on('error', () => { clearTimeout(timeout); if (force) clearTimeout(force); options.signal?.removeEventListener('abort', stop); reject(new WorkerError('command-failed')); });
    child.on('close', code => {
      clearTimeout(timeout); if (force) clearTimeout(force);
      options.signal?.removeEventListener('abort', stop);
      if (failed || code !== 0) reject(new WorkerError('command-failed'));
      else accept(stdout);
    });
  });
}

export function selectArchive(value: unknown): { tag: string; archive: string; checksum: string } {
  const release = value as { tagName?: unknown; isDraft?: unknown; isPrerelease?: unknown; assets?: { name?: unknown; size?: unknown }[] };
  if (!release || typeof release.tagName !== 'string' || !ARCHIVE_TAG.test(release.tagName)
    || release.isDraft !== false || release.isPrerelease !== false || !Array.isArray(release.assets)) throw new WorkerError('invalid-private-release');
  const archive = release.tagName + '.tar.gz', checksum = archive + '.sha256';
  if (release.assets.length !== 2 || release.assets.filter(a => a.name === archive).length !== 1
    || release.assets.filter(a => a.name === checksum).length !== 1
    || release.assets.some(a => typeof a.size !== 'number' || !Number.isSafeInteger(a.size) || a.size <= 0 || a.size > (a.name === archive ? ARCHIVE_LIMIT : 512))) {
    throw new WorkerError('invalid-private-assets');
  }
  return { tag: release.tagName, archive, checksum };
}

async function digestFile(path: string): Promise<string> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ARCHIVE_LIMIT) throw new WorkerError('unsafe-archive-file');
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}

/** The Python standard-library parser interprets PAX/ustar headers, but never extractall().
 * Links, devices, sparse members, traversal, duplicates and undeclared files fail before extraction. */
export async function restoreArchive(archive: string, checksum: string, destination: string): Promise<string> {
  if (!/^catalog-[A-Za-z0-9_-]+\.tar\.gz$/.test(basename(archive)) || basename(checksum) !== basename(archive) + '.sha256') throw new WorkerError('invalid-archive-name');
  const stat = lstatSync(checksum);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) throw new WorkerError('invalid-archive-checksum');
  const declared = readFileSync(checksum, 'utf8').match(/^([a-f0-9]{64})  (catalog-[A-Za-z0-9_-]+\.tar\.gz)\n?$/);
  if (!declared || declared[2] !== basename(archive) || await digestFile(archive) !== declared[1]) throw new WorkerError('archive-checksum-mismatch');
  if (existsSync(destination)) throw new WorkerError('restore-destination-exists');
  mkdirSync(destination, { mode: 0o700 });
  const tag = basename(archive).slice(0, -7), snapshot = join(destination, tag);
  try {
    await runCaptured('python3', ['-c', EXTRACTOR, archive, destination, tag], { timeoutMs: 120_000 });
    if (!verifyBackupSnapshot(snapshot).ok) throw new WorkerError('snapshot-verification-failed');
    return snapshot;
  } catch {
    rmSync(destination, { recursive: true, force: true });
    throw new WorkerError('archive-verification-failed');
  }
}

type Stage = typeof stages[number];
export interface SafeCounts { attempted: number; completed: number; errors: number; review: number }
export type SafeWorkReport = Record<Stage, SafeCounts>;
type Grind = (db: Database.Database, options: GrindOptions) => Promise<GrindSummary>;
/** Explicit scopes exclude legacy global index jobs; all limits are totals across the registry. */
export async function grindSelected(db: Database.Database, registry: readonly SeedSeries[], run: Grind,
  options: { noEnrich: boolean; signal: AbortSignal; now?: () => Date }): Promise<SafeWorkReport> {
  const now = options.now ?? (() => new Date());
  const counts = Object.fromEntries(stages.map(stage => [stage, { attempted: 0, completed: 0, errors: 0, review: 0 }])) as SafeWorkReport;
  if (!registry.length || registry.some(seed => !seed.id || seed.sources.some(source => source.adapter.endsWith('index')))) throw new WorkerError('invalid-selected-registry');
  // Enqueue due work in every approved scope, even if today's attempt budget ends early.
  for (const seed of registry) {
    if (options.signal.aborted) return counts;
    assertWindow(now());
    await run(db, { seriesId: seed.id, refresh: true, limits: { sources: 0, audio: 0, extract: 0, assess: 0 }, signal: options.signal });
  }
  let stopPaid = false;
  for (const stage of stages) {
    if ((stage === 'extract' || stage === 'assess') && (options.noEnrich || stopPaid)) continue;
    for (const seed of registry) {
      if (options.signal.aborted || counts[stage].attempted >= LIMITS[stage]) break;
      assertWindow(now());
      const limits = { sources: 0, audio: 0, extract: 0, assess: 0 };
      limits[stage] = LIMITS[stage] - counts[stage].attempted;
      const result = await run(db, { seriesId: seed.id, enrich: !options.noEnrich, limits, signal: options.signal });
      const item = result.stages[stage];
      for (const key of ['attempted', 'completed', 'errors', 'review'] as const) {
        if (!Number.isSafeInteger(item[key]) || item[key] < 0) throw new WorkerError('invalid-work-summary');
        counts[stage][key] += item[key];
      }
      if (counts[stage].attempted > LIMITS[stage]) throw new WorkerError('work-limit-exceeded');
      if (item.stopReason === 'storage') throw new WorkerError('paid-storage-failed');
      if (['authentication', 'rate-limit', 'configuration', 'paid-stop'].includes(item.stopReason)) {
        if (stage === 'extract' || stage === 'assess') stopPaid = true;
        break;
      }
    }
  }
  return counts;
}

export interface CycleOperations {
  restore(): Promise<void>;
  preflight(): Promise<void>;
  work(): Promise<void>;
  exportPublic(): Promise<void>;
  persist(): Promise<void>;
  publish(): Promise<void>;
}
/** Finally protects paid progress. Export/work failure never skips the private checkpoint. */
export async function runWorkerCycle(operations: CycleOperations, now = () => new Date()): Promise<void> {
  assertWindow(now(), RUN_MS);
  await operations.restore();
  assertWindow(now());
  await operations.preflight();
  let failed = false;
  try {
    assertWindow(now()); await operations.work();
    assertWindow(now()); await operations.exportPublic();
  } catch { failed = true; }
  finally {
    assertWindow(now());
    try { await operations.persist(); } catch { throw new WorkerError('private-checkpoint-failed'); }
  }
  if (failed) throw new WorkerError('work-or-export-failed');
  assertWindow(now());
  await operations.publish();
}

function privateEnvironment(base: NodeJS.ProcessEnv, token: string, config: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GH_TOKEN: token, GH_CONFIG_DIR: config };
  delete env.GITHUB_TOKEN; delete env.CATALOG_DATA_TOKEN;
  delete env.OPENAI_API_KEY; delete env.TYPESAFE_API_KEY;
  return env;
}
function publicEnvironment(base: NodeJS.ProcessEnv, config: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GH_TOKEN: base.GITHUB_TOKEN, GH_CONFIG_DIR: config };
  delete env.CATALOG_DATA_TOKEN; delete env.OPENAI_API_KEY; delete env.TYPESAFE_API_KEY;
  return env;
}
function requireRuntime(env: NodeJS.ProcessEnv): void {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== PUBLIC_REPOSITORY || env.GITHUB_REF !== 'refs/heads/main'
    || !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')) throw new WorkerError('unsupported-runtime');
}
function publicPaths(raw: string): string[] {
  const paths = raw.split('\0').filter(Boolean);
  if (paths.some(path => !PUBLIC_FILE.test(path))) throw new WorkerError('unsafe-public-path');
  return paths;
}
export function assertPublicPaths(paths: string[]): void {
  if (paths.some(path => !PUBLIC_FILE.test(path)) || new Set(paths).size !== paths.length) throw new WorkerError('unsafe-public-path');
}

async function workChild(noEnrich: boolean): Promise<void> {
  requireRuntime(process.env); assertWindow();
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const timer = setTimeout(stop, WORK_MS); timer.unref();
  const { getDb, closeDb } = await import('../db.js');
  try {
    const { runMigrations } = await import('../migrate.js');
    const { seeds, seedCatalog, processSource } = await import('../catalog/pipeline.js');
    const { runCatalogGrind } = await import('../catalog/grind.js');
    const { ReviewError } = await import('../catalog/types.js');
    runMigrations();
    const db = getDb();
    seedCatalog(db, seeds, { includeIndexes: false });
    // Favor the scope whose existing source jobs have been untouched longest, with a stable tie break.
    const last = db.prepare("SELECT MAX(updated_at) AS stamp FROM catalog_jobs WHERE kind='source' AND json_extract(payload_json,'$.seriesId')=?");
    const registry = [...seeds].sort((a, b) => {
      const left = (last.get(a.id) as { stamp: string | null }).stamp ?? '';
      const right = (last.get(b.id) as { stamp: string | null }).stamp ?? '';
      return left.localeCompare(right) || a.id.localeCompare(b.id);
    });
    const report = await grindSelected(db, registry, (database, options) => runCatalogGrind(database, options, {
      registry,
      source: (database, payload) => {
        if (!payload.seriesId || payload.adapter.endsWith('index')) throw new ReviewError('Unscoped discovery is disabled in recurring automation.');
        return processSource(database, payload, registry);
      }
    }), { noEnrich, signal: controller.signal });
    const target = process.env.CATALOG_WORK_RESULT;
    if (!target) throw new WorkerError('missing-work-report');
    writeFileSync(target, JSON.stringify(report), { mode: 0o600, flag: 'wx' });
  } finally { clearTimeout(timer); closeDb(); }
}

async function main(noEnrich: boolean): Promise<void> {
  requireRuntime(process.env);
  assertWindow(new Date(), RUN_MS);
  // Never fall back to gh's local OAuth login, including for manual verification.
  const token = process.env.CATALOG_DATA_TOKEN;
  if (!token || !process.env.GITHUB_TOKEN) throw new WorkerError('missing-automation-token');
  if (!noEnrich && (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_API_KEY)) throw new WorkerError('missing-enrichment-key');
  process.umask(0o077);
  const cwd = resolve(import.meta.dirname, '../../..');
  const root = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'catalog-worker-'));
  const config = join(root, 'gh'); mkdirSync(config);
  const privateEnv = privateEnvironment(process.env, token, config), publicEnv = publicEnvironment(process.env, config);
  const started = Date.now(), deadline = started + RUN_MS;
  const interrupted = new AbortController(), stop = () => interrupted.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const command = async (cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000, signal?: AbortSignal) => {
    assertWindow();
    const remaining = deadline - Date.now();
    if (remaining <= 75_000) throw new WorkerError('run-deadline');
    return runCaptured(cmd, args, { cwd, env, timeoutMs: Math.min(timeoutMs, remaining - 75_000), signal });
  };
  const gh = (args: string[], env = privateEnv, timeout = 60_000) => command('gh', args, env, timeout);
  const requirePrivate = async () => {
    const info = JSON.parse(await gh(['repo', 'view', DATA_REPOSITORY, '--json', 'isPrivate']));
    if (info.isPrivate !== true) throw new WorkerError('data-repository-not-private');
  };
  const latest = async () => selectArchive(JSON.parse(await gh(['release', 'view', '--repo', DATA_REPOSITORY, '--json', 'tagName,isDraft,isPrerelease,assets'])));
  const runId = process.env.GITHUB_RUN_ID ?? '', attempt = process.env.GITHUB_RUN_ATTEMPT ?? '';
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(attempt)) throw new WorkerError('invalid-run-identity');
  const tag = 'catalog-actions-' + runId + '-' + attempt + '-' + new Date().toISOString().replace(/[:.]/g, '-');
  let baseTag = '', snapshot = '', counts: SafeWorkReport | null = null, committed = false;
  const workEnv = { ...process.env };
  delete workEnv.CATALOG_DATA_TOKEN; delete workEnv.GH_TOKEN; delete workEnv.GITHUB_TOKEN;
  const script = resolve(import.meta.dirname, 'worker.ts');
  const cycle = runWorkerCycle({
    restore: async () => {
      await requirePrivate();
      const release = await latest(); baseTag = release.tag;
      const downloads = join(root, 'downloads'); mkdirSync(downloads);
      await gh(['release', 'download', baseTag, '--repo', DATA_REPOSITORY, '--pattern', release.archive, '--pattern', release.checksum, '--dir', downloads], privateEnv, 180_000);
      snapshot = await restoreArchive(join(downloads, release.archive), join(downloads, release.checksum), join(root, 'restored'));
      const dbPath = join(snapshot, 'books.db'), assets = join(snapshot, 'covers');
      // These are private runner-local files, never the repository's tracked export directory.
      process.env.CATALOG_DB_PATH = dbPath; process.env.CATALOG_ASSET_DIR = assets;
      workEnv.CATALOG_DB_PATH = dbPath; workEnv.CATALOG_ASSET_DIR = assets;
      workEnv.CATALOG_WORK_RESULT = join(root, 'work-result.json');
    },
    preflight: async () => {
      if (interrupted.signal.aborted) throw new WorkerError('interrupted-before-work');
      await requirePrivate();
      await gh(['release', 'create', tag, '--repo', DATA_REPOSITORY, '--draft', '--title', 'Catalog automated checkpoint',
        '--notes', 'Private catalog checkpoint. Retained source evidence and paid responses must not be published as raw artifacts.']);
    },
    work: async () => {
      await command(process.execPath, ['--import', 'tsx', script, '--work', ...(noEnrich ? ['--no-enrich'] : [])], workEnv, Math.max(1, WORK_MS - (Date.now() - started)), interrupted.signal);
      const report = JSON.parse(readFileSync(workEnv.CATALOG_WORK_RESULT!, 'utf8'));
      for (const stage of stages) for (const field of ['attempted', 'completed', 'errors', 'review']) {
        if (!Number.isSafeInteger(report?.[stage]?.[field]) || report[stage][field] < 0 || report[stage][field] > LIMITS[stage]) throw new WorkerError('invalid-work-report');
      }
      counts = report;
    },
    exportPublic: async () => {
      for (const file of ['json.ts', 'health.ts']) {
        await command(process.execPath, ['--import', 'tsx', join(cwd, 'scripts/backend/exporters', file)], workEnv, 90_000, interrupted.signal);
      }
    },
    persist: async () => {
      await requirePrivate();
      const { getDb, closeDb } = await import('../db.js');
      const { archiveCurrentSources } = await import('../storage/history.js');
      const { backupCatalog } = await import('../storage/backup.js');
      const { packSnapshot } = await import('../storage/archive.js');
      let backup: string;
      try {
        const db = getDb(); archiveCurrentSources(db);
        backup = await backupCatalog(db, join(root, 'backups'), process.env.CATALOG_ASSET_DIR);
      } finally { closeDb(); }
      const target = join(root, 'backups', tag); renameSync(backup, target);
      if (!verifyBackupSnapshot(target).ok) throw new WorkerError('checkpoint-verification-failed');
      const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')) as { files: { path: string }[] };
      const credentials = Object.entries(process.env).filter(([name, value]) => /TOKEN|SECRET|API_KEY|PASSWORD/.test(name) && value && value.length > 12).map(([, value]) => Buffer.from(value!));
      for (const file of manifest.files) {
        const bytes = readFileSync(join(target, file.path));
        if (credentials.some(credential => bytes.includes(credential))) throw new WorkerError('checkpoint-credential-check-failed');
      }
      const archive = target + '.tar.gz'; packSnapshot(target, manifest.files, archive);
      const checksum = archive + '.sha256';
      writeFileSync(checksum, await digestFile(archive) + '  ' + basename(archive) + '\n', { mode: 0o600 });
      await requirePrivate();
      await gh(['release', 'upload', tag, archive, checksum, '--repo', DATA_REPOSITORY], privateEnv, 180_000);
      // Preserve an overlapping writer's newer latest snapshot; this run's draft still holds its paid progress.
      if ((await latest()).tag !== baseTag) throw new WorkerError('private-head-changed');
      await requirePrivate();
      await gh(['release', 'edit', tag, '--repo', DATA_REPOSITORY, '--draft=false', '--latest']);
    },
    publish: async () => {
      if (interrupted.signal.aborted) throw new WorkerError('interrupted-after-checkpoint');
      const git = (args: string[], env = publicEnv) => command('git', args, env);
      if ((await git(['diff', '--cached', '--name-only', '-z'])).length) throw new WorkerError('preexisting-staged-files');
      const tracked = publicPaths(await git(['ls-files', '-z', '--', 'static/data']));
      const actual = readdirSync(join(cwd, 'static/data')).map(name => 'static/data/' + name);
      assertPublicPaths(actual);
      for (const path of actual) {
        const stat = lstatSync(join(cwd, path));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new WorkerError('unsafe-public-file');
        JSON.parse(readFileSync(join(cwd, path), 'utf8'));
      }
      const paths = [...new Set([...tracked, ...actual])];
      assertPublicPaths(paths);
      await git(['add', '--all', '--', ...paths]);
      const changed = publicPaths(await git(['diff', '--cached', '--name-only', '-z']));
      if (!changed.length) return;
      const authorEnv = { ...publicEnv, GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_COMMITTER_NAME: 'github-actions[bot]',
        GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com', GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com' };
      await git(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Refresh public catalog data'], authorEnv);
      const pushEnv = { ...publicEnv, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + process.env.GITHUB_TOKEN).toString('base64') };
      await git(['push', 'origin', 'HEAD:main'], pushEnv);
      committed = true;
      await gh(['workflow', 'run', 'deploy.yml', '--repo', PUBLIC_REPOSITORY, '--ref', 'main'], publicEnv);
    }
  });
  try { await cycle; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  // Only bounded numeric summaries and booleans are printed. No release URLs, source bodies or child logs.
  console.log(JSON.stringify({ ok: true, privateCheckpoint: true, publicCommit: committed, noEnrich, stages: counts }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { work: { type: 'boolean' }, 'no-enrich': { type: 'boolean' } } });
    const noEnrich = values['no-enrich'] === true || process.env.CATALOG_NO_ENRICH === 'true';
    if (values.work) await workChild(noEnrich); else await main(noEnrich);
  } catch (error) {
    console.error(error instanceof WorkerError ? error.message : 'Catalog automation failed; private details are not logged.');
    process.exitCode = 1;
  }
}
