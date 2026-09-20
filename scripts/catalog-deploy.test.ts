import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deploymentAllowed, isPublicCatalogPath, parseWorkerResult, validatePublication } from './catalog-deploy.mjs';

const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40);
const trusted = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'iamnbutler/shelfgoblin', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'schedule' };
const publication = { publicCommit: true, baseSha, headSha, parentShas: [baseSha], changedPaths: ['static/data/catalog.json'], workingTree: '', remoteSha: headSha };
const temporary: string[] = [];
function directory() { const value = mkdtempSync(join(tmpdir(), 'catalog-deploy-')); temporary.push(value); return value; }
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('catalog publication handoff', () => {
  it('only returns the sanitized final completion flag, ignoring preceding private output', () => {
    expect(parseWorkerResult('PRIVATE SOURCE BODY\n' + JSON.stringify({ ok: true, privateCheckpoint: true, publicCommit: true, privateDetail: 'never return this' }) + '\n'))
      .toEqual({ publicCommit: true });
  });
  it.each(['', 'PRIVATE BODY', '{}', 'null', '{"ok":true,"privateCheckpoint":false,"publicCommit":true}', '{"ok":true,"privateCheckpoint":true,"publicCommit":"true"}', '{"ok":false,"privateCheckpoint":true,"publicCommit":true}', '{"ok":true,"privateCheckpoint":true,"publicCommit":true}\nPRIVATE FAILURE'])
    ('refuses an incomplete, failed, or superseded worker receipt: %s', text => {
      expect(() => parseWorkerResult(text)).toThrow('completion receipt');
    });
  it('hands off the exact single public catalog commit only after remote publication', () => {
    expect(validatePublication(publication)).toEqual({ published: true, sha: headSha });
  });
  it.each([
    { remoteSha: 'c'.repeat(40) }, { parentShas: ['c'.repeat(40)] }, { parentShas: [baseSha, 'c'.repeat(40)] },
    { headSha: baseSha }, { workingTree: ' M static/data/catalog.json\n' }, { changedPaths: [] },
    { changedPaths: ['static/data/catalog.json', 'workers/accounts.ts'] }, { headSha: headSha + '\n' }
  ])('refuses stale, dirty, non-catalog, and unrelated commits: %j', change => {
    expect(() => validatePublication({ ...publication, ...change })).toThrow();
  });
  it('does not deploy an unchanged checkout', () => {
    expect(validatePublication({ ...publication, publicCommit: false, headSha: baseSha })).toEqual({ published: false, sha: '' });
    expect(() => validatePublication({ ...publication, publicCommit: false })).toThrow('disagree');
  });
  it.each(['static/data/catalog.json', 'static/data/2026.json', 'static/data/health.json'])('accepts a public snapshot path %s', path => {
    expect(isPublicCatalogPath(path)).toBe(true);
  });
  it.each(['static/data/catalog.json\n', 'static/data/2026.json\r', 'static/data/2026.json\u2028', 'static/data/../catalog.json', 'static/data/raw.json', 'data/books.db', 'static/data/20260.json'])
    ('rejects private, escaped, and non-allowlisted paths %s', path => { expect(isPublicCatalogPath(path)).toBe(false); });

  it('never echoes a malformed private receipt or its path from the real CLI', () => {
    const root = directory();
    execFileSync('git', ['init', '--quiet', root]);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/iamnbutler/shelfgoblin.git']);
    const log = join(root, 'private.log');
    writeFileSync(log, 'PRIVATE REVIEW AND TOKEN SHOULD NEVER APPEAR');
    const result = spawnSync(process.execPath, [resolve('scripts/catalog-deploy.mjs'), 'receipt'], { encoding: 'utf8', env: {
      ...process.env, CATALOG_APP_ROOT: root, CATALOG_REFRESH_LOG: log, GITHUB_OUTPUT: join(root, 'output'), GITHUB_STEP_SUMMARY: join(root, 'summary')
    } });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('PRIVATE');
    expect(result.stdout + result.stderr).not.toContain(root);
    expect(result.stderr).toContain('No deployment was authorized');
    expect(readFileSync(join(root, 'summary'), 'utf8')).not.toContain('PRIVATE');
  });
});

describe('fresh deployment window', () => {
  it('keeps Cloudflare credentials out of refresh/install/build and checks out the handoff commit', () => {
    const workflow = readFileSync('.github/workflows/catalog-refresh.yml', 'utf8');
    const [producer, deploy] = workflow.split('\n  deploy:\n');
    expect(producer).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(deploy).toContain("if: needs.refresh.outputs.published == 'true'");
    expect(deploy).toContain('ref: ${{ needs.refresh.outputs.sha }}');
    expect(deploy).not.toContain('shelfgoblin-data');
    expect(deploy).not.toContain('CATALOG_DATA_TOKEN');
    const [checks, finalStep] = deploy.split('      - name: Deploy the canonical Cloudflare Worker');
    expect(checks).not.toContain('CLOUDFLARE_API_TOKEN');
    for (const command of ['npm run check', 'npm run check:worker', 'npm test', 'npm run build', 'wrangler deploy --dry-run']) expect(checks).toContain(command);
    expect(finalStep).toContain('timeout-minutes: 5');
    expect(finalStep.indexOf('catalog-deploy.mjs guard')).toBeLessThan(finalStep.indexOf('npx wrangler deploy --env='));
    expect(finalStep).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
  });
  it.each([
    ['01:59:59.999', 15, false], ['02:00:00.000', 15, true], ['21:44:00.000', 15, true],
    ['21:45:00.000', 15, true], ['21:45:00.001', 15, false], ['21:46:00.000', 15, false],
    ['21:55:00.000', 5, true], ['21:55:00.001', 5, false], ['22:00:00.000', 5, false], ['00:00:00.000', 5, false]
  ])('at %s with %i minutes reserved allows=%s', (time, reserve, allowed) => {
    expect(deploymentAllowed(new Date(`2026-09-19T${time}Z`), trusted, reserve)).toBe(allowed);
  });
  it('honors only the exact explicitly dispatched exception in the trusted main workflow', () => {
    const now = new Date('2026-09-19T23:00:00Z');
    const manual = { ...trusted, GITHUB_EVENT_NAME: 'workflow_dispatch', CATALOG_ALLOW_OUTSIDE_WINDOW: 'true' };
    expect(deploymentAllowed(now, manual)).toBe(true);
    for (const change of [
      { GITHUB_EVENT_NAME: 'schedule' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REPOSITORY: 'someone/fork' },
      { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_ACTIONS: 'false' },
      ...['TRUE', '1', 'yes', 'false', ''].map(value => ({ CATALOG_ALLOW_OUTSIDE_WINDOW: value }))
    ]) expect(deploymentAllowed(now, { ...manual, ...change })).toBe(false);
  });
  it('rechecks time after a job that started outside the exclusion window', () => {
    expect(deploymentAllowed(new Date('2026-09-19T21:44:00Z'), trusted, 15)).toBe(true);
    expect(deploymentAllowed(new Date('2026-09-19T21:56:00Z'), trusted)).toBe(false);
  });
  it('checks the actual workflow start guard against the same boundary cases', () => {
    const workflow = readFileSync('.github/workflows/catalog-refresh.yml', 'utf8');
    const deploy = workflow.split('\n  deploy:\n')[1];
    const code = deploy.split("python3 - <<'PY'\n")[1].split('\n          PY')[0].split('\n').map(line => line.slice(10)).join('\n');
    const root = directory(), output = join(root, 'output'), summary = join(root, 'summary');
    for (const [time, event, exception] of [
      ['21:44:00', 'schedule', 'false'], ['21:45:00', 'schedule', 'false'], ['21:46:00', 'schedule', 'false'],
      ['22:00:00', 'schedule', 'true'], ['01:59:59', 'workflow_dispatch', 'false'], ['02:00:00', 'schedule', 'false'],
      ['23:00:00', 'workflow_dispatch', 'true'], ['23:00:00', 'workflow_dispatch', 'TRUE']
    ]) {
      writeFileSync(output, '');
      const fixed = code.replace('now = datetime.datetime.now(datetime.timezone.utc)', `now = datetime.datetime.fromisoformat('2026-09-19T${time}+00:00')`);
      const env = { ...trusted, GITHUB_EVENT_NAME: event, CATALOG_ALLOW_OUTSIDE_WINDOW: exception };
      execFileSync('python3', ['-c', fixed], { env: { ...process.env, ...env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
      expect(readFileSync(output, 'utf8')).toBe(`allowed=${deploymentAllowed(new Date(`2026-09-19T${time}Z`), env, 15)}\n`);
    }
  });
});
