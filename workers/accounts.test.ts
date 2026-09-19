import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
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
  // Every migration, in order, so a schema change is exercised here the way D1 applies it.
  const migrations = new URL('./migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  env = { DB: binding(db), SITE_URL: site, OAUTH_GITHUB_CLIENT_ID: 'client', OAUTH_GITHUB_CLIENT_SECRET: 'secret', OAUTH_GITHUB_REDIRECT_URI: `${site}auth/callback/` };
  db.prepare('INSERT INTO users (id, github_id, username, display_name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('github:1', '1', 'reader', 'Reader', '', 1, 1);
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
  it('stores a self-attested date of birth and recomputes the unlock server-side', async () => {
    const csrf = await digest(`csrf:${token}`);
    const send = (consent: unknown) => handle(req('api/adult/', { method: 'PUT',
      headers: { Origin: 'https://nate.rip', 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ consent }) }), env);

    // An adult's opt-in is honoured and persisted.
    expect(await (await send({ birthDate: '1990-01-01', attestedAt: '2026-09-19T00:00:00.000Z', allowAdult: true })).json())
      .toEqual({ consent: { birthDate: '1990-01-01', attestedAt: '2026-09-19T00:00:00.000Z', allowAdult: true } });
    expect(db.prepare('SELECT birth_date, allow_adult FROM users WHERE id = ?').get('github:1'))
      .toMatchObject({ birth_date: '1990-01-01', allow_adult: 1 });
    expect(await (await handle(req('api/session/'), env)).json()).toMatchObject({ consent: { allowAdult: true } });

    // A client asking to unlock on a minor's date is stored as a refusal, not a grant.
    const minor = String(new Date().getUTCFullYear() - 10);
    expect(await (await send({ birthDate: `${minor}-01-01`, attestedAt: '2026-09-19T00:00:00.000Z', allowAdult: true })).json())
      .toMatchObject({ consent: { birthDate: `${minor}-01-01`, allowAdult: false } });
    expect(db.prepare('SELECT allow_adult FROM users WHERE id = ?').get('github:1')).toMatchObject({ allow_adult: 0 });

    // Withdrawing removes the date entirely rather than leaving it behind a false flag.
    expect(await (await send(null)).json()).toEqual({ consent: { birthDate: null, attestedAt: null, allowAdult: false } });
    expect(db.prepare('SELECT birth_date FROM users WHERE id = ?').get('github:1')).toMatchObject({ birth_date: null });
  });
  it('refuses to record an age claim without a session or CSRF token', async () => {
    const body = JSON.stringify({ consent: { birthDate: '1990-01-01', allowAdult: true } });
    expect((await handle(new Request(`${site}api/adult/`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body }), env)).status).toBe(401);
    expect((await handle(req('api/adult/', { method: 'PUT', headers: { Origin: 'https://nate.rip', 'Content-Type': 'application/json' }, body }), env)).status).toBe(403);
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

describe('canonical domain and legacy-origin migration', () => {
  const canonicalSite = 'https://shelfgobl.in/';
  const legacySite = 'https://litrpg-hub.iamnbutler.workers.dev/';
  const at = (origin: string, route: string, init: RequestInit = {}) => new Request(`${origin}${route}`, {
    ...init, headers: { Cookie: `litrpg_session=${token}`, ...init.headers }
  });
  beforeEach(() => {
    env.SITE_URL = canonicalSite;
    env.LEGACY_SITE_URL = legacySite;
    env.OAUTH_GITHUB_REDIRECT_URI = `${canonicalSite}auth/callback/`;
  });

  it('serves root-path sessions and completes canonical OAuth without losing the existing library', async () => {
    const saved = followSeries(emptyLibrary(), 'dungeon-crawler-carl', true);
    db.prepare('UPDATE libraries SET library_json = ? WHERE user_id = ?').run(JSON.stringify(saved), 'github:1');
    expect(await (await handle(at(canonicalSite, 'api/session/'), env)).json()).toMatchObject({ user: { id: 'github:1' } });
    const begin = await handle(at(canonicalSite, 'auth/login/?returnTo=%2F%3Fview%3Dlibrary'), env);
    const authorize = new URL(begin.headers.get('Location')!);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${canonicalSite}auth/callback/`);
    expect(begin.headers.get('Set-Cookie')).toContain('; Path=/; HttpOnly; SameSite=Lax;');
    expect(begin.headers.get('Set-Cookie')).toContain('; Secure');
    const state = authorize.searchParams.get('state')!;
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'fake-access-token' }))
      .mockResolvedValueOnce(Response.json({ id: 1, login: 'reader', name: 'Reader' }));
    const completed = await handle(at(canonicalSite, `auth/callback/?code=good&state=${state}`, {
      headers: { Cookie: `litrpg_oauth=${state}` }
    }), env, fetcher);
    expect(completed.headers.get('Location')).toBe(`${canonicalSite}?view=library`);
    expect(completed.headers.get('Set-Cookie')).toContain('litrpg_session=');
    expect(JSON.parse((db.prepare('SELECT library_json FROM libraries WHERE user_id = ?').get('github:1') as { library_json: string }).library_json)).toEqual(saved);
  });

  it('lets a valid legacy session sync its library into the shared account store', async () => {
    const session = await handle(at(legacySite, 'api/session/'), env);
    expect(await session.json()).toMatchObject({ user: { id: 'github:1' }, csrf: await digest(`csrf:${token}`) });
    const saved = followSeries(emptyLibrary(), 'the-primal-hunter', true);
    const response = await handle(at(legacySite, 'api/library/', {
      method: 'PUT', headers: { Origin: new URL(legacySite).origin, 'X-CSRF-Token': await digest(`csrf:${token}`), 'Content-Type': 'application/json' },
      body: JSON.stringify({ library: saved, revision: 0 })
    }), env);
    expect(response.status).toBe(200);
    expect(await (await handle(at(legacySite, 'api/library/'), env)).json()).toMatchObject({ library: saved, revision: 1 });
    expect(await (await handle(at(canonicalSite, 'api/library/'), env)).json()).toMatchObject({ library: saved, revision: 1 });
  });

  it('requires each host own Origin and CSRF token even when both hosts are configured', async () => {
    for (const [requestSite, origin, csrf] of [
      [legacySite, new URL(canonicalSite).origin, await digest(`csrf:${token}`)],
      [canonicalSite, new URL(legacySite).origin, await digest(`csrf:${token}`)],
      [legacySite, 'https://evil.example', await digest(`csrf:${token}`)],
      [legacySite, new URL(legacySite).origin, '']
    ]) {
      const response = await handle(at(requestSite, 'api/library/', {
        method: 'PUT', headers: { Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
        body: JSON.stringify({ library: emptyLibrary(), revision: 0 })
      }), env);
      expect(response.status).toBe(403);
    }
    expect((await handle(new Request(`${legacySite}api/library/`), env)).status).toBe(401);
  });

  it('logs out an existing legacy session and clears the cookie at the legacy path', async () => {
    env.LEGACY_SITE_URL = `${legacySite}old/`;
    const response = await handle(at(env.LEGACY_SITE_URL, 'auth/logout/', {
      method: 'POST', headers: { Origin: new URL(legacySite).origin, 'X-CSRF-Token': await digest(`csrf:${token}`) }
    }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toContain('litrpg_session=; Path=/old/;');
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await handle(at(env.LEGACY_SITE_URL, 'api/library/'), env)).status).toBe(401);
  });

  it('redirects legacy sign-in to canonical sign-in with only a safe app return path', async () => {
    for (const [input, expected] of [
      ['/?view=library', '/?view=library'],
      ['/?view=series&series=dungeon-crawler-carl', '/?view=series&series=dungeon-crawler-carl'],
      ['//evil.example/steal', '/'],
      ['/auth/callback/?code=bad', '/'],
      ['/\\evil.example', '/']
    ]) {
      const response = await handle(at(legacySite, `auth/login/?returnTo=${encodeURIComponent(input)}`), env);
      const target = new URL(response.headers.get('Location')!);
      expect(response.status).toBe(303);
      expect(target.origin).toBe(new URL(canonicalSite).origin);
      expect(target.pathname).toBe('/auth/login/');
      expect(target.searchParams.get('returnTo')).toBe(expected);
      expect(response.headers.get('Set-Cookie')).toBeNull();
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM oauth_states').get()).toEqual({ count: 0 });
  });

  it('restarts a legacy callback at the canonical site without exchanging its code', async () => {
    const fetcher = vi.fn();
    const response = await handle(at(legacySite, 'auth/callback/?code=old&state=old'), env, fetcher);
    expect(response.headers.get('Location')).toBe(`${canonicalSite}?auth=failed`);
    expect(response.headers.get('Set-Cookie')).toContain('litrpg_oauth=; Path=/;');
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts only the exact configured legacy origin and preserves strict behavior when absent', async () => {
    for (const origin of ['https://evil.example/', 'https://litrpg-hub.iamnbutler.workers.dev.evil.example/', 'http://litrpg-hub.iamnbutler.workers.dev/']) {
      expect((await handle(at(origin, 'api/session/'), env)).status).toBe(404);
    }
    delete env.LEGACY_SITE_URL;
    expect((await handle(at(legacySite, 'api/session/'), env)).status).toBe(404);
    expect((await handle(at(canonicalSite, 'api/session/'), env)).status).toBe(200);
  });

  it('continues serving legacy assets so browser-only libraries can still be exported', async () => {
    const assets = vi.fn().mockResolvedValue(new Response('legacy app'));
    env.ASSETS = { fetch: assets } as unknown as Fetcher;
    const response = await handle(at(legacySite, ''), env);
    expect(await response.text()).toBe('legacy app');
    expect(response.headers.get('Location')).toBeNull();
    expect(assets).toHaveBeenCalledTimes(1);
  });
});
