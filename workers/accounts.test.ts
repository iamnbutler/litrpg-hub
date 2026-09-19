import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { digest, handle, type Env } from './accounts';
import { emptyLibrary, followSeries } from '../src/lib/library';

// Exercise the real migration, constraints and SQL (including atomic RETURNING)
// against SQLite, with only the D1 transport shimmed.
function binding(db: Database.Database): D1Database {
  function statement(sql: string, values: unknown[] = []): D1PreparedStatement {
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      first: async () => db.prepare(sql).get(...values) ?? null,
      run: async () => ({ success: true, meta: db.prepare(sql).run(...values) }),
      all: async () => ({ success: true, results: db.prepare(sql).all(...values) })
    } as unknown as D1PreparedStatement;
  }
  return { prepare: statement, batch: async (statements: D1PreparedStatement[]) => {
    db.exec('BEGIN');
    try { const results = []; for (const stmt of statements) results.push(await stmt.run()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } } as D1Database;
}
let db: Database.Database, env: Env;
const site = 'https://nate.rip/litrpg-hub/';
const token = 'a'.repeat(43);
beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(new URL('./migrations/0001_accounts.sql', import.meta.url), 'utf8'));
  env = { DB: binding(db), SITE_URL: site, OAUTH_GITHUB_CLIENT_ID: 'client', OAUTH_GITHUB_CLIENT_SECRET: 'secret', OAUTH_GITHUB_REDIRECT_URI: `${site}auth/callback/` };
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)').run('github:1', '1', 'reader', 'Reader', '', 1, 1);
  db.prepare('INSERT INTO libraries (user_id, updated_at) VALUES (?, ?)').run('github:1', 1);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(await digest(token), 'github:1', Math.floor(Date.now() / 1000) + 1000);
});
afterEach(() => db.close());
function req(route: string, init: RequestInit = {}) {
  return new Request(`${site}${route}`, { ...init, headers: { Cookie: `litrpg_session=${token}`, ...init.headers } });
}
async function put(library: unknown, revision = 0, extra: Record<string, string> = {}) {
  return handle(req('api/library/', { method: 'PUT', headers: { Origin: 'https://nate.rip', 'X-CSRF-Token': await digest(`csrf:${token}`), 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ library, revision }) }), env);
}

describe('account API', () => {
  it('only returns the authenticated user, with private response caching', async () => {
    const response = await handle(req('api/session/?user=github:2'), env);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ user: { id: 'github:1', username: 'reader' }, csrf: await digest(`csrf:${token}`) });
    expect((await handle(new Request(`${site}api/library/`), env)).status).toBe(401);
  });
  it('rejects expired sessions and cross-origin or missing-CSRF mutations', async () => {
    expect((await put(emptyLibrary(), 0, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await put(emptyLibrary(), 0, { 'X-CSRF-Token': '' })).status).toBe(403);
    db.exec('UPDATE sessions SET expires_at = 1');
    expect((await put(emptyLibrary())).status).toBe(401);
  });
  it('persists libraries and returns concurrent conflicts without overwriting', async () => {
    const library = followSeries(emptyLibrary(), 'dungeon-crawler-carl', true);
    expect((await put(library)).status).toBe(200);
    const stale = await put(emptyLibrary());
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ userId: 'github:1', library, revision: 1 });
    expect((await put(emptyLibrary(), 1)).status).toBe(200);
    expect(await (await handle(req('api/library/'), env)).json()).toEqual({ userId: 'github:1', library: emptyLibrary(), revision: 2 });
  });
  it('rejects malformed, oversized and prototype-polluting libraries', async () => {
    expect((await put({ version: 2, series: {}, books: { bad: { status: 'invalid' } } })).status).toBe(400);
    expect((await put(JSON.parse('{"version":2,"series":{"__proto__":{"followedAt":"2026-01-01"}},"books":{}}'))).status).toBe(400);
    expect((await put({ extra: 'x'.repeat(600_000) })).status).toBe(400);
    expect((await put(emptyLibrary(), -1)).status).toBe(400);
  });
  it('revokes the session on logout and clears its cookie', async () => {
    expect((await handle(req('auth/logout/'), env)).status).toBe(405);
    const response = await handle(req('auth/logout/', { method: 'POST', headers: { Origin: 'https://nate.rip', 'X-CSRF-Token': await digest(`csrf:${token}`) } }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await handle(req('api/library/'), env)).status).toBe(401);
  });
});

describe('GitHub OAuth', () => {
  async function begin(returnTo = '/litrpg-hub/?view=library') {
    const response = await handle(req(`auth/login/?returnTo=${encodeURIComponent(returnTo)}`), env);
    return { response, url: new URL(response.headers.get('Location')!) };
  }
  it('uses PKCE and short-lived HttpOnly secure state cookies without extra GitHub scopes', async () => {
    const { response, url } = await begin('//evil.example');
    expect(url.origin).toBe('https://github.com');
    expect(url.searchParams.get('scope')).toBe('');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly; SameSite=Lax; Max-Age=600; Secure');
    const state = db.prepare('SELECT * FROM oauth_states').get() as { state_hash: string; verifier: string; return_to: string };
    expect(state.return_to).toBe(site);
    expect(state.state_hash).toBe(await digest(url.searchParams.get('state')!));
    expect(url.searchParams.get('code_challenge')).toBe(await digest(state.verifier));
  });
  it('rejects missing/mismatched state before exchanging a code', async () => {
    const fetcher = vi.fn();
    const response = await handle(req('auth/callback/?code=bad&state=wrong'), env, fetcher);
    expect(response.headers.get('Location')).toBe(`${site}?auth=failed`);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('creates identity and hashed session once; replays and provider failures cannot sign in', async () => {
    const { url } = await begin();
    const state = url.searchParams.get('state')!;
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'private-github-token' }))
      .mockResolvedValueOnce(Response.json({ id: 42, login: 'new-reader', name: 'New Reader', avatar_url: 'https://avatars.githubusercontent.com/u/42' }));
    const request = () => req(`auth/callback/?code=good&state=${state}`, { headers: { Cookie: `litrpg_oauth=${state}` } });
    const response = await handle(request(), env, fetcher);
    expect(response.headers.get('Location')).toBe(`${site}?view=library`);
    expect(response.headers.get('Set-Cookie')).toContain('litrpg_session=');
    expect(db.prepare('SELECT github_id FROM users WHERE id = ?').get('github:42')).toEqual({ github_id: '42' });
    const sessionCookie = response.headers.get('Set-Cookie')!.match(/litrpg_session=([^;]+)/)![1];
    expect(db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get('github:42')).toEqual({ token_hash: await digest(sessionCookie) });
    expect(JSON.stringify(db.prepare('SELECT * FROM users').all())).not.toContain('private-github-token');
    expect((await handle(request(), env, fetcher)).headers.get('Location')).toBe(`${site}?auth=failed`);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const retry = await begin();
    const rejected = await handle(req(`auth/callback/?error=access_denied&state=${retry.url.searchParams.get('state')}`, { headers: { Cookie: `litrpg_oauth=${retry.url.searchParams.get('state')}` } }), env, fetcher);
    expect(rejected.headers.get('Location')).toBe(`${site}?auth=failed`);
  });
});
