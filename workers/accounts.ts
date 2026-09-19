import { emptyLibrary, parseSeriesLibrary } from '../src/lib/library';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  SITE_URL: string;
  OAUTH_GITHUB_CLIENT_ID: string;
  OAUTH_GITHUB_CLIENT_SECRET: string;
  OAUTH_GITHUB_REDIRECT_URI: string;
}

const SESSION_COOKIE = 'litrpg_session';
const STATE_COOKIE = 'litrpg_oauth';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_BODY = 512 * 1024;
const now = () => Math.floor(Date.now() / 1000);
const random = () => base64(crypto.getRandomValues(new Uint8Array(32)));
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export async function digest(value: string): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
function cookie(request: Request, name: string): string | null {
  const values = request.headers.get('Cookie')?.split(';').map((part) => part.trim()) ?? [];
  const value = values.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function setCookie(env: Env, name: string, value: string, seconds: number): string {
  const site = new URL(env.SITE_URL);
  return `${name}=${value}; Path=${site.pathname}; HttpOnly; SameSite=Lax; Max-Age=${seconds}${site.protocol === 'https:' ? '; Secure' : ''}`;
}
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers });
}
function returnTo(input: string | null, site: URL): string {
  if (!input || !input.startsWith('/') || input.startsWith('//') || input.includes('\\')) return site.href;
  const url = new URL(input, site);
  return url.origin === site.origin && url.pathname === site.pathname ? url.href : site.href;
}
interface UserRow { id: string; username: string; display_name: string; avatar_url: string }
interface Session { user: UserRow; csrf: string; tokenHash: string }
async function session(request: Request, env: Env): Promise<Session | null> {
  const token = cookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await digest(token);
  const user = await env.DB.prepare(`SELECT u.id, u.username, u.display_name, u.avatar_url
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(tokenHash, now()).first<UserRow>();
  return user ? { user, tokenHash, csrf: await digest(`csrf:${token}`) } : null;
}
async function library(env: Env, userId: string) {
  const row = await env.DB.prepare('SELECT library_json, revision FROM libraries WHERE user_id = ?')
    .bind(userId).first<{ library_json: string; revision: number }>();
  return { userId, library: row ? JSON.parse(row.library_json) : emptyLibrary(), revision: row?.revision ?? 0 };
}
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new Error('content-type');
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) throw new Error('size');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('body');
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY) { await reader.cancel(); throw new Error('size'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function login(request: Request, env: Env, site: URL): Promise<Response> {
  if (!env.OAUTH_GITHUB_CLIENT_ID || !env.OAUTH_GITHUB_CLIENT_SECRET) return json({ error: 'Sign-in is not configured.' }, 503);
  const state = random(), verifier = random();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(now()),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now()),
    env.DB.prepare('INSERT INTO oauth_states (state_hash, verifier, return_to, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await digest(state), verifier, returnTo(new URL(request.url).searchParams.get('returnTo'), site), now() + 600)
  ]);
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: env.OAUTH_GITHUB_CLIENT_ID, redirect_uri: env.OAUTH_GITHUB_REDIRECT_URI,
    state, code_challenge: await digest(verifier), code_challenge_method: 'S256', scope: ''
  }).toString();
  return redirect(url.href, [setCookie(env, STATE_COOKIE, state, 600)]);
}

async function callback(request: Request, env: Env, fetcher: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const clear = setCookie(env, STATE_COOKIE, '', 0);
  const fail = () => redirect(`${env.SITE_URL}?auth=failed`, [clear]);
  if (!state || state !== cookie(request, STATE_COOKIE)) return fail();
  // Delete and read atomically: a callback is consumable once, even with concurrent requests.
  const pending = await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? AND expires_at > ? RETURNING verifier, return_to')
    .bind(await digest(state), now()).first<{ verifier: string; return_to: string }>();
  const code = url.searchParams.get('code');
  if (!pending || !code || code.length > 1024 || url.searchParams.has('error')) return fail();
  try {
    const tokenResponse = await fetcher('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.OAUTH_GITHUB_CLIENT_ID, client_secret: env.OAUTH_GITHUB_CLIENT_SECRET,
        redirect_uri: env.OAUTH_GITHUB_REDIRECT_URI, code, code_verifier: pending.verifier }), signal: AbortSignal.timeout(10_000)
    });
    if (!tokenResponse.ok) return fail();
    const token = await tokenResponse.json() as { access_token?: string };
    if (typeof token.access_token !== 'string') return fail();
    const userResponse = await fetcher('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'litrpg-hub' },
      signal: AbortSignal.timeout(10_000)
    });
    if (!userResponse.ok) return fail();
    const profile = await userResponse.json() as { id: number; login: string; name?: string; avatar_url?: string };
    if (!Number.isSafeInteger(profile.id) || profile.id <= 0 || typeof profile.login !== 'string') return fail();
    const id = `github:${profile.id}`;
    const sessionToken = random();
    const oldToken = cookie(request, SESSION_COOKIE);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, github_id, username, display_name, avatar_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(github_id) DO UPDATE SET
        username = excluded.username, display_name = excluded.display_name, avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`)
        .bind(id, String(profile.id), profile.login.slice(0, 100), (profile.name || profile.login).slice(0, 200),
          profile.avatar_url?.startsWith('https://avatars.githubusercontent.com/') ? profile.avatar_url : '', now(), now()),
      env.DB.prepare('INSERT OR IGNORE INTO libraries (user_id, updated_at) VALUES (?, ?)').bind(id, now()),
      env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(oldToken ? await digest(oldToken) : ''),
      env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(await digest(sessionToken), id, now() + SESSION_SECONDS)
    ]);
    // GitHub access tokens are used only to establish identity; never store or return them.
    return redirect(pending.return_to, [clear, setCookie(env, SESSION_COOKIE, sessionToken, SESSION_SECONDS)]);
  } catch { return fail(); }
}

export async function handle(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const site = new URL(env.SITE_URL), url = new URL(request.url);
  if (url.origin !== site.origin) return json({ error: 'Unknown host.' }, 404);
  const route = url.pathname.slice(site.pathname.length).replace(/\/$/, '');
  if (!url.pathname.startsWith(site.pathname)) return json({ error: 'Not found.' }, 404);
  if (request.method === 'GET' && route === 'auth/login') return login(request, env, site);
  if (request.method === 'GET' && route === 'auth/callback') return callback(request, env, fetcher);
  if (!['api/session', 'api/library', 'auth/logout'].includes(route)) {
    if (!route.startsWith('api/') && !route.startsWith('auth/') && env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: 'Not found.' }, 404);
  }
  if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'PUT') return json({ error: 'Method not allowed.' }, 405);
  const auth = await session(request, env);
  if (route === 'api/session' && request.method === 'GET') {
    return json({ user: auth ? { id: auth.user.id, username: auth.user.username, displayName: auth.user.display_name, avatarUrl: auth.user.avatar_url } : null,
      csrf: auth?.csrf ?? null });
  }
  if (!auth) return json({ error: 'Sign in to sync your library.' }, 401);
  if (request.method !== 'GET' && (request.headers.get('Origin') !== site.origin || request.headers.get('X-CSRF-Token') !== auth.csrf)) {
    return json({ error: 'Invalid request origin or CSRF token.' }, 403);
  }
  if (route === 'auth/logout' && request.method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(auth.tokenHash).run();
    const response = json({ ok: true });
    response.headers.set('Set-Cookie', setCookie(env, SESSION_COOKIE, '', 0));
    return response;
  }
  if (route === 'api/library' && request.method === 'GET') return json(await library(env, auth.user.id));
  if (route === 'api/library' && request.method === 'PUT') {
    let data: { library?: unknown; revision?: number };
    try { data = await body(request) as typeof data; } catch { return json({ error: 'Expected a JSON library under 512 KiB.' }, 400); }
    const parsed = parseSeriesLibrary(data?.library);
    if (!parsed || !Number.isSafeInteger(data?.revision) || data.revision! < 0
      || canonical(parsed) !== canonical(data.library)) return json({ error: 'Invalid library or revision.' }, 400);
    const result = await env.DB.prepare('UPDATE libraries SET library_json = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ? RETURNING revision')
      .bind(JSON.stringify(parsed), now(), auth.user.id, data.revision!).first<{ revision: number }>();
    if (!result) return json(await library(env, auth.user.id), 409);
    return json({ userId: auth.user.id, library: parsed, revision: result.revision });
  }
  return json({ error: 'Method not allowed.' }, 405);
}

function canonical(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await handle(request, env); }
    catch { return json({ error: 'Account service is temporarily unavailable.' }, 503); }
  }
};
