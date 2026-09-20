import { appendFileSync, closeSync, openSync, readSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'iamnbutler/shelfgoblin';
const SHA = /^[a-f0-9]{40}(?![\s\S])/;
const PUBLIC_NAMES = new Set(['catalog.json', 'series.json', 'review.json', 'meta.json', 'health.json']);

/** @param {string} path */
export function isPublicCatalogPath(path) {
  const parts = path.split('/');
  return parts.length === 3 && parts[0] === 'static' && parts[1] === 'data'
    && (PUBLIC_NAMES.has(parts[2]) || /^\d{4}\.json(?![\s\S])/.test(parts[2]));
}

/** Only the worker's final, bounded receipt is interpreted; private log text is never echoed.
 * @param {string} tail
 */
export function parseWorkerResult(tail) {
  try {
    const value = JSON.parse(tail.trimEnd().split('\n').at(-1) ?? '');
    if (value?.ok !== true || value?.privateCheckpoint !== true || typeof value?.publicCommit !== 'boolean') throw new Error();
    return { publicCommit: value.publicCommit };
  } catch {
    throw new Error('Catalog completion receipt is missing or invalid. Deployment stopped.');
  }
}

/** @param {{ publicCommit: boolean; baseSha: string; headSha: string; parentShas: string[]; changedPaths: string[]; workingTree: string; remoteSha: string }} state */
export function validatePublication(state) {
  if (!SHA.test(state.baseSha) || !SHA.test(state.headSha) || state.workingTree !== '') throw new Error('Catalog checkout is not a clean, identified commit.');
  if (!state.publicCommit) {
    if (state.headSha !== state.baseSha) throw new Error('Catalog receipt and checkout disagree.');
    return { published: false, sha: '' };
  }
  if (state.headSha === state.baseSha || state.parentShas.length !== 1 || state.parentShas[0] !== state.baseSha
    || state.changedPaths.length === 0 || !state.changedPaths.every(isPublicCatalogPath)
    || state.remoteSha !== state.headSha) throw new Error('Catalog publication could not be verified. Deployment stopped.');
  return { published: true, sha: state.headSha };
}

/** The deployment has its own fresh reserve, including after installation/build delays.
 * @param {Date} now
 * @param {Record<string, string | undefined>} env
 * @param {number} reserveMinutes
 */
export function deploymentAllowed(now, env, reserveMinutes = 5) {
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(reserveMinutes) || reserveMinutes <= 0
    || env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REF !== 'refs/heads/main'
    || !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')) return false;
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.CATALOG_ALLOW_OUTSIDE_WINDOW === 'true') return true;
  const end = new Date(now);
  end.setUTCHours(22, 0, 0, 0);
  return now.getUTCHours() >= 2 && now.getTime() + reserveMinutes * 60_000 <= end.getTime();
}

/** @param {string} file */
function logTail(file) {
  const size = statSync(file).size;
  const buffer = Buffer.alloc(Math.min(size, 8192));
  const fd = openSync(file, 'r');
  try { readSync(fd, buffer, 0, buffer.length, size - buffer.length); }
  finally { closeSync(fd); }
  return buffer.toString('utf8');
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
}

/** @param {string} cwd */
function checkOrigin(cwd) {
  const origin = git(cwd, ['remote', 'get-url', 'origin']).trim();
  if (![`https://github.com/${REPOSITORY}`, `https://github.com/${REPOSITORY}.git`, `git@github.com:${REPOSITORY}.git`].includes(origin)) throw new Error('Unexpected app repository.');
}

/** @param {string} cwd */
function remoteMain(cwd) {
  const result = git(cwd, ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).trim().split('\t');
  if (result.length !== 2 || !SHA.test(result[0]) || result[1] !== 'refs/heads/main') throw new Error('Cannot verify published main.');
  return result[0];
}

/** @param {string} text */
function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
}

/** @param {string | undefined} mode */
function main(mode) {
  const cwd = resolve(process.env.CATALOG_APP_ROOT ?? '.');
  checkOrigin(cwd);
  if (mode === 'receipt') {
    if (!process.env.CATALOG_REFRESH_LOG || !process.env.GITHUB_OUTPUT) throw new Error('Missing completion receipt paths.');
    const receipt = parseWorkerResult(logTail(process.env.CATALOG_REFRESH_LOG));
    const headSha = git(cwd, ['rev-parse', 'HEAD']).trim();
    const baseSha = process.env.CATALOG_BASE_SHA ?? '';
    const result = validatePublication({ ...receipt, baseSha, headSha,
      workingTree: git(cwd, ['status', '--porcelain']),
      parentShas: git(cwd, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').slice(1),
      changedPaths: receipt.publicCommit ? git(cwd, ['diff', '--name-only', '-z', baseSha, headSha]).split('\0').filter(Boolean) : [],
      remoteSha: receipt.publicCommit ? remoteMain(cwd) : '' });
    appendFileSync(process.env.GITHUB_OUTPUT, `published=${result.published}\nsha=${result.sha}\n`);
    summary(result.published
      ? `Private checkpoint confirmed; public catalog commit verified: [${result.sha}](https://github.com/${REPOSITORY}/commit/${result.sha}). Cloudflare deployment is pending its separate checks.`
      : 'Private checkpoint confirmed. Public catalog unchanged; no deployment needed.');
    console.log(result.published ? 'Private checkpoint and public catalog commit verified.' : 'Private checkpoint verified; public catalog unchanged.');
  } else if (mode === 'guard') {
    if (!deploymentAllowed(new Date(), process.env)) throw new Error('Outside deployment window.');
    const sha = process.env.CATALOG_DEPLOY_SHA ?? '';
    if (!SHA.test(sha) || git(cwd, ['rev-parse', 'HEAD']).trim() !== sha
      || git(cwd, ['status', '--porcelain']) !== '' || remoteMain(cwd) !== sha) throw new Error('Deployment commit is no longer current.');
    if (!deploymentAllowed(new Date(), process.env)) throw new Error('Outside deployment window.');
    console.log('Exact published commit and five-minute deployment window verified.');
  } else throw new Error('Unknown deployment check.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv[2]); }
  catch {
    // Even a malformed private receipt or a git failure must not disclose its input/error body.
    console.error('Catalog deployment checks failed. No deployment was authorized; inspect the checkpoint, public commit, and UTC window.');
    summary('Cloudflare deployment stopped before authorization: completion receipt, public commit, checkout state, or UTC window could not be verified.');
    process.exitCode = 1;
  }
}
