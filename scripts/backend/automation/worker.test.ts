import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicPaths, assertWindow, grindSelected, LIMITS, restoreArchive, runCaptured, runWorkerCycle, selectArchive } from './worker.js';
import type { CycleOperations } from './worker.js';
import type { GrindOptions, GrindSummary } from '../catalog/grind.js';
import type { SeedSeries } from '../catalog/types.js';
import { backupCatalog } from '../storage/backup.js';
import { packSnapshot } from '../storage/archive.js';

const temporary: string[] = [];
const fresh = () => { const path = mkdtempSync(join(tmpdir(), 'catalog-automation-test-')); temporary.push(path); return path; };
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
interface Member { name: string; data?: Buffer; type?: string; size?: number; link?: string }
/** Synthetic ustar only; no retained catalog source or review body is a fixture. */
function tar(members: Member[]): Buffer {
  const chunks: Buffer[] = [];
  for (const member of members) {
    const data = member.data ?? Buffer.alloc(0), header = Buffer.alloc(512);
    header.write(member.name, 0, 100);
    for (const [offset, size, value] of [[100, 8, 0o600], [108, 8, 0], [116, 8, 0], [124, 12, member.size ?? data.length], [136, 12, 0]] as const) {
      header.write(value.toString(8).padStart(size - 1, '0') + '\0', offset, size);
    }
    header.fill(32, 148, 156); header.write(member.type ?? '0', 156, 1);
    if (member.link) header.write(member.link, 157, 100);
    header.write('ustar\0', 257, 6); header.write('00', 263, 2);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
function fixture() {
  const root = fresh(), tag = 'catalog-fixture', path = join(root, 'fixture.db'), db = new Database(path);
  db.exec('CREATE TABLE books(id TEXT PRIMARY KEY); INSERT INTO books VALUES(\'fixture-book\')'); db.close();
  const database = readFileSync(path), cover = Buffer.from('synthetic cover bytes'), coverPath = 'covers/' + sha(cover) + '.jpg';
  const manifest = { version: 1, createdAt: '2026-09-19T08:17:00.000Z', books: 1,
    files: [{ path: 'books.db', bytes: database.length, sha256: sha(database) }, { path: coverPath, bytes: cover.length, sha256: sha(cover) }] };
  const members: Member[] = [{ name: tag + '/manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: tag + '/books.db', data: database }, { name: tag + '/' + coverPath, data: cover }];
  const save = (entries = members) => {
    const archive = join(root, tag + '.tar.gz'), bytes = gzipSync(tar(entries)), checksum = archive + '.sha256';
    writeFileSync(archive, bytes); writeFileSync(checksum, sha(bytes) + '  ' + tag + '.tar.gz\n');
    return { archive, checksum, destination: join(root, 'restored') };
  };
  return { root, tag, manifest, members, database, cover, coverPath, save };
}

describe('private archive selection and safe restore', () => {
  it('accepts one current archive/checksum pair and rejects draft, ambiguous and unsafe releases', () => {
    const release = { tagName: 'catalog-fixture', isDraft: false, isPrerelease: false,
      assets: [{ name: 'catalog-fixture.tar.gz', size: 123 }, { name: 'catalog-fixture.tar.gz.sha256', size: 96 }] };
    expect(selectArchive(release).tag).toBe('catalog-fixture');
    for (const value of [{ ...release, isDraft: true }, { ...release, tagName: '../unsafe' },
      { ...release, assets: [...release.assets, { name: 'unexpected', size: 1 }] }, { ...release, assets: release.assets.slice(0, 1) }]) {
      expect(() => selectArchive(value)).toThrow(/invalid-private/);
    }
  });
  it('verifies checksums, SQLite and the closed layout without adding journal files', async () => {
    const f = fixture(), input = f.save(), snapshot = await restoreArchive(input.archive, input.checksum, input.destination);
    expect(readFileSync(join(snapshot, 'books.db'))).toEqual(f.database);
    expect(readFileSync(join(snapshot, f.coverPath))).toEqual(f.cover);
    expect(readdirSync(snapshot).sort()).toEqual(['books.db', 'covers', 'manifest.json']);
  });
  it('round-trips the actual backup/pack format, including long content-addressed cover paths', async () => {
    const root = fresh(), db = new Database(join(root, 'source.db')), assets = join(root, 'covers'); mkdirSync(assets);
    db.pragma('journal_mode=WAL'); db.exec('CREATE TABLE books(id TEXT PRIMARY KEY); INSERT INTO books VALUES(\'fixture\')');
    const cover = Buffer.from('fixture asset'); writeFileSync(join(assets, sha(cover) + '.jpg'), cover);
    let snapshot: string;
    try { snapshot = await backupCatalog(db, join(root, 'backups'), assets); } finally { db.close(); }
    const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'));
    packSnapshot(snapshot, manifest.files);
    const archive = snapshot + '.tar.gz', checksum = archive + '.sha256', name = archive.split('/').at(-1)!;
    writeFileSync(checksum, sha(readFileSync(archive)) + '  ' + name + '\n');
    await expect(restoreArchive(archive, checksum, join(root, 'restored'))).resolves.toContain('catalog-');
  });
  it('interprets PAX paths but rejects a PAX traversal', async () => {
    for (const safe of [true, false]) {
      const f = fixture(), text = 'path=' + (safe ? f.tag + '/books.db' : '../escaped.db') + '\n';
      let length = text.length + 3;
      while (String(length).length + text.length + 1 !== length) length = String(length).length + text.length + 1;
      const pax: Member = { name: 'PaxHeaders/entry', type: 'x', data: Buffer.from(String(length) + ' ' + text) };
      const input = f.save([f.members[0], pax, { ...f.members[1], name: 'placeholder' }, f.members[2]]);
      if (safe) await expect(restoreArchive(input.archive, input.checksum, input.destination)).resolves.toContain(f.tag);
      else await expect(restoreArchive(input.archive, input.checksum, input.destination)).rejects.toThrow(/archive-verification/);
      expect(existsSync(join(f.root, 'escaped.db'))).toBe(false);
    }
  });
  it.each(['../escaped.db', '/tmp/escaped.db', 'catalog-fixture/../../escaped.db',
    'catalog-fixture/covers\\escaped.jpg', 'other-root/books.db', 'catalog-fixture/books.db-wal',
    'catalog-fixture/private-notes.txt', 'catalog-fixture/covers/' + 'a'.repeat(64) + '.jpg'])('rejects unsafe or undeclared member %s', async name => {
    const f = fixture(), input = f.save([...f.members, { name, data: Buffer.from('private fixture') }]);
    await expect(restoreArchive(input.archive, input.checksum, input.destination)).rejects.toThrow(/archive-verification/);
    expect(existsSync(input.destination)).toBe(false);
  });
  it.each(['1', '2', '3', '4', '6', 'S'])('rejects link/device/sparse type %s', async type => {
    const f = fixture(), input = f.save([f.members[0], { name: f.tag + '/books.db', type, link: '../../outside' }, f.members[2]]);
    await expect(restoreArchive(input.archive, input.checksum, input.destination)).rejects.toThrow(/archive-verification/);
    expect(existsSync(join(f.root, 'outside'))).toBe(false);
  });
  it('rejects duplicate/missing entries and oversized declared bodies', async () => {
    for (const variant of ['duplicate', 'missing', 'oversize']) {
      const f = fixture(), entries = variant === 'duplicate' ? [...f.members, f.members[1]] : variant === 'missing'
        ? f.members.slice(0, 2) : [f.members[0], { ...f.members[1], size: 3 * 1024 ** 3 + 1, data: Buffer.alloc(0) }];
      const input = f.save(entries);
      await expect(restoreArchive(input.archive, input.checksum, input.destination)).rejects.toThrow(/archive-verification/);
    }
  });
  it('rejects manifest traversal and internal checksum mismatch despite a valid outer checksum', async () => {
    for (const traversal of [true, false]) {
      const f = fixture(); f.manifest.files[0].path = traversal ? '../books.db' : 'books.db';
      if (!traversal) f.manifest.files[0].sha256 = '0'.repeat(64);
      const input = f.save([{ ...f.members[0], data: Buffer.from(JSON.stringify(f.manifest)) }, ...f.members.slice(1)]);
      await expect(restoreArchive(input.archive, input.checksum, input.destination)).rejects.toThrow(/archive-verification/);
    }
  });
  it('rejects orphan foreign keys before opening the restored catalog for work', async () => {
    const f = fixture(), path = join(f.root, 'orphan.db'), db = new Database(path);
    db.pragma('foreign_keys=OFF');
    db.exec('CREATE TABLE books(id TEXT PRIMARY KEY); CREATE TABLE children(parent TEXT REFERENCES books(id)); INSERT INTO books VALUES(\'fixture\'); INSERT INTO children VALUES(\'missing\')'); db.close();
    const bytes = readFileSync(path); f.manifest.files[0] = { path: 'books.db', bytes: bytes.length, sha256: sha(bytes) };
    const input = f.save([{ ...f.members[0], data: Buffer.from(JSON.stringify(f.manifest)) }, { ...f.members[1], data: bytes }, f.members[2]]);
    await expect(restoreArchive(input.archive, input.checksum, input.destination)).rejects.toThrow(/archive-verification/);
  });
  it('rejects changed outer checksums, symlink archive files and existing destinations', async () => {
    const f = fixture(), input = f.save();
    writeFileSync(input.checksum, '0'.repeat(64) + '  ' + f.tag + '.tar.gz\n');
    await expect(restoreArchive(input.archive, input.checksum, input.destination)).rejects.toThrow(/checksum/);
    f.save(); const bytes = readFileSync(input.archive); rmSync(input.archive);
    writeFileSync(input.archive + '.target', bytes); symlinkSync(input.archive + '.target', input.archive);
    await expect(restoreArchive(input.archive, input.checksum, input.destination)).rejects.toThrow(/unsafe-archive/);
    rmSync(input.archive); f.save(); mkdirSync(input.destination); writeFileSync(join(input.destination, 'keep'), 'keep');
    await expect(restoreArchive(input.archive, input.checksum, input.destination)).rejects.toThrow(/destination-exists/);
    expect(readFileSync(join(input.destination, 'keep'), 'utf8')).toBe('keep');
  });
});

describe('bounded recurring work and publication', () => {
  const now = () => new Date('2026-09-19T08:17:00.000Z');
  function operations(fail?: keyof CycleOperations) {
    const calls: string[] = [];
    const hooks = Object.fromEntries(['restore', 'preflight', 'work', 'exportPublic', 'persist', 'publish'].map(name =>
      [name, async () => { calls.push(name); if (name === fail) throw new Error('private fixture detail'); }])) as unknown as CycleOperations;
    return { calls, hooks };
  }
  it('enforces the UTC blackout and the cleanup reserve', () => {
    for (const at of ['01:59:59', '22:00:00', '23:59:59']) expect(() => assertWindow(new Date('2026-09-19T' + at + 'Z'))).toThrow(/window/);
    for (const at of ['02:00:00', '08:17:00']) expect(() => assertWindow(new Date('2026-09-19T' + at + 'Z'))).not.toThrow();
    expect(() => assertWindow(new Date('2026-09-19T21:50:00Z'), 27 * 60_000)).toThrow(/window/);
  });
  it('proves private writes before paid work and persists before publication', async () => {
    const f = operations(); await runWorkerCycle(f.hooks, now);
    expect(f.calls).toEqual(['restore', 'preflight', 'work', 'exportPublic', 'persist', 'publish']);
  });
  it.each(['work', 'exportPublic'] as const)('persists partial work after %s failure without public commit', async fail => {
    const f = operations(fail); await expect(runWorkerCycle(f.hooks, now)).rejects.toThrow(/work-or-export/);
    expect(f.calls).toContain('persist'); expect(f.calls).not.toContain('publish');
  });
  it('does not publish after a failed private checkpoint/head check', async () => {
    const f = operations('persist'); await expect(runWorkerCycle(f.hooks, now)).rejects.toThrow(/private-checkpoint/);
    expect(f.calls).not.toContain('publish');
  });
  it.each(['restore', 'preflight'] as const)('does no paid work when %s fails', async fail => {
    const f = operations(fail); await expect(runWorkerCycle(f.hooks, now)).rejects.toThrow();
    expect(f.calls).not.toContain('work'); expect(f.calls).not.toContain('publish');
  });
  it('does not even restore during the blackout', async () => {
    const f = operations(); await expect(runWorkerCycle(f.hooks, () => new Date('2026-09-19T23:00:00Z'))).rejects.toThrow(/window/);
    expect(f.calls).toEqual([]);
  });
  const registry = Array.from({ length: 6 }, (_, i) => ({ id: 'selected-' + i, sources: [] } as unknown as SeedSeries));
  function fakeGrind(stopPaid = false) {
    return vi.fn(async (_db: Database.Database, options: GrindOptions) => ({
      stages: Object.fromEntries(Object.entries(options.limits!).map(([stage, limit]) => {
        const attempted = Math.min(limit!, 7);
        return [stage, { attempted, completed: attempted, errors: 0, review: 0, stopReason: stopPaid && stage === 'extract' && attempted ? 'authentication' : 'limit' }];
      }))
    } as GrindSummary));
  }
  it('caps attempts across explicit scopes, never an unscoped discovery run', async () => {
    const run = fakeGrind(), result = await grindSelected({} as Database.Database, registry, run, { noEnrich: false, signal: new AbortController().signal, now });
    expect(Object.fromEntries(Object.entries(result).map(([stage, value]) => [stage, value.attempted]))).toEqual(LIMITS);
    expect(run.mock.calls.every(([, options]) => registry.some(seed => seed.id === options.seriesId))).toBe(true);
    expect(run.mock.calls.filter(([, options]) => options.refresh)).toHaveLength(registry.length);
  });
  it('no-enrich mode makes no paid-stage planning or work calls', async () => {
    const run = fakeGrind(), result = await grindSelected({} as Database.Database, registry, run, { noEnrich: true, signal: new AbortController().signal, now });
    expect(result.extract.attempted + result.assess.attempted).toBe(0);
    expect(run.mock.calls.every(([, options]) => !options.enrich && !options.limits?.extract && !options.limits?.assess)).toBe(true);
  });
  it('stops all remaining paid work after an authentication/rate/configuration stop', async () => {
    const run = fakeGrind(true), result = await grindSelected({} as Database.Database, registry, run, { noEnrich: false, signal: new AbortController().signal, now });
    expect(result.extract.attempted).toBe(7); expect(result.assess.attempted).toBe(0);
  });
  it('rejects broad-index sources and respects an already aborted signal', async () => {
    const run = fakeGrind();
    await expect(grindSelected({} as Database.Database, [{ id: 'unsafe', sources: [{ adapter: 'aethon-index' }] } as unknown as SeedSeries], run,
      { noEnrich: true, signal: new AbortController().signal, now })).rejects.toThrow(/registry/);
    const controller = new AbortController(); controller.abort();
    await grindSelected({} as Database.Database, registry, run, { noEnrich: false, signal: controller.signal, now });
    expect(run).not.toHaveBeenCalled();
  });
  it('allows only the named public JSON export files', () => {
    expect(() => assertPublicPaths(['static/data/catalog.json', 'static/data/health.json', 'static/data/2026.json'])).not.toThrow();
    for (const path of ['data/books.db', 'static/data/raw.json', 'static/data/../books.db', 'static/data/catalog.json\n.env', 'static/data/.env']) {
      expect(() => assertPublicPaths([path])).toThrow(/unsafe-public-path/);
    }
  });
  it('captures child logs and emits only generic failures', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runCaptured(process.execPath, ['-e', 'process.stdout.write("PRIVATE_FIXTURE");process.stderr.write("SECRET_FIXTURE");process.exit(1)']))
        .rejects.toThrow('Catalog automation stopped (command-failed). Private details are not logged.');
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('does not start a child for an already interrupted request', async () => {
    const root = fresh(), target = join(root, 'must-not-exist'), controller = new AbortController();
    controller.abort();
    await expect(runCaptured(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1],"fixture")', target], { signal: controller.signal }))
      .rejects.toThrow(/interrupted/);
    expect(existsSync(target)).toBe(false);
  });
  it('allows the active child to save before reporting an interrupt', async () => {
    const root = fresh(), ready = join(root, 'ready'), saved = join(root, 'saved'), controller = new AbortController();
    const command = runCaptured(process.execPath, ['-e', 'const fs=require("node:fs");process.on("SIGINT",()=>{fs.writeFileSync(process.argv[2],"saved");process.exit(0)});fs.writeFileSync(process.argv[1],"ready");setInterval(()=>{},1000)', ready, saved], { signal: controller.signal });
    const result = expect(command).rejects.toThrow(/command-failed/);
    for (let tries = 0; tries < 100 && !existsSync(ready); tries++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(ready)).toBe(true); controller.abort(); await result;
    expect(readFileSync(saved, 'utf8')).toBe('saved');
  });
  it('gates every checkout/install/run step after the early neutral UTC check', () => {
    const workflow = readFileSync(new URL('../../../.github/workflows/catalog-refresh.yml', import.meta.url), 'utf8');
    expect(workflow.indexOf('id: window')).toBeLessThan(workflow.indexOf('actions/checkout'));
    expect(workflow.match(/if: steps\.window\.outputs\.allowed == 'true'/g)).toHaveLength(4);
    expect(workflow).toContain("cron: '17 8 * * *'");
    expect(workflow).toContain('datetime.timedelta(minutes=27)');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toMatch(/pull_request:|upload-artifact@/);
    expect(workflow).toContain('CATALOG_OPENAI_MODEL: gpt-5.6-terra');
    expect(workflow).toContain('JEV_MODEL: jev-latest');
    expect(workflow).toContain('COVER_MODEL: gpt-4.1-mini');
  });
});
