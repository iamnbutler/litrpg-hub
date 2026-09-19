import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTheLandBook, THE_LAND_BOOK_URLS, THE_LAND_ORIGIN } from './the-land-adapter.js';
import { processSource, seedCatalog } from './pipeline.js';
import { hash } from './queue.js';
import { robotsAllowed, sourceUrl } from './sources.js';
import { ReviewError, type Document, type SeedSeries } from './types.js';

const AT = '2026-09-19T05:30:00.000Z';
const seed: SeedSeries = { id: 'the-land', title: 'The Land', author: 'Aleron Kong', authorAliases: ['Aleron Kong'],
  aliases: ['Chaos Seeds'], genres: ['litrpg'], priority: 1,
  sources: THE_LAND_BOOK_URLS.map(url => ({ url, adapter: 'the-land-book' })) };
const titles = ['Founding', 'Forging', 'Alliances', 'Catacombs', 'Swarm', 'Raiders', 'Predators', 'Monsters'].map(title => `The Land: ${title}`);
const ordinals = ['debut', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', '8th', 'ninth'];
// Synthetic descriptions and representative Squarespace structure. No copied
// author/publisher/reviewer prose or downloaded HTML is committed as a fixture.
const prose = 'A traveler and a cartographer explore a valley whose roads change each night. They train a village watch, bargain for missing maps, and try to protect their new home while a rival expedition searches the surrounding mountains.';
const ending = 'Together they must decide which promises to keep before the winter roads close.';
const block = (body: string, extraClass = '') => `<div class="sqs-block-html ${extraClass}"><div class="sqs-block-content"><div class="sqs-html-content">${body}</div></div></div>`;
const statement = (number: number) => number === 1 ? 'The debut novel of the Chaos Seeds saga.'
  : number === 8 ? 'From a fictional announcement by the Author, Aleron Kong, comes the 8th novel of the Chaos Seeds saga.'
  : `The ${ordinals[number - 1]} vivid installment of Aleron Kong's, Chaos Seeds series.`;

function page(number: number): string {
  const url = THE_LAND_BOOK_URLS[number - 1], title = titles[number - 1];
  const otherLinks = THE_LAND_BOOK_URLS.map((link, index) => `<div class="collection"><a href="${link}">${titles[index]}</a></div>`).reverse().join('');
  const navigation = `<nav>${otherLinks}<div class="collection active"><a href="${url}">${title}</a></div></nav>`;
  const description = number === 8
    // The live Monsters page puts its ordinal after promotional text and the
    // substantive synopsis in a separate following block.
    ? block(`<h3>Series news</h3><p>${'Synthetic introductory announcement. '.repeat(7)}</p><p>${statement(number)}</p>`)
      + block(`<p>${prose}<br><br>${ending}</p>`)
    : block(`<p>${statement(number)}<br><br>${prose}</p><p>${ending}</p>`);
  return `<html><head><link rel="canonical" href="${url}"><meta property="og:url" content="${url}"><meta property="og:title" content="LitRPG"></head>
    <body><header><h1 class="site-title"><a href="/">Aleron Kong</a></h1>${navigation}${navigation}</header>
    <main id="page">${block('<p>Newsletter promotion unrelated to this work. Published 2020-01-01.</p>')}
      <a href="https://www.amazon.com/dp/B000000099/ref=tmm_aud_swatch_0"><img alt="Ebook 5.png"></a>
      ${description}
    </main><footer><p>${statement(9)}</p><p>Footer copy is outside the book description.</p></footer></body></html>`;
}
const parse = (number: number, html = page(number), selected = seed) => parseTheLandBook(html, selected, THE_LAND_BOOK_URLS[number - 1]);

afterEach(() => { vi.unstubAllGlobals(); });

describe('bounded Land author bibliography', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('reads explicit work %i without inferring its title or number from the slug or order', number => {
    const book = parse(number);
    expect(book).toMatchObject({ title: titles[number - 1], series: 'Chaos Seeds', number, author: 'Aleron Kong',
      format: 'unknown', publicationStatus: 'unknown', coverUrl: null, releaseDate: null, narrator: null,
      audioReleaseDate: null, audioRuntimeMinutes: null, links: [] });
    expect(book.description).toContain(prose);
    expect(book.description).toContain(ending);
    expect(book.description).not.toMatch(/Newsletter|Footer/);
  });

  it('keeps the complete later Monsters synopsis, paragraph boundaries, and inline text', () => {
    const book = parse(8, page(8).replace('cartographer', '<strong>cartographer</strong>'));
    expect(book.description).toContain(prose);
    expect(book.description).toContain(`\n\n${ending}`);
    expect(book.description).not.toMatch(/<strong>|Ebook 5/);
  });

  it('uses only the saga-specific debut statement for Founding', () => {
    expect(parse(1).number).toBe(1);
    expect(() => parse(1, page(1).replace(statement(1), 'Aleron Kong wrote a debut novel before starting other projects.'))).toThrow(ReviewError);
    expect(() => parse(1, page(1).replace(statement(1), 'The debut novel of another saga.'))).toThrow(ReviewError);
    expect(() => parse(1, page(1).replace(statement(1), 'The debut novel of another saga, not the Chaos Seeds saga.'))).toThrow(ReviewError);
    expect(() => parse(8, page(8).replace('8th novel of the Chaos Seeds saga', '8th novel of another saga, not the Chaos Seeds saga'))).toThrow(ReviewError);
  });

  it.each([5, 7, 8])('rejects a stale self-label for work %i instead of trusting the misleading slug', number => {
    const stale = number === 5 ? titles[3] : number === 7 ? titles[5] : titles[0];
    const html = page(number).replaceAll(`>${titles[number - 1]}</a></div></nav>`, `>${stale}</a></div></nav>`);
    expect(() => parse(number, html)).toThrow(ReviewError);
  });

  it('rejects conflicting active desktop/mobile labels and another active page', () => {
    expect(() => parse(5, page(5).replace(`>${titles[4]}</a></div></nav>`, `>${titles[3]}</a></div></nav>`))).toThrow(ReviewError);
    const active = `<div class="collection active"><a href="${THE_LAND_BOOK_URLS[4]}">`;
    expect(() => parse(5, page(5).replace(active, `<div class="collection active"><a href="${THE_LAND_BOOK_URLS[3]}">`))).toThrow(ReviewError);
    expect(() => parse(5, page(5).replaceAll('collection active', 'collection'))).toThrow(ReviewError);
  });

  it.each([
    ['canonical', 'link rel="canonical"', 'link rel="alternate"'],
    ['canonical URL', `rel="canonical" href="${THE_LAND_BOOK_URLS[4]}"`, `rel="canonical" href="${THE_LAND_BOOK_URLS[3]}"`],
    ['Open Graph URL', `property="og:url" content="${THE_LAND_BOOK_URLS[4]}"`, `property="og:url" content="${THE_LAND_BOOK_URLS[3]}"`],
    ['site author', '>Aleron Kong</a></h1>', '>Unrelated Author</a></h1>'],
    ['main body', '<main id="page">', '<main id="other">'],
    ['main author', "installment of Aleron Kong's,", "installment of Unrelated Author's,"],
    ['unexpected coauthor', "installment of Aleron Kong's,", "installment of Aleron Kong and Co Author's,"]
  ])('rejects missing or conflicting %s', (_field, from, to) => {
    expect(() => parse(5, page(5).replace(from, to))).toThrow(ReviewError);
  });

  it('rejects duplicate canonicals and main bodies', () => {
    expect(() => parse(2, page(2).replace('</head>', `<link rel="canonical" href="${THE_LAND_BOOK_URLS[1]}"></head>`))).toThrow(ReviewError);
    expect(() => parse(2, page(2).replace('</body>', '<main id="page"></main></body>'))).toThrow(ReviewError);
  });

  it('does not accept a stale main title or work title metadata', () => {
    expect(() => parse(5, page(5).replace(statement(5), `<h2>${titles[3]}</h2>${statement(5)}`))).toThrow(ReviewError);
    expect(() => parse(5, page(5).replace('property="og:title" content="LitRPG"', `property="og:title" content="${titles[3]}"`))).toThrow(ReviewError);
  });

  it('rejects a conflicting main byline even when the site branding is unchanged', () => {
    for (const number of [1, 5, 8]) {
      expect(() => parse(number, page(number).replace(`<p>${ending}</p>`, `<p>${ending}</p><p>By Other Author</p>`).replace(`<br><br>${ending}</p>`, `<br><br>${ending}</p><p>Author: Other Author</p>`))).toThrow(ReviewError);
    }
  });

  it('requires the page ordinal to agree with its reviewed identity and rejects contradictory statements', () => {
    expect(() => parse(5, page(5).replace(statement(5), statement(4)))).toThrow(ReviewError);
    expect(() => parse(5, page(5).replace(statement(5), `${statement(5)} ${statement(4)}`))).toThrow(ReviewError);
    expect(() => parse(5, page(5).replace(statement(5), "The ninth installment of Aleron Kong's, Chaos Seeds series."))).toThrow(ReviewError);
    expect(() => parse(8, page(8).replace('8th novel', '8st novel'))).toThrow(ReviewError);
    expect(() => parse(5, page(5).replace(statement(5), 'Another numbered adventure awaits.'))).toThrow(ReviewError);
  });

  it('does not mistake a later reference to the first book for this work’s volume', () => {
    const book = parse(5, page(5).replace(ending, `Readers of the first book will recognize the village. ${ending}`));
    expect(book.number).toBe(5);
    expect(book.description).toContain('Readers of the first book');
  });

  it('keeps outside recommendations, comments, and sample text out of identity and description', () => {
    const related = `<aside>${block(`<p>${statement(4)} Copied-looking recommendation text.</p>`)}</aside>`
      + block(`<p>${statement(4)} Synthetic comment text.</p>`, 'comments')
      + block(`<p>${statement(4)} Synthetic sample text.</p>`, 'sample-chapters');
    const book = parse(5, page(5).replace('</main>', related + '</main>'));
    expect(book.description).not.toMatch(/recommendation|comment|sample/);
    expect(book.number).toBe(5);
  });

  it('stops at an explicitly separate recommendations section', () => {
    const other = block(`<h2>Other books</h2><p>${statement(4)} Unrelated plot.</p>`);
    const book = parse(5, page(5).replace('</main>', other + '</main>'));
    expect(book.description).not.toContain('Unrelated plot');
    expect(book.number).toBe(5);
  });

  it('does not import a sample section, a bare identity, or an unrelated author/series seed', () => {
    expect(() => parse(5, page(5).replace(statement(5), `<h2>Sample chapters</h2>${statement(5)}`))).toThrow(ReviewError);
    expect(() => parse(5, page(5).replace(prose, '').replace(ending, ''))).toThrow(ReviewError);
    for (const selected of [{ ...seed, id: 'another-series' }, { ...seed, author: 'Other Author' },
      { ...seed, title: 'Another Series', aliases: [] }, { ...seed, authorAliases: ['Other Author'] }]) {
      expect(() => parse(5, page(5), selected)).toThrow(ReviewError);
    }
  });

  it('leaves recording facts unknown despite dates, audio wording, and misleading ebook swatches', () => {
    const extra = '<p>Audio available. Narrated by Synthetic Performer. June 2, 2020. 20 hours.</p>'
      + '<a href="https://www.amazon.com/dp/B000000005/ref=tmm_aud_swatch_0"><img alt="Ebook 5.png"></a>'
      + '<a href="https://www.audible.com/pd/B000000005">Audiobook</a>';
    const book = parse(5, page(5).replace('</main>', extra + '</main>'));
    expect(book).toMatchObject({ format: 'unknown', links: [], narrator: null, releaseDate: null, audioReleaseDate: null, audioRuntimeMinutes: null });
  });
});

describe('Land source boundary', () => {
  it('permits exactly the eight current primary pages and robots policy', () => {
    expect(new Set(THE_LAND_BOOK_URLS).size).toBe(8);
    for (const url of [...THE_LAND_BOOK_URLS, `${THE_LAND_ORIGIN}/robots.txt`]) expect(sourceUrl(url).href).toBe(url);
    expect(robotsAllowed('User-agent: *\nDisallow: /api/\nDisallow: /search\n', '/the-land-forging')).toBe(true);
    expect(robotsAllowed('User-agent: *\nDisallow: /the-land-forging\n', '/the-land-forging')).toBe(false);
  });

  it.each([
    '/litrpg-original', '/the-land-mayhem', '/the-land-9', '/index-book-1', '/the-land-founding-index',
    '/gods-eye', '/comic', '/search', '/api/page', '/the-land-forging/', '/the-land-forging?format=json',
    '/the-land-forging#sample', '/robots.txt?ignored=true', '/other/../the-land-forging'
  ])('rejects unreviewed or altered path %s', path => {
    expect(() => sourceUrl(`${THE_LAND_ORIGIN}${path}`)).toThrow(ReviewError);
    expect(() => parseTheLandBook(page(2), seed, `${THE_LAND_ORIGIN}${path}`)).toThrow(ReviewError);
  });

  it.each([
    'http://www.litrpg.com/the-land-forging', 'https://litrpg.com/the-land-forging',
    'https://www.litrpg.com.attacker.example/the-land-forging', 'https://user:example@www.litrpg.com/the-land-forging',
    'https://www.litrpg.com:443/the-land-forging', 'https://www.litrpg.com:8443/the-land-forging'
  ])('rejects an alternate host, protocol, or authority: %s', url => {
    expect(() => sourceUrl(url)).toThrow(ReviewError);
    expect(() => parseTheLandBook(page(2), seed, url)).toThrow(ReviewError);
  });
});

describe('Land cached source integration', () => {
  let db: Database.Database;
  function retain(url: string, body: string): Document {
    const content_hash = hash(body), id = hash([url, content_hash]);
    const document = { id, url, content_hash, body, fetched_at: AT };
    db.prepare('INSERT OR IGNORE INTO catalog_documents VALUES(?,?,?,?,?)').run(id, url, content_hash, body, AT);
    db.prepare('INSERT OR REPLACE INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)')
      .run(url, id, AT, '2099-01-01T00:00:00.000Z');
    return document;
  }
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    for (const name of ['001_initial.sql', '006_catalog_pipeline.sql']) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Offline tests must not make live requests.'); }));
  });
  afterEach(() => { db.close(); });

  it('imports eight retained primary descriptions without recordings, paid work, or completeness claims', async () => {
    expect(seedCatalog(db, [seed], { includeIndexes: false })).toBe(8);
    const documents = THE_LAND_BOOK_URLS.map((url, index) => retain(url, page(index + 1)));
    for (const [index, source] of seed.sources.entries()) {
      expect(await processSource(db, { ...source, seriesId: seed.id }, [seed])).toEqual({
        downloaded: false, work: `work-the-land-${index + 1}`, number: index + 1, title: titles[index]
      });
    }
    expect(await processSource(db, { ...seed.sources[4], seriesId: seed.id }, [seed])).toMatchObject({ downloaded: false, number: 5 });
    const works = db.prepare('SELECT number,title,author,source_description,description FROM catalog_works ORDER BY number').all() as {number:number;title:string;author:string;source_description:string;description:string}[];
    expect(works).toHaveLength(8);
    expect(works.map(work => work.title)).toEqual(titles);
    expect(works.every(work => work.author === 'Aleron Kong' && work.source_description.includes(prose) && work.source_description.includes(ending) && work.description === '')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_editions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM books').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_jobs WHERE kind!='source'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_claims WHERE entity_type='series'").get()).toEqual({ n: 0 });
    const claims = db.prepare("SELECT c.entity_id,c.document_id,c.method,d.content_hash FROM catalog_claims c JOIN catalog_documents d ON d.id=c.document_id WHERE c.field='description' ORDER BY c.entity_id").all();
    expect(claims).toEqual(documents.map((document, index) => ({ entity_id: `work-the-land-${index + 1}`, document_id: document.id, method: 'author-page', content_hash: document.content_hash })));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a previous work unchanged when a refreshed page conflicts', async () => {
    seedCatalog(db, [seed], { includeIndexes: false });
    const original = retain(THE_LAND_BOOK_URLS[4], page(5));
    const payload = { ...seed.sources[4], seriesId: seed.id };
    await processSource(db, payload, [seed]);
    const before = db.prepare("SELECT * FROM catalog_works WHERE id='work-the-land-5'").get();
    const changed = retain(THE_LAND_BOOK_URLS[4], page(5).replace(statement(5), statement(4)));
    await expect(processSource(db, payload, [seed])).rejects.toThrow(ReviewError);
    expect(db.prepare("SELECT * FROM catalog_works WHERE id='work-the-land-5'").get()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_claims WHERE document_id=?').get(changed.id)).toEqual({ n: 0 });
    expect(db.prepare('SELECT content_hash FROM catalog_documents WHERE id=?').get(original.id)).toEqual({ content_hash: original.content_hash });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unreviewed jobs before HTTP and mismatched retained URLs or volume payloads before import', async () => {
    seedCatalog(db, [seed], { includeIndexes: false });
    await expect(processSource(db, { url: 'https://aethonbooks.com/book/another/', adapter: 'the-land-book', seriesId: seed.id }, [seed])).rejects.toThrow(ReviewError);
    const other = retain(THE_LAND_BOOK_URLS[3], page(4));
    db.prepare('INSERT INTO catalog_urls(url,document_id,checked_at,next_check_at) VALUES(?,?,?,?)').run(THE_LAND_BOOK_URLS[4], other.id, AT, '2099-01-01T00:00:00.000Z');
    await expect(processSource(db, { ...seed.sources[4], seriesId: seed.id }, [seed])).rejects.toThrow(ReviewError);
    retain(THE_LAND_BOOK_URLS[4], page(5));
    await expect(processSource(db, { ...seed.sources[4], seriesId: seed.id, number: 4 }, [seed])).rejects.toThrow(ReviewError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_works').get()).toEqual({ n: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
