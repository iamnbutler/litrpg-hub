import { load, type CheerioAPI } from 'cheerio';
import { normalizeIdentity } from '../../../src/lib/catalog.js';
import { clean, verifyIdentity } from './adapters.js';
import { audioLinkAsin } from './audio-links.js';
import { ReviewError, type ExtractedBook, type SeedSeries } from './types.js';

const GRAND = { series: 'The Grand Game', author: 'Tom Elliot', origin: 'https://tomlitrpg.com' };
const NOVA = { series: 'Portal to Nova Roma', author: 'J.R. Mathews', origin: 'https://jrmathewsauthor.com' };
const collection = /\b(?:omnibus|compilation|collection|box(?:ed)?\s*set|books\s+\d+\s*[-–]\s*\d+)\b/i;
const inline = (value: string) => clean(value).replace(/\s+/g, ' ');
const blankBook = (title: string, number: number, identity: typeof GRAND, format: ExtractedBook['format']): ExtractedBook => ({
  title, series: identity.series, number, author: identity.author, format,
  description: '', coverUrl: null, releaseDate: null, publicationStatus: 'unknown',
  narrator: null, audioReleaseDate: null, audioRuntimeMinutes: null, links: []
});

function requireSeed(seed: SeedSeries, identity: typeof GRAND): void {
  if (![seed.title, ...seed.aliases].some(title => normalizeIdentity(title) === normalizeIdentity(identity.series))
    || normalizeIdentity(seed.author) !== normalizeIdentity(identity.author)
    || !seed.authorAliases.some(author => normalizeIdentity(author) === normalizeIdentity(identity.author))) {
    throw new ReviewError('Author bibliography does not match the selected series and author.');
  }
}

function httpsUrl(value: string | undefined, base: string): URL | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}

function checkCanonical($: CheerioAPI, origin: string, path: RegExp): void {
  const href = $('link[rel="canonical"]').first().attr('href');
  if (!href) return;
  const url = httpsUrl(href, origin);
  if (!url || url.origin !== origin || !path.test(url.pathname)) throw new ReviewError('Author page has an unexpected canonical identity.');
}

function retailerLink(value: string | undefined, format: 'ebook' | 'audiobook'): ExtractedBook['links'][number] | null {
  const url = httpsUrl(value, NOVA.origin);
  if (!url) return null;
  const allowed = format === 'ebook' ? ['amazon.com', 'www.amazon.com'] : ['audible.com', 'www.audible.com', 'amazon.com', 'www.amazon.com'];
  if (!allowed.includes(url.hostname)) return null;
  const asin = audioLinkAsin(url.href);
  if (!asin) return null;
  url.search = ''; url.hash = '';
  // Amazon also places attribution after the product ID in /ref=... path segments.
  url.pathname = url.pathname.replace(new RegExp(`(/${asin})(?:/.*)?$`), '$1');
  return { url: url.href, format, asin };
}

function addLink(book: ExtractedBook, link: ExtractedBook['links'][number]): void {
  if (!book.links.some(known => known.format === link.format && known.url === link.url)) book.links.push(link);
}

/** The taxonomy, not position, title digits, or the largest retained volume, supplies order. */
export function grandGameSeriesBooks(html: string, seed: SeedSeries): { book: ExtractedBook; url: string }[] {
  requireSeed(seed, GRAND);
  const $ = load(html), found = new Map<number, { book: ExtractedBook; url: string }>();
  checkCanonical($, GRAND.origin, /^\/the-grand-game\/?$/);
  const cards = $('article.book-category-the-grand-game');
  if (cards.length > 150) throw new ReviewError('Grand Game bibliography exceeded the bounded book limit.');
  cards.each((_, element) => {
    const card = $(element), heading = card.find('h2.entry-title').first(), title = inline(heading.text());
    if (collection.test(title)) return;
    const numbers = new Set<number>();
    card.find('a[href]').each((_, anchor) => {
      const url = httpsUrl($(anchor).attr('href'), GRAND.origin);
      if (!url || url.origin !== GRAND.origin) return;
      const taxonomy = url.pathname.match(/^\/book-tag\/book-(\d+)\/?$/);
      if (!taxonomy) return;
      const label = inline($(anchor).text()).match(/^Book\s+(\d+)$/i);
      if (!label || Number(label[1]) !== Number(taxonomy[1])) throw new ReviewError('Grand Game book taxonomy and label conflict.');
      numbers.add(Number(label[1]));
    });
    const classNumbers = (card.attr('class') ?? '').split(/\s+/).flatMap(name => {
      const match = name.match(/^book-tag-book-(\d+)$/); return match ? [Number(match[1])] : [];
    });
    const number = [...numbers][0];
    if (numbers.size !== 1 || classNumbers.some(value => value !== number)) throw new ReviewError('Grand Game card does not establish one explicit book number.');
    const url = httpsUrl(heading.find('a[href]').first().attr('href'), GRAND.origin);
    if (!title || !url || url.origin !== GRAND.origin || !/^\/book\/[^/]+\/?$/.test(url.pathname)) {
      throw new ReviewError('Grand Game card lacks an identified author book page.');
    }
    url.search = ''; url.hash = '';
    const book = blankBook(title, number, GRAND, 'unknown');
    book.coverUrl = httpsUrl(card.find('img').first().attr('data-src') ?? card.find('img').first().attr('src'), GRAND.origin)?.href ?? null;
    verifyIdentity(book, seed);
    const prior = found.get(number);
    if (prior && (normalizeIdentity(prior.book.title) !== normalizeIdentity(title) || prior.url !== url.href)
      || [...found.values()].some(known => known.url === url.href && known.book.number !== number)) {
      throw new ReviewError('Grand Game bibliography gives conflicting work identities.');
    }
    found.set(number, { book, url: url.href });
  });
  if (!found.size) throw new ReviewError('Author bibliography contains no explicitly numbered Grand Game books.');
  return [...found.values()].sort((left, right) => left.book.number - right.book.number);
}

/** `number` must come from the retained parent bibliography's exact URL/title mapping. */
export function parseGrandGameBook(html: string, seed: SeedSeries, number: number): ExtractedBook {
  requireSeed(seed, GRAND);
  if (!Number.isInteger(number) || number <= 0 || number > 200) throw new ReviewError('Grand Game book needs a reviewed parent volume number.');
  const $ = load(html);
  checkCanonical($, GRAND.origin, /^\/book\/[^/]+\/?$/);
  const scope = $('main').length ? $('main').first() : $('body');
  const title = inline(scope.find('.wp-block-post-title').first().text());
  const book = blankBook(title, number, GRAND, 'unknown');
  verifyIdentity(book, seed);
  const copy = scope.find('.kb-dynamic-html').first().clone();
  copy.find('br').replaceWith('\n');
  // Subscription widgets and reader reviews are nested under other elements, never source paragraphs.
  book.description = copy.children('p').map((_, paragraph) => clean($(paragraph).text())).get().filter(Boolean).join('\n\n');
  if (!book.description) throw new ReviewError('Grand Game source synopsis is missing.');
  book.coverUrl = httpsUrl($('meta[property="og:image"]').first().attr('content'), GRAND.origin)?.href ?? null;
  scope.find('a[href]').each((_, anchor) => {
    if (inline($(anchor).text()) !== 'AUDIBLE' || $(anchor).closest('header,footer,nav,article.kt-blocks-post-grid-item,[class*="wpsr"]').length) return;
    const url = httpsUrl($(anchor).attr('href'), GRAND.origin);
    if (!url) return;
    if (url.hostname === 'amzn.to' && /^\/[A-Za-z0-9]+$/.test(url.pathname) && !url.search && !url.hash) {
      // A short link is only an observed candidate. Resolve and verify its exact product separately.
      addLink(book, { url: url.href, format: 'audiobook' });
    } else {
      const link = retailerLink(url.href, 'audiobook');
      if (link) addLink(book, link);
    }
  });
  return book;
}

function novaLabel(value: string): { number: number; title: string } | null {
  const label = inline(value).match(/^Book\s+(\d+)\s+of\s+(\d+):\s*(.+)$/i);
  if (!label) return null;
  const number = Number(label[1]), total = Number(label[2]), title = label[3];
  if (number < 1 || number > total || total > 200 || !/^Portal to Nova Roma(?:\s*[:,–—-]\s*.+)?$/i.test(title)) return null;
  return { number, title };
}

/** Five individually labelled ebook works; an audio button remains an unverified product lead. */
export function parseNovaRoma(html: string, seed: SeedSeries): ExtractedBook[] {
  requireSeed(seed, NOVA);
  const $ = load(html), found = new Map<number, ExtractedBook>();
  checkCanonical($, NOVA.origin, /^\/portal-to-nova-roma\/?$/);
  const heading = $('h2').filter((_, element) => normalizeIdentity($(element).text()) === normalizeIdentity(NOVA.series)
    && !$(element).find('a').length && !$(element).closest('header,footer,nav').length).first();
  const introduction = heading.closest('section');
  if (!introduction.length) throw new ReviewError('Author page does not establish the Portal to Nova Roma series.');
  const paragraphs: string[] = [];
  let credits = false;
  introduction.find('.sqs-html-content').filter((_, element) => $(element).closest('section')[0] === introduction[0])
    .children('p').each((_, paragraph) => {
      const copy = $(paragraph).clone(); copy.find('br').replaceWith('\n');
      const text = clean(copy.text());
      if (/^(?:Cover art by|Narrated by)\b/i.test(text)) credits = true;
      if (credits || !text || /^\W*SERIES NOW COMPLETE\b/i.test(text)) return;
      paragraphs.push(text);
    });

  $('.list-item').each((_, element) => {
    const card = $(element), label = inline(card.find('.list-item-content__title').first().text());
    if (collection.test(label)) return;
    const number = label.match(/^Portal to Nova Roma\s+#(\d+)$/i);
    if (!number) return;
    const description = card.find('.list-item-content__description').first();
    const identity = novaLabel(description.children('p').first().text() || description.text());
    if (!identity || identity.number !== Number(number[1])) throw new ReviewError('Nova Roma card has conflicting or missing book identity.');
    const book = blankBook(identity.title, identity.number, NOVA, 'ebook');
    book.description = identity.number === 1 ? paragraphs.join('\n\n') : '';
    book.coverUrl = httpsUrl(card.find('img').first().attr('data-src') ?? card.find('img').first().attr('src'), NOVA.origin)?.href ?? null;
    card.find('a[href]').each((_, anchor) => {
      const link = retailerLink($(anchor).attr('href'), 'ebook'); if (link) addLink(book, link);
    });
    verifyIdentity(book, seed);
    const prior = found.get(book.number);
    if (prior && normalizeIdentity(prior.title) !== normalizeIdentity(book.title)) throw new ReviewError('Nova Roma bibliography gives conflicting titles for a volume.');
    if (prior) for (const link of book.links) addLink(prior, link);
    else found.set(book.number, book);
  });
  if (!found.size || found.size > 150) throw new ReviewError('Author page has no bounded, identifiable Nova Roma book list.');

  const sections = new Set($('h2').filter((_, element) => /^Shop\s+Audiobooks\b/i.test(inline($(element).text())))
    .map((_, element) => $(element).closest('section')[0]).get().filter(Boolean));
  for (const section of sections) {
    let current: ExtractedBook | null = null;
    $(section).find('.sqs-html-content,.sqs-block-button').filter((_, element) => $(element).closest('section')[0] === section).each((_, element) => {
      const block = $(element);
      if (block.hasClass('sqs-html-content')) {
        // In this flat Squarespace layout each text block begins a new card. In particular,
        // an omnibus or an unrelated label must never inherit the previous volume's number.
        current = null;
        const first = inline(block.children('p').first().text());
        if (collection.test(first)) return;
        const number = first.match(/^Portal to Nova Roma\s+#(\d+)\s+Audiobook$/i);
        if (!number) return;
        const identity = novaLabel(block.children('p').eq(1).text());
        const book = found.get(Number(number[1]));
        if (!identity || !book || identity.number !== book.number || normalizeIdentity(identity.title) !== normalizeIdentity(book.title)) {
          throw new ReviewError('Nova Roma audio card does not match its explicitly numbered ebook work.');
        }
        current = book;
      } else if (current) {
        block.find('a[href]').each((_, anchor) => {
          const link = retailerLink($(anchor).attr('href'), 'audiobook');
          if (link) addLink(current!, link);
        });
      }
    });
  }
  return [...found.values()].sort((left, right) => left.number - right.number);
}
