import { emptyLibrary, mergeLibraries, parseSeriesLibrary, storageKeys, type SeriesLibrary } from './library';
import { noConsent, parseAdultConsent, type AdultConsent } from './adult';

export interface AccountUser { id: string; username: string; displayName: string; avatarUrl: string }
export interface AccountState {
  user: AccountUser | null; status: string; ready: boolean; needsLogin: boolean; canImport: boolean;
  /** The reader's own age claim. Account-scoped when signed in, browser-scoped otherwise. */
  consent: AdultConsent;
}
interface Snapshot { userId: string; library: SeriesLibrary; revision: number }
interface Cache { library: SeriesLibrary; base: SeriesLibrary; revision: number }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Reapply only local edits to a fresh server copy. Absence is an edit too, so
 * unfollows and removed reads cannot be resurrected by another device's snapshot. */
export function rebaseLibrary(base: SeriesLibrary, local: SeriesLibrary, remote: SeriesLibrary): SeriesLibrary {
  function rebase<T>(before: Record<string, T>, after: Record<string, T>, latest: Record<string, T>): Record<string, T> {
    const result = { ...latest };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (equal(before[key], after[key])) continue;
      if (Object.hasOwn(after, key)) result[key] = after[key]; else delete result[key];
    }
    return result;
  }
  return { version: 2, series: rebase(base.series, local.series, remote.series), books: rebase(base.books, local.books, remote.books) };
}

export class AccountSync {
  state: AccountState = { user: null, status: 'Checking sign-in…', ready: false, needsLogin: false, canImport: false, consent: noConsent() };
  private csrf = '';
  private cache: Cache | null = null;
  private guest = emptyLibrary();
  private pending: Promise<void> | null = null;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private basePath: string, private storage: Storage,
    private changed: (state: AccountState, library?: SeriesLibrary) => void, private fetcher: typeof fetch = fetch) {}
  private report(status: string, library?: SeriesLibrary) {
    if (this.disposed) return;
    this.state = { ...this.state, status };
    this.changed(this.state, library);
  }
  private key() { return `${storageKeys.library}:account:${this.state.user!.id}`; }
  private persist() {
    if (this.cache && this.state.user) this.storage.setItem(this.key(), JSON.stringify(this.cache));
  }
  private async request(route: string, init?: RequestInit): Promise<Response> {
    return this.fetcher(`${this.basePath}/${route}`, { ...init, credentials: 'same-origin', cache: 'no-store',
      signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf, ...init?.headers } });
  }
  async start(guest: SeriesLibrary, guestConsent: AdultConsent = noConsent()): Promise<void> {
    this.guest = guest;
    // Applied up front so an unreachable session endpoint leaves the reader in guest mode with
    // their own claim, rather than with no claim at all.
    this.state = { ...this.state, consent: guestConsent };
    try {
      const response = await this.request('api/session/');
      if (!response.ok) throw new Error('unavailable');
      const { user, csrf, consent } = await response.json() as { user: AccountUser | null; csrf: string | null; consent?: unknown };
      if (this.disposed) return;
      this.csrf = csrf ?? '';
      this.state = { user, ready: true, needsLogin: false, status: '', consent: user ? parseAdultConsent(consent) : guestConsent,
        canImport: !!user && !!(Object.keys(guest.books).length || Object.keys(guest.series).length) };
      if (!user) { this.report('Saved in this browser'); return; }
      // A claim made in this browser moments ago came from the same reader, so carry it up
      // instead of asking again. The server still recomputes the unlock from the date.
      if (!this.state.consent.birthDate && guestConsent.birthDate) {
        try { await this.saveConsent(guestConsent); } catch { /* the gate stays shut, which is the safe direction */ }
      }
      if (this.disposed) return;
      let cached: Cache | null = null;
      try {
        const raw = JSON.parse(this.storage.getItem(this.key()) ?? 'null');
        if (raw && parseSeriesLibrary(raw.library) && parseSeriesLibrary(raw.base) && Number.isSafeInteger(raw.revision)) cached = raw;
      } catch { /* A corrupt cache must never become an empty upload. */ }
      this.cache = cached;
      this.report('Syncing…', cached?.library ?? emptyLibrary());
      await this.sync();
    } catch {
      this.state = { ...this.state, ready: true };
      this.report('Sign-in unavailable · library saved in this browser');
    }
  }
  save(library: SeriesLibrary) {
    if (!this.state.user) {
      this.guest = library;
      this.storage.setItem(storageKeys.library, JSON.stringify(library));
      return;
    }
    if (!this.cache) throw new Error('Wait for your account library to load before editing.');
    this.cache.library = library;
    this.persist();
    this.report('Changes saved on this device · syncing…');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.sync(); }, 400);
  }
  canEdit() { return !this.state.user || this.cache !== null; }
  /** The age claim is account state, not library content: it is written straight through
   * rather than merged, because there is nothing to reconcile between two devices — the
   * reader's date of birth is the same on both. */
  async saveConsent(next: AdultConsent): Promise<AdultConsent> {
    const requested = parseAdultConsent(next);
    if (!this.state.user) {
      this.storage.setItem(storageKeys.adult, JSON.stringify(requested));
      this.state = { ...this.state, consent: requested };
      this.report(this.state.status);
      return requested;
    }
    const response = await this.request('api/adult/', { method: 'PUT', body: JSON.stringify({ consent: requested }) });
    if (response.status === 401 || response.status === 403) { this.expired(); throw new Error('signed out'); }
    if (!response.ok) throw new Error('consent save failed');
    // The server's answer is authoritative: it may refuse an unlock this device asked for.
    const saved = parseAdultConsent((await response.json() as { consent?: unknown }).consent);
    if (this.disposed) return saved;
    this.state = { ...this.state, consent: saved };
    this.report(this.state.status);
    return saved;
  }
  importGuest() {
    if (!this.cache) return;
    const library = mergeLibraries(this.cache.library, this.guest);
    this.save(library);
    this.state = { ...this.state, canImport: false };
    this.report('Adding browser library…', library);
  }
  async sync(): Promise<void> {
    if (!this.state.user || this.state.needsLogin || this.disposed) return;
    if (this.pending) return this.pending;
    this.pending = this.performSync().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async performSync() {
    try {
      const response = await this.request('api/library/');
      if (response.status === 401) { this.expired(); return; }
      if (!response.ok) throw new Error('unavailable');
      let remote = await response.json() as Snapshot;
      if (remote.userId !== this.state.user?.id) { this.expired(); return; }
      if (!parseSeriesLibrary(remote.library) || !Number.isSafeInteger(remote.revision)) throw new Error('invalid response');
      if (this.disposed) return;
      if (!this.cache) this.cache = { ...remote, base: remote.library };
      for (let attempt = 0; attempt < 4; attempt++) {
        // Fold changes from another tab into this tab before touching the server.
        try {
          const other = JSON.parse(this.storage.getItem(this.key()) ?? 'null') as Cache | null;
          if (other && parseSeriesLibrary(other.library) && parseSeriesLibrary(other.base) && other.revision >= this.cache.revision) {
            this.cache.library = rebaseLibrary(this.cache.base, this.cache.library, other.library);
          }
        } catch { /* Current in-memory changes remain available. */ }
        const merged = rebaseLibrary(this.cache.base, this.cache.library, remote.library);
        this.cache = { library: merged, base: remote.library, revision: remote.revision };
        this.persist();
        this.report('Syncing…', merged);
        if (equal(merged, remote.library)) { this.report('Library synced'); return; }
        // Svelte state may contain proxies; serialize the JSON model to detach it.
        const sent = JSON.parse(JSON.stringify(merged)) as SeriesLibrary;
        const saved = await this.request('api/library/', { method: 'PUT', body: JSON.stringify({ library: sent, revision: remote.revision }) });
        if (saved.status === 401 || saved.status === 403) { this.expired(); return; }
        if (!saved.ok && saved.status !== 409) throw new Error('save failed');
        remote = await saved.json() as Snapshot;
        if (remote.userId !== this.state.user?.id) { this.expired(); return; }
        if (this.disposed) return;
        if (saved.ok) {
          this.cache = { library: rebaseLibrary(sent, this.cache.library, remote.library), base: remote.library, revision: remote.revision };
          this.persist();
        }
      }
      throw new Error('busy');
    } catch {
      this.report(this.cache ? 'Sync paused · changes kept on this device' : 'Could not load your account library · retry sync');
    }
  }
  private expired() {
    this.state = { ...this.state, needsLogin: true };
    this.report('Session expired · sign in again to sync');
  }
  async logout(): Promise<boolean> {
    await this.sync();
    if (this.cache && !equal(this.cache.library, this.cache.base)) {
      this.report('Sync your pending changes before signing out.'); return false;
    }
    try {
      const response = await this.request('auth/logout/', { method: 'POST' });
      if (!response.ok && response.status !== 401) throw new Error('logout failed');
      return true;
    } catch { this.report('Sign-out failed · please retry'); return false; }
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); }
}
