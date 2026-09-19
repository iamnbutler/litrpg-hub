import type Database from 'better-sqlite3';
import { hash } from './queue.js';
import { ReviewError, type Document } from './types.js';
import { THE_LAND_BOOK_URLS, THE_LAND_ORIGIN } from './the-land-adapter.js';

const hosts = new Set(['aethonbooks.com','soundbooththeater.com','mattdinniman.com','www.penguinrandomhouse.com','podiumentertainment.com','www.podiumentertainment.com','portal-books.com','michaelchatfield.com','travisbagwell.com','tomlitrpg.com','jrmathewsauthor.com','afkauthor.com','sarahlinauthor.blogspot.com','www.willwight.com','www.mountaindalepress.store','mountaindalepress.store','www.litrpg.com','api.audible.com']);
const agent = 'LitRPGHub/0.2 (+https://github.com/iamnbutler/litrpg-hub)';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve,ms));
export function sourceUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password || url.port) throw new ReviewError('Source URL is outside the configured publisher/author hosts.');
  if (url.hostname === 'api.audible.com' && !/^\/1\.0\/catalog\/products\/[A-Z0-9]{10}$/.test(url.pathname)) throw new ReviewError('Only an already identified Audible product can be fetched.');
  if (url.origin === THE_LAND_ORIGIN && value !== `${THE_LAND_ORIGIN}/robots.txt` && !THE_LAND_BOOK_URLS.includes(value)) {
    throw new ReviewError('Only the eight reviewed Land work pages and their robots policy can be fetched.');
  }
  if (url.hostname === 'sarahlinauthor.blogspot.com' && !(url.pathname === '/robots.txt' && !url.search
    || /^\/p\/(?:the-weirkey-chronicles|street-cultivation)\.html$/.test(url.pathname) && ['', '?m=0'].includes(url.search))) {
    throw new ReviewError('Only the two reviewed Sarah Lin series pages and their robots policy can be fetched.');
  }
  url.hash = '';
  return url;
}
export function robotsAllowed(body: string, pathname: string): boolean {
  type Rule = { path: string; allow: boolean };
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let group = { agents: [] as string[], rules: [] as Rule[] }, sawRule = false;
  for (const line of body.split('\n')) {
    const match = line.replace(/#.*/, '').trim().match(/^(user-agent|disallow|allow):\s*(.*)$/i);
    if (!match) continue;
    if (match[1].toLowerCase() === 'user-agent') {
      if (sawRule) { groups.push(group); group = { agents: [], rules: [] }; sawRule = false; }
      group.agents.push(match[2].toLowerCase());
    } else {
      sawRule = true;
      if (match[2]) group.rules.push({ path: match[2], allow: match[1].toLowerCase() === 'allow' });
    }
  }
  groups.push(group);
  const specificity = (agents: string[]) => Math.max(-1, ...agents.map(a => a === '*' ? 0 : 'litrpghub'.startsWith(a) ? a.length : -1));
  const best = Math.max(-1, ...groups.map(g => specificity(g.agents)));
  if (best < 0) return true;
  const rules = groups.filter(g => specificity(g.agents) === best).flatMap(g => g.rules);
  const matching = rules.filter(r => new RegExp('^' + r.path.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*').replace(/\\\$$/,'$')).test(pathname))
    .sort((a,b) => b.path.length-a.path.length || Number(b.allow)-Number(a.allow));
  return matching[0]?.allow ?? true;
}
interface UrlRow { document_id: string; etag: string | null; last_modified: string | null; checked_at: string; next_check_at: string }
export async function getDocument(db: Database.Database, value: string, options: { force?: boolean; robots?: boolean; ttlDays?: number; request?: typeof fetch; format?: 'audible-product' } = {}): Promise<{ document: Document; downloaded: boolean }> {
  const url = sourceUrl(value), canonical = url.href;
  const productApi = options.format === 'audible-product';
  if (productApi !== (url.hostname === 'api.audible.com')) throw new ReviewError('The source format does not match its configured endpoint.');
  const cached = db.prepare('SELECT * FROM catalog_urls WHERE url=?').get(canonical) as UrlRow | undefined;
  const old = cached ? db.prepare('SELECT * FROM catalog_documents WHERE id=?').get(cached.document_id) as Document : null;
  const usable=old&&(!productApi||(()=>{try{const p=JSON.parse(old.body)?.product;return p?.asin===url.pathname.split('/').at(-1)&&typeof p.title==='string'&&!!p.title.trim();}catch{return false;}})());
  if (cached && old && usable && !options.force && cached.next_check_at > new Date().toISOString()) return { document: old, downloaded: false };
  // The exact public product API is a separate JSON endpoint, not a website crawler.
  // It exposes no robots document. Its adapter never performs catalog/list searches.
  if (!options.robots && !productApi) {
    const robots = await getDocument(db,new URL('/robots.txt',url).href,{ robots: true, ttlDays: 7, request: options.request });
    if (!robotsAllowed(robots.document.body,url.pathname+url.search)) throw new ReviewError('The source robots policy excludes this URL.');
  }
  // One writer is the default; persist host timing so restarting does not reset politeness.
  const last = db.prepare('SELECT MAX(checked_at) AS stamp FROM catalog_urls WHERE url LIKE ?').get(`${url.origin}/%`) as { stamp: string | null };
  if (last.stamp) await sleep(Math.max(0,1200-(Date.now()-Date.parse(last.stamp))));
  const headers: Record<string,string> = { 'User-Agent': agent, Accept: productApi ? 'application/json' : options.robots ? 'text/plain' : 'text/html' };
  if (usable&&cached?.etag) headers['If-None-Match'] = cached.etag;
  if (usable&&cached?.last_modified) headers['If-Modified-Since'] = cached.last_modified;
  let response: Response;
  try { response = await (options.request ?? fetch)(canonical,{ headers,signal:AbortSignal.timeout(25_000),redirect:'error' }); }
  catch { throw new Error('Publisher request failed or redirected. The previous source remains intact.'); }
  const now = new Date(), stamp = now.toISOString(), due = new Date(now.getTime()+(options.ttlDays ?? 30)*86400000).toISOString();
  if (response.status === 304 && old && usable) {
    db.prepare('UPDATE catalog_urls SET checked_at=?,next_check_at=? WHERE url=?').run(stamp,due,canonical);
    return { document: old, downloaded: false };
  }
  if(response.status===304)throw new ReviewError('Source returned unchanged without a usable saved document; needs review.');
  if ([401,403,404].includes(response.status) && !(options.robots && response.status === 404)) throw new ReviewError(`Source returned HTTP ${response.status}; needs a source review.`);
  if (!response.ok && !(options.robots && response.status === 404)) throw new Error(`Source returned HTTP ${response.status}; will retry later.`);
  const max = 5_000_000;
  if (!response.body || Number(response.headers.get('content-length')) > max) throw new Error('Source body is missing or too large.');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > max) throw new Error('Source exceeds the 5 MB limit.');
    chunks.push(chunk);
  }
  const body = options.robots && response.status === 404 ? 'User-agent: *\nDisallow:\n' : Buffer.concat(chunks).toString('utf8');
  if (productApi) {
    let data: {product?: {asin?: string; title?: string}};
    try { data = JSON.parse(body); } catch { throw new Error('Audiobook API returned invalid JSON; previous records preserved.'); }
    if (!response.headers.get('content-type')?.includes('application/json') || !data.product?.asin) throw new Error('Audiobook API returned no product; previous records preserved.');
    if (data.product.asin !== url.pathname.split('/').at(-1) || typeof data.product.title !== 'string' || !data.product.title.trim()) {
      throw new ReviewError('Audiobook API returned an identifier stub or a different product; the previous source remains intact.');
    }
  } else if (!options.robots && (!response.headers.get('content-type')?.includes('text/html') || /<title>\s*(?:just a moment|access denied)/i.test(body) || body.length < 300)) throw new ReviewError('Source returned an interstitial or unexpected content; previous records preserved.');
  const contentHash = hash(body), id = hash([canonical,contentHash]);
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO catalog_documents(id,url,content_hash,body,fetched_at) VALUES(?,?,?,?,?)').run(id,canonical,contentHash,body,stamp);
    db.prepare(`INSERT INTO catalog_urls(url,document_id,etag,last_modified,checked_at,next_check_at) VALUES(?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET document_id=excluded.document_id,etag=excluded.etag,last_modified=excluded.last_modified,checked_at=excluded.checked_at,next_check_at=excluded.next_check_at`)
      .run(canonical,id,response.headers.get('etag'),response.headers.get('last-modified'),stamp,due);
  })();
  return { document: db.prepare('SELECT * FROM catalog_documents WHERE id=?').get(id) as Document, downloaded: true };
}
