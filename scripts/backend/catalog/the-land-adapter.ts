import { load, type CheerioAPI } from 'cheerio';
import { normalizeIdentity } from '../../../src/lib/catalog.js';
import { clean, verifyIdentity } from './adapters.js';
import { ReviewError, type ExtractedBook, type SeedSeries } from './types.js';

export const THE_LAND_ORIGIN = 'https://www.litrpg.com';
const AUTHOR = 'Aleron Kong';
const SERIES = 'Chaos Seeds';
/** These reviewed identities are guards, never substitutes for the page's own labels.
 * In particular, three current page slugs name a different book. */
const reviewed = [
  { path: '/the-land-founding', title: 'The Land: Founding', number: 1 },
  { path: '/the-land-forging', title: 'The Land: Forging', number: 2 },
  { path: '/the-land-alliances', title: 'The Land: Alliances', number: 3 },
  { path: '/the-land-catacombs', title: 'The Land: Catacombs', number: 4 },
  { path: '/the-land-catacombs-1', title: 'The Land: Swarm', number: 5 },
  { path: '/the-land-raiders', title: 'The Land: Raiders', number: 6 },
  { path: '/the-land-raiders-1', title: 'The Land: Predators', number: 7 },
  { path: '/the-land-founding-1', title: 'The Land: Monsters', number: 8 }
] as const;
export const THE_LAND_BOOK_URLS: readonly string[] = Object.freeze(reviewed.map(book => THE_LAND_ORIGIN + book.path));

const inline = (value: string) => clean(value).replace(/\s+/g, ' ');
const excluded = 'header,nav,footer,aside,blockquote,script,style,noscript,iframe,form,input,button,select,textarea,svg,video,audio,.comments,#comments,.comment,.recommendations,.related-books,.related-posts,.sample-chapters';
const stopHeading = /^(?:samples?(?:\s+chapters?)?|excerpts?|chapters?\s+\d+|reader\s+reviews?|reviews?|recommendations?|related\s+(?:books|series)|other\s+(?:books|series)|more\s+(?:books|series)|newsletter|subscribe)\b/i;
const ordinals: Record<string, number> = { debut: 1, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };
const ordinalStatement = /\b(debut|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|\d+(?:st|nd|rd|th))\s+(?:[\p{L}-]+\s+)?(installment|novel|book)\s+(?:of|in)\s+[^.!?;]{0,150}?\bChaos\s+Seeds\s+(?:series|saga)\b/giu;
interface Statement { number: number; text: string; index: number }

function statements(value: string): Statement[] {
  return [...inline(value).matchAll(ordinalStatement)].map(match => {
    const ordinal = match[1].toLowerCase();
    let number = ordinals[ordinal];
    if (!number) {
      number = Number.parseInt(ordinal, 10);
      const suffix = number % 100 >= 11 && number % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[number % 10] ?? 'th';
      if (ordinal !== `${number}${suffix}`) throw new ReviewError('The Land page has an invalid volume ordinal.');
    }
    if (ordinal === 'debut' && match[2].toLowerCase() !== 'novel') throw new ReviewError('The Land first volume needs the explicit debut novel statement.');
    return { number, text: match[0], index: match.index };
  });
}

function contentBlocks($: CheerioAPI) {
  return $('main#page .sqs-block-html .sqs-html-content').toArray()
    .filter(element => !$(element).closest(excluded).length)
    .map(element => {
      const copy = $(element).clone();
      copy.find(excluded).remove();
      const headings = copy.find('h1,h2,h3,h4,h5,h6').map((_, heading) => inline($(heading).text())).get();
      const bylines = copy.find('h1,h2,h3,h4,p').map((_, element) => inline($(element).text())).get()
        .filter(text => /^(?:By\s+|Author\s*:)/i.test(text)).map(text => text.replace(/^(?:By\s+|Author\s*:\s*)/i, ''));
      copy.find('br').replaceWith('\n');
      copy.find('p,h1,h2,h3,h4,h5,h6,li').prepend('\n\n').append('\n\n');
      const text = clean(copy.text());
      return { text, headings, bylines, statements: statements(text) };
    });
}

/** Current author pages establish works, not editions. Audio links are reviewed
 * separately; an ebook image or Amazon format swatch must not manufacture an ASIN. */
export function parseTheLandBook(html: string, seed: SeedSeries, sourceUrl: string): ExtractedBook {
  const expected = reviewed.find(book => sourceUrl === THE_LAND_ORIGIN + book.path);
  if (!expected || seed.id !== 'the-land'
    || ![seed.title, ...seed.aliases].some(title => normalizeIdentity(title) === normalizeIdentity('The Land'))
    || normalizeIdentity(seed.author) !== normalizeIdentity(AUTHOR)
    || !seed.authorAliases.some(author => normalizeIdentity(author) === normalizeIdentity(AUTHOR))) {
    throw new ReviewError('The Land adapter only accepts the eight reviewed Aleron Kong work pages.');
  }
  if (html.length > 2_000_000) throw new ReviewError('The Land page exceeded the bounded document size.');
  const $ = load(html);
  const canonical = $('link[rel~="canonical"]').map((_, element) => $(element).attr('href') ?? '').get();
  if (canonical.length !== 1 || canonical[0] !== sourceUrl
    || $('meta[property="og:url"]').toArray().some(element => $(element).attr('content') !== sourceUrl)) {
    throw new ReviewError('The Land page has a missing or conflicting canonical identity.');
  }
  const authorLabels = [...new Set($('header h1.site-title').map((_, element) => inline($(element).text())).get())];
  if (authorLabels.length !== 1 || normalizeIdentity(authorLabels[0]) !== normalizeIdentity(AUTHOR)) {
    throw new ReviewError('The retained page does not identify the Aleron Kong author site.');
  }
  if ($('main#page').length !== 1) throw new ReviewError('The Land page needs one main book body.');

  // Read active page labels, not an arbitrary copy of the title elsewhere in the
  // site navigation. Duplicate desktop/mobile labels must agree on URL and title.
  const active = $('nav .collection.active > a[href],nav .page-collection.active-link > a[href],nav a[aria-current="page"][href]')
    .toArray().filter(element => !$(element).closest('footer,aside').length);
  const labels = new Set<string>();
  for (const element of active) {
    let target: URL;
    try { target = new URL($(element).attr('href')!, sourceUrl); }
    catch { throw new ReviewError('The Land current navigation link is invalid.'); }
    if (target.href !== sourceUrl) throw new ReviewError('The Land current navigation points at another page.');
    labels.add(inline($(element).text()));
  }
  if (!labels.size || [...labels].some(title => normalizeIdentity(title) !== normalizeIdentity(expected.title))) {
    throw new ReviewError('The Land current page label conflicts with the reviewed work identity.');
  }
  const title = [...labels][0];

  const blocks = contentBlocks($);
  const first = blocks.findIndex(block => block.statements.length && block.statements[0].index <= 500);
  if (first < 0) throw new ReviewError('The Land main description has no explicit series volume statement.');
  const selected = [] as typeof blocks;
  for (const block of blocks.slice(first)) {
    if (block.headings.some(heading => stopHeading.test(heading))) break;
    selected.push(block);
  }
  if (!selected.length) throw new ReviewError('A sample or related section cannot establish a Land work.');
  const claims = selected.flatMap(block => block.statements);
  if (!claims.length || claims.some(claim => claim.number !== expected.number)) {
    throw new ReviewError('The Land description and reviewed volume number conflict.');
  }
  const selfLabels = [
    ...selected.flatMap(block => block.headings),
    ...$('meta[property="og:title"]').map((_, element) => $(element).attr('content') ?? '').get()
  ].filter(label => /^The\s+Land\s*:/i.test(label));
  if (selfLabels.some(label => normalizeIdentity(label) !== normalizeIdentity(title))) {
    throw new ReviewError('The Land page contains a stale or conflicting work title.');
  }

  const opening = inline(selected[0].text);
  if ((expected.number === 1 || expected.number === 8)
    && !/^(?:debut|8th)\s+novel\s+of\s+(?:the\s+)?(?:(?:best[- ]selling|internationally\s+acclaimed|acclaimed)\s+)*Chaos\s+Seeds\s+saga$/i.test(claims[0].text)) {
    throw new ReviewError('The Land novel statement does not explicitly identify the selected saga.');
  }
  // The debut statement belongs to the explicitly identified author's selected
  // saga. Later pages also declare the author in their opening volume statement.
  const author = expected.number === 1 ? authorLabels[0]
    : expected.number === 8 ? opening.match(/\bAuthor\s*,\s*([^,]+)\s*,\s*comes\b/i)?.[1]
    : claims[0].text.match(/\b(?:of|in)\s+(.+?)['’]s\s*,?\s+Chaos\s+Seeds\b/i)?.[1];
  const bylines = selected.flatMap(block => block.bylines);
  if (!author || normalizeIdentity(author) !== normalizeIdentity(AUTHOR)
    || bylines.some(byline => normalizeIdentity(byline) !== normalizeIdentity(author))) {
    throw new ReviewError('The Land main description has conflicting or missing author credits.');
  }
  const description = clean(selected.map(block => block.text).filter(Boolean).join('\n\n'));
  const remainder = inline(description).slice(claims[0].index + claims[0].text.length);
  if (description.length > 20_000 || remainder.length < 100) {
    throw new ReviewError('The Land page has no bounded, substantial book description.');
  }
  const book: ExtractedBook = {
    title, series: SERIES, number: claims[0].number, author: inline(author), description,
    coverUrl: null, releaseDate: null, publicationStatus: 'unknown', format: 'unknown',
    narrator: null, audioReleaseDate: null, audioRuntimeMinutes: null, links: []
  };
  verifyIdentity(book, seed);
  return book;
}
