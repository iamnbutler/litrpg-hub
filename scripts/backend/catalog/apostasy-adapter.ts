import { load } from 'cheerio';
import { normalizeIdentity } from '../../../src/lib/catalog.js';
import { clean, verifyIdentity } from './adapters.js';
import { ReviewError, type ExtractedBook, type SeedSeries } from './types.js';

const SERIES = 'Divine Apostasy';
const AUTHOR = 'A. F. Kay';
const ORIGIN = 'https://afkauthor.com';

/** Reviewed title-to-number mappings from config/next-expansion-sources.draft.json.
 * The author headings contain titles, NOT separate volume numerals. These numbers are
 * curated identity mappings, never inferred from an ordinal word or a DOM/widget index.
 * A mapping is emitted only when its exact title is observed in the selected source. */
const reviewedWorks: readonly { number: number; title: string }[] = [
  { number: 1, title: 'Shade’s First Rule' },
  { number: 2, title: 'The Second Betrayal' },
  { number: 3, title: 'Uru’s Third Temple' },
  { number: 4, title: 'The Fourth Secret' },
  { number: 5, title: 'Legion’s Fifth Vault' },
  { number: 6, title: 'The Sixth Rune' },
  { number: 7, title: 'Shadow’s Seventh Step' },
  { number: 8, title: 'The Eighth Harmony' },
  { number: 9, title: 'Tarot’s Ninth Harbinger' },
  { number: 10, title: 'The Tenth Muse' },
  { number: 11, title: 'Zealot’s Eleventh Crusade' },
  { number: 12, title: 'The Twelfth Conclave' }
];
const inline = (value: string) => clean(value).replace(/\s+/g, ' ');
const titleKey = (value: string) => inline(value).normalize('NFKC').replace(/[’‘]/g, "'").toLowerCase();
const reviewedByTitle = new Map(reviewedWorks.map(work => [titleKey(work.title), work]));
const excludedTitle = /\b(?:omnibus|bundle|box(?:ed)?\s+set|books\s+\d+\s*[-–]\s*\d+|Hamma[’']s\s+Last\s+Prayer|Last\s+Prayer|Grey\s+Warden|Cevin[’']s\s+Sword)\b/i;

function sourceIdentity(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ReviewError('Divine Apostasy needs a reviewed author source URL.'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash
    || !['/', '/book-recaps', '/book-recaps/'].includes(url.pathname)) {
    throw new ReviewError('Divine Apostasy adapter only accepts the reviewed author homepage and recap page.');
  }
  return url;
}

function workFromTitle(title: string, seed: SeedSeries): ExtractedBook | null {
  if (excludedTitle.test(title)) return null;
  const identity = reviewedByTitle.get(titleKey(title));
  if (!identity) throw new ReviewError(`Unmapped Divine Apostasy title needs review: ${title.slice(0, 160)}`);
  const work: ExtractedBook = {
    ...identity, series: SERIES, author: AUTHOR, description: '', coverUrl: null,
    // A recap heading establishes a work, not a physical or digital edition.
    format: 'unknown', releaseDate: null, publicationStatus: 'unknown',
    narrator: null, audioReleaseDate: null, audioRuntimeMinutes: null, links: []
  };
  verifyIdentity(work, seed);
  return work;
}

/** Identity-only sources, not marketing copy. /book-recaps currently establishes eleven
 * observed headings; / separately corroborates the reviewed twelfth title. Neither page
 * supplies observed audio product links. Recap body text must never enter descriptions. */
export function parseDivineApostasy(html: string, seed: SeedSeries, sourceUrl: string): ExtractedBook[] {
  const source = sourceIdentity(sourceUrl);
  if (![seed.title, ...seed.aliases].some(title => normalizeIdentity(title) === normalizeIdentity(SERIES))
    || normalizeIdentity(seed.author) !== normalizeIdentity(AUTHOR)
    || !seed.authorAliases.some(author => normalizeIdentity(author) === normalizeIdentity(AUTHOR))) {
    throw new ReviewError('Divine Apostasy requires the selected A. F. Kay series identity.');
  }
  const $ = load(html);
  const copyright = inline($('[data-aid="FOOTER_COPYRIGHT_RENDERED"]').first().text());
  const author = copyright.match(/^Copyright\s*(?:©|\(c\))\s*\d{4}(?:\s*[-–]\s*\d{4})?\s+(.+?)\s*[-–]\s*All Rights Reserved\.?$/i)?.[1];
  if (!author || normalizeIdentity(author) !== normalizeIdentity(AUTHOR)) {
    throw new ReviewError('The retained author page does not identify A. F. Kay.');
  }
  const canonical = $('link[rel="canonical"]').first().attr('href');
  if (canonical) {
    const target = sourceIdentity(new URL(canonical, source).href);
    if (target.pathname.replace(/\/$/, '') !== source.pathname.replace(/\/$/, '')) {
      throw new ReviewError('Divine Apostasy author page has a conflicting canonical path.');
    }
  }

  if (source.pathname === '/') {
    const heading = inline($('[data-aid="HEADER_TAGLINE_RENDERED"]').first().text());
    // A launch notice can corroborate a known title, but its yearless dates and nearby
    // serial-chapter announcements do not establish any publication or audio facts.
    const title = heading.replace(/\s+[-–—]\s+(?:Available|Audiobook|Out\s+now)\b.*$/i, '');
    if (!title) throw new ReviewError('Author homepage has no identifiable mainline title announcement.');
    const work = workFromTitle(title, seed);
    if (!work) throw new ReviewError('Author homepage promotes a supplementary work, not a mapped mainline book.');
    return [work];
  }

  const heading = $('[data-aid="ABOUT_SECTION_TITLE_RENDERED"]').filter((_, element) => inline($(element).text()) === 'Book Recaps').first();
  const section = heading.closest('section');
  if (!section.length) throw new ReviewError('Author recap bibliography section is missing.');
  const found = new Map<number, ExtractedBook>();
  const headings = section.find('[data-aid^="ABOUT_HEADLINE_RENDERED"]');
  if (headings.length > 150) throw new ReviewError('Author recap bibliography exceeded the bounded work limit.');
  headings.each((_, element) => {
    const label = inline($(element).text());
    const title = label.match(/^(.+?)\s+[-–—]\s+Summary$/i)?.[1];
    if (!title) return;
    const work = workFromTitle(title, seed);
    if (!work) return;
    // This index joins a heading to its own image only. It never supplies a book number.
    const component = $(element).attr('data-aid')?.match(/^ABOUT_HEADLINE_RENDERED(\d+)$/)?.[1];
    const image = component === undefined ? undefined : section.find(`img[data-aid="ABOUT_IMAGE_RENDERED${component}"]`).first().attr('src');
    if (image) {
      try {
        const url = new URL(image, source);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.port) work.coverUrl = url.href;
      } catch { /* An unusable image cannot change the observed work identity. */ }
    }
    const prior = found.get(work.number);
    if (!prior) found.set(work.number, work);
    else prior.coverUrl ??= work.coverUrl;
  });
  if (!found.size) throw new ReviewError('Author recap page has no observed, reviewed mainline work titles.');
  return [...found.values()].sort((left, right) => left.number - right.number);
}
