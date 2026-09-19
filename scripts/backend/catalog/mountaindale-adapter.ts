import { load, type CheerioAPI } from 'cheerio';
import { normalizeIdentity } from '../../../src/lib/catalog.js';
import { clean } from './adapters.js';
import { ReviewError, type ExtractedBook, type SeedSeries } from './types.js';

interface SeriesSpec { slug: string; names: string[] }
interface WorkLabel { title: string; number: number }
export interface MountaindaleBookLink extends WorkLabel { url: string }

// These are reviewed publisher bibliographies, not a generic storefront crawler.
const SERIES: SeriesSpec[] = [
  { slug: 'completionist-chronicles', names: ['Completionist Chronicles', 'The Completionist Chronicles'] },
  { slug: 'divine-dungeon', names: ['The Divine Dungeon', 'Divine Dungeon'] }
];
const AUTHOR = 'Dakota Krout';
const HOSTS = new Set(['www.mountaindalepress.store', 'mountaindalepress.store']);
const same = (a: string, b: string) => normalizeIdentity(a) === normalizeIdentity(b);
const labelText = (value: string) => clean(value).replace(/\s+/g, ' ');
const special = /\b(?:bundles?|box(?:ed)?[ -]?sets?|collections?|short stor(?:y|ies)|grimoire|non[- ]numbered|special editions?|collectors?'? editions?|limited editions?)\b/i;

function selectedSeries(seed: SeedSeries): SeriesSpec {
  const spec = SERIES.find(s => s.names.some(name => same(name, seed.title)));
  if (!spec || !same(seed.author, AUTHOR) || !seed.authorAliases.some(a => same(a, AUTHOR))) {
    throw new ReviewError('Mountaindale adapter requires a reviewed Dakota Krout series.');
  }
  return spec;
}

function storeUrl(value: string, base?: string): URL | null {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password) return null;
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/$/, '');
    return url;
  } catch { return null; }
}

function productUrl(value: string, base?: string): URL | null {
  const url = storeUrl(value, base);
  return url && /^\/products\/[a-z0-9][a-z0-9-]*$/i.test(url.pathname) ? url : null;
}

function workLabel(value: string, spec: SeriesSpec): WorkLabel | null {
  const label = labelText(value);
  const split = label.match(/^(.+?)\s*\|\s*(.+)$/);
  if (!split || special.test(split[1])) return null;
  // Older cards: "Rexus | Book 3 in the Completionist Chronicles".
  // Newer cards: "Untapped | Completionist Chronicles Book 12".
  const before = split[2].match(/^Book\s*#?\s*(\d+(?:\.\d+)?)(?:\s+of\s+(\d+))?\s+(?:in|of)\s+(.+)$/i);
  const after = split[2].match(/^(.+?)\s+Book\s*#?\s*(\d+(?:\.\d+)?)[!.]?$/i);
  const series = before?.[3] ?? after?.[1];
  if (!series || !spec.names.some(name => same(name, series))) return null;
  const number = Number(before?.[1] ?? after?.[2]);
  const total = before?.[2] ? Number(before[2]) : null;
  if (!Number.isFinite(number) || number <= 0 || number > 200 || (total !== null && number > total)) {
    throw new ReviewError('Mountaindale gives an invalid numbered work label.');
  }
  return { title: split[1].trim(), number };
}

/** Only the selected series' numbered book grid; never navigation or related-item sliders. */
export function mountaindaleSeriesLinks(html: string, base: string, seed: SeedSeries): MountaindaleBookLink[] {
  const spec = selectedSeries(seed), source = storeUrl(base);
  if (!source || source.pathname !== `/pages/series/${spec.slug}`) {
    throw new ReviewError('Mountaindale source URL is not the selected series bibliography.');
  }
  const $ = load(html), heading = $('h1.series-title');
  if (heading.length !== 1 || !spec.names.some(name => same(name, labelText(heading.text())))) {
    throw new ReviewError('Mountaindale bibliography heading does not match the selected series.');
  }
  const authors = $('.hub-card.type-author h3').map((_, el) => labelText($(el).text())).get();
  if (!authors.length || !authors.every(author => same(author, AUTHOR))) {
    throw new ReviewError('Mountaindale bibliography does not identify the selected author.');
  }
  const grids = $('.collection-grid').filter((_, el) => {
    const title = labelText($(el).siblings('h2.collection-grid-title').text()).replace(/\s+Titles$/i, '');
    return spec.names.some(name => same(name, title));
  });
  if (grids.length !== 1) throw new ReviewError('Mountaindale numbered book grid is missing or ambiguous.');
  const found = new Map<string, MountaindaleBookLink>(), titles = new Map<number, string>();
  grids.find('.hub-card.type-book a.hub-card-link[href]').each((_, el) => {
    const url = productUrl($(el).attr('href')!, source.href);
    if (!url || url.origin !== source.origin) return;
    const label = workLabel($(el).find('h3').first().text(), spec);
    if (!label) return;
    const prior = found.get(url.href), previousTitle = titles.get(label.number);
    if ((prior && (prior.number !== label.number || !same(prior.title, label.title))) ||
        (previousTitle && !same(previousTitle, label.title))) {
      throw new ReviewError('Mountaindale bibliography has conflicting work identities.');
    }
    titles.set(label.number, label.title);
    found.set(url.href, { ...label, url: url.href });
  });
  if (!found.size || found.size > 60) throw new ReviewError('Mountaindale bibliography has no bounded numbered book list.');
  // Sorting is not a claim of completeness; gaps remain available to the catalog audit.
  return [...found.values()].sort((a, b) => a.number - b.number || a.url.localeCompare(b.url));
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);

function productNodes(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(productNodes);
  if (!object(value)) return [];
  const type = value['@type'];
  if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) return [value];
  return Array.isArray(value['@graph']) ? value['@graph'].flatMap(productNodes) : [];
}

function products($: CheerioAPI): JsonObject[] {
  const found: JsonObject[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { found.push(...productNodes(JSON.parse($(el).text()))); } catch { /* Not executable page scripts. */ }
  });
  return found;
}

function descriptionText(html: string): string {
  const $ = load(html);
  $('script,style,noscript,template,meta,form,button').remove();
  $('br').replaceWith('\n');
  $('p,div,li,h1,h2,h3,h4,h5,h6,blockquote').append('\n\n');
  const numberedNote = /^(?:this is\s+)?(?:the\s+)?(?:book\s*#?\s*\d+|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|last|final)\s+(?:book|of\b|and\s+final\s+book))/i;
  const deliveryNote = /^(?:be a completionist and secure\b|(?:ebook|audiobook|paperback|hardcover)(?:\s*(?:,|and|&)\s*(?:ebook|audiobook|paperback|hardcover))*\s*(?:delivery)?\s*[-–—:])/i;
  // Older products contain only numbered-series labels and signed-copy jokes.
  // Preserve those in the retained document, not as a fabricated story synopsis.
  return clean($.root().text()).split(/\n\s*\n/).filter(paragraph => {
    const text = labelText(paragraph);
    if (numberedNote.test(text) && /\b(?:completionist chronicles|divine dungeon|series)\b/i.test(text)) return false;
    if (/-\s*Dakota Krout[.!]?\s*$/i.test(text) && /\b(?:signed|purchase|copy|choice|this book|ordering)\b/i.test(text)) return false;
    return !deliveryNote.test(text);
  }).join('\n\n');
}

/** Parse one explicitly selected physical product; stock and offer expiry are never publication dates. */
export function parseMountaindaleBook(html: string, seed: SeedSeries, sourceUrl: string): ExtractedBook {
  const spec = selectedSeries(seed), source = productUrl(sourceUrl);
  if (!source) throw new ReviewError('Mountaindale book source is not an individual product URL.');
  const $ = load(html), headings = $('h1.product-title');
  const label = headings.length === 1 ? workLabel(headings.text(), spec) : null;
  if (!label) throw new ReviewError('Mountaindale product is not a numbered work in the selected series.');
  const authors = $('a.product-btn-author').map((_, el) => labelText($(el).text())).get();
  if (!authors.length || !authors.every(author => same(author, AUTHOR))) {
    throw new ReviewError('Mountaindale product author does not match the selected series.');
  }
  const matching = products($).filter(item => {
    const name = typeof item.name === 'string' ? workLabel(item.name, spec) : null;
    return name && name.number === label.number && same(name.title, label.title);
  });
  if (matching.length !== 1) throw new ReviewError('Mountaindale product metadata is missing or ambiguous.');
  const item = matching[0];
  // Shopify's brand names either the author or Mountaindale Press; it is not an
  // author field. The explicit author link above supplies creator identity.
  if (item.author !== undefined) {
    const credits = (Array.isArray(item.author) ? item.author : [item.author])
      .map(author => typeof author === 'string' ? author : object(author) ? author.name : null);
    if (!credits.length || !credits.every(author => typeof author === 'string' && same(author, AUTHOR))) {
      throw new ReviewError('Mountaindale product metadata has conflicting author identity.');
    }
  }
  const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
  for (const offer of offers) {
    if (!object(offer) || typeof offer.url !== 'string') continue;
    const offered = productUrl(offer.url, source.href);
    if (!offered || offered.origin !== source.origin || offered.pathname !== source.pathname) {
      throw new ReviewError('Mountaindale product metadata points to another product.');
    }
  }
  const description = typeof item.description === 'string' ? descriptionText(item.description) : '';
  const images = Array.isArray(item.image) ? item.image : [item.image];
  const coverUrl = images.find((image): image is string => typeof image === 'string' && /^https:\/\//.test(image)) ?? null;
  const links: ExtractedBook['links'] = [{ url: source.href, format: 'print' }];
  // Only an explicit US Audible product link in this book's own description yields
  // an ASIN candidate. The importer must still run its independent audio verifier.
  const copy = load(typeof item.description === 'string' ? item.description : '');
  copy('script,style,noscript,template,form').remove();
  copy('a[href]').each((_, el) => {
    try {
      const url = new URL(copy(el).attr('href')!, source.href);
      if (url.protocol !== 'https:' || !['audible.com', 'www.audible.com'].includes(url.hostname) || url.username || url.password || url.port) return;
      const asin = url.pathname.match(/\/pd\/(?:[^/]+\/)?([A-Z0-9]{10})(?:\/|$)/)?.[1];
      if (!asin) return;
      url.hash = ''; url.search = '';
      if (!links.some(link => link.url === url.href)) links.push({ url: url.href, format: 'audiobook', asin });
    } catch { /* Malformed purchase link, not edition evidence. */ }
  });
  return {
    ...label, series: seed.title, author: AUTHOR, description, coverUrl,
    format: 'print', publicationStatus: 'unknown', releaseDate: null,
    narrator: null, audioReleaseDate: null, audioRuntimeMinutes: null, links
  };
}
