import { describe, expect, it, vi } from 'vitest';
import { AccountSync, rebaseLibrary } from './account-sync';
import { emptyLibrary, followSeries, storageKeys } from './library';

const a = followSeries(emptyLibrary(), 'a', true, '2026-01-01T00:00:00.000Z');
const ab = followSeries(a, 'b', true, '2026-01-01T00:00:00.000Z');
function storage(): Storage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); }, clear: () => data.clear(), key: (i) => [...data.keys()][i] ?? null, get length() { return data.size; } };
}
describe('three-way library sync', () => {
  it('preserves remote additions and local removals', () => {
    expect(rebaseLibrary(a, emptyLibrary(), ab).series).toEqual({ b: ab.series.b });
    expect(rebaseLibrary(a, a, emptyLibrary())).toEqual(emptyLibrary());
  });
  it('keeps account libraries separate from the guest library and other accounts', async () => {
    const disk = storage(); disk.setItem(storageKeys.library, JSON.stringify(a));
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ user: { id: 'github:2', username: 'two' }, csrf: 'csrf' }))
      .mockResolvedValueOnce(Response.json({ userId: 'github:2', library: emptyLibrary(), revision: 0 }));
    const changed = vi.fn();
    const sync = new AccountSync('', disk, changed, fetcher);
    await sync.start(a);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(disk.getItem(storageKeys.library)).toBe(JSON.stringify(a));
    expect(changed.mock.calls.some(([, library]) => library && Object.keys(library.series).length === 0)).toBe(true);
    expect(sync.state.canImport).toBe(true);
    sync.dispose();
  });
  it('retains offline changes and rebases a concurrent save without resurrecting unfollows', async () => {
    const disk = storage();
    const key = `${storageKeys.library}:account:github:1`;
    disk.setItem(key, JSON.stringify({ library: emptyLibrary(), base: a, revision: 1 }));
    const remote = followSeries(ab, 'c', true);
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ user: { id: 'github:1' }, csrf: 'csrf' }))
      .mockResolvedValueOnce(Response.json({ userId: 'github:1', library: ab, revision: 2 }))
      .mockResolvedValueOnce(Response.json({ userId: 'github:1', library: remote, revision: 3 }, { status: 409 }))
      .mockImplementationOnce(async (_url, init) => Response.json({ userId: 'github:1', library: JSON.parse(init.body).library, revision: 4 }));
    const sync = new AccountSync('', disk, vi.fn(), fetcher);
    await sync.start(emptyLibrary());
    const cache = JSON.parse(disk.getItem(key)!);
    expect(Object.keys(cache.library.series)).toEqual(['b', 'c']);
    expect(cache.revision).toBe(4);
    expect(sync.state.status).toBe('Library synced');
    sync.dispose();
  });
  it('pauses on expiry without writing private data into guest storage', async () => {
    const disk = storage(); disk.setItem(storageKeys.library, JSON.stringify(a));
    const key = `${storageKeys.library}:account:github:1`;
    disk.setItem(key, JSON.stringify({ library: ab, base: a, revision: 1 }));
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ user: { id: 'github:1' }, csrf: 'csrf' }))
      .mockResolvedValueOnce(Response.json({ error: 'expired' }, { status: 401 }));
    const sync = new AccountSync('', disk, vi.fn(), fetcher);
    await sync.start(a);
    expect(sync.state.needsLogin).toBe(true);
    expect(JSON.parse(disk.getItem(key)!).library).toEqual(ab);
    expect(disk.getItem(storageKeys.library)).toBe(JSON.stringify(a));
    sync.dispose();
  });
  it('does not load another account after a different tab signs in', async () => {
    const disk = storage();
    const key = `${storageKeys.library}:account:github:1`;
    disk.setItem(key, JSON.stringify({ library: a, base: a, revision: 1 }));
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ user: { id: 'github:1' }, csrf: 'csrf' }))
      .mockResolvedValueOnce(Response.json({ userId: 'github:2', library: ab, revision: 20 }));
    const sync = new AccountSync('', disk, vi.fn(), fetcher);
    await sync.start(emptyLibrary());
    expect(sync.state.needsLogin).toBe(true);
    expect(JSON.parse(disk.getItem(key)!).library).toEqual(a);
    expect(fetcher).toHaveBeenCalledTimes(2);
    sync.dispose();
  });
  it('uploads Svelte-style proxies and retains changes when the network fails', async () => {
    const disk = storage();
    const remote = { userId: 'github:1', library: emptyLibrary(), revision: 0 };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ user: { id: 'github:1' }, csrf: 'csrf' }))
      .mockResolvedValueOnce(Response.json(remote))
      .mockResolvedValueOnce(Response.json(remote))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(Response.json(remote))
      .mockImplementationOnce(async (_url, init) => Response.json({ userId: 'github:1', library: JSON.parse(init.body).library, revision: 1 }));
    const sync = new AccountSync('', disk, vi.fn(), fetcher);
    await sync.start(emptyLibrary());
    sync.save(new Proxy(a, {}));
    await sync.sync();
    expect(sync.state.status).toContain('Sync paused');
    expect(JSON.parse(disk.getItem(`${storageKeys.library}:account:github:1`)!).library).toEqual(a);
    await sync.sync();
    expect(sync.state.status).toBe('Library synced');
    expect(fetcher).toHaveBeenCalledTimes(6);
    sync.dispose();
  });
});
