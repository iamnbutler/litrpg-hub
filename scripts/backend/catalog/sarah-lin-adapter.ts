import { load } from 'cheerio';
import { normalizeIdentity } from '../../../src/lib/catalog.js';
import { clean } from './adapters.js';
import { audioLinkAsin } from './audio-links.js';
import { ReviewError, type SeedSeries } from './types.js';

/** An author-labelled link is discovery evidence, not an identified work or recording. */
export interface SarahLinAudioLead {
  seriesId: string;
  number: number;
  asin: string;
  url: string;
  sourceUrl: string;
}

const HOST = 'sarahlinauthor.blogspot.com';
const AUTHOR = 'Sarah Lin';
const SERIES = {
  'the-weirkey-chronicles': { title: 'The Weirkey Chronicles', path: '/p/the-weirkey-chronicles.html', section: true },
  'street-cultivation': { title: 'Street Cultivation', path: '/p/street-cultivation.html', section: false }
} as const;
const inline = (text: string) => clean(text).replace(/\s+/g, ' ');
const ancillary = 'nav,header,footer,aside,blockquote,.comments,#comments,.comment,.comment-content,.post-footer,.related-posts,.related-post,.recommendations';
const excluded = `script,style,noscript,iframe,form,.widget,${ancillary}`;
const block = 'address,article,dd,div,dl,dt,fieldset,figcaption,figure,h1,h2,h3,h4,h5,h6,hr,li,main,ol,p,pre,section,table,td,th,tr,ul';
const planned = /\b(?:WIP|work in progress|will be recorded|to be recorded|not yet recorded|planned|coming soon|currently only available on Patreon)\b/i;
const collection = /\b(?:omnibus|collection|bundle|box(?:ed)?\s*set|books\s+\d+\s*[-–]\s*\d+)\b/i;
const stopHeading = /^(?:Description\s*:|Frequently Asked Questions?\b|Recommendations?\b|Related\s+(?:books|series)\b|Other\s+(?:books|series)\b|More\s+(?:books|series)\b|You might also like\b|Further reading\b)/i;

function checkedUrl(value: string, path: string, canonical = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ReviewError('Sarah Lin discovery requires the selected official series URL.'); }
  // Blogger currently declares an HTTP canonical for pages fetched over HTTPS. Check
  // its exact host/path identity without ever requesting or following that HTTP URL.
  if (!(url.protocol === 'https:' || canonical && url.protocol === 'http:') || url.hostname !== HOST
    || url.username || url.password || url.port || url.pathname !== path || url.hash
    || !['', '?m=0'].includes(url.search)) {
    throw new ReviewError('Sarah Lin discovery only accepts the two reviewed official series pages.');
  }
  return url;
}

interface Anchor { href: string | undefined; text: string }

/** These pages name series and volume numbers but omit individual work titles.
 * Do not synthesize ExtractedBooks from their book order, cover filenames, or URL slugs.
 * The caller must retain the document and verify each identified product separately. */
export function parseSarahLinAudioLeads(html: string, seed: SeedSeries, sourceUrl: string): SarahLinAudioLead[] {
  const identity = Object.hasOwn(SERIES, seed.id) ? SERIES[seed.id as keyof typeof SERIES] : undefined;
  if (!identity || ![seed.title, ...seed.aliases].some(title => normalizeIdentity(title) === normalizeIdentity(identity.title))
    || normalizeIdentity(seed.author) !== normalizeIdentity(AUTHOR)
    || !seed.authorAliases.some(author => normalizeIdentity(author) === normalizeIdentity(AUTHOR))) {
    throw new ReviewError('Sarah Lin discovery requires one of the two selected Sarah Lin series.');
  }
  const source = checkedUrl(sourceUrl, identity.path);
  if (html.length > 2_000_000) throw new ReviewError('Sarah Lin page exceeded the bounded document size.');
  const $ = load(html);
  if (normalizeIdentity($('h1.title').first().text()) !== normalizeIdentity("Sarah Lin's Books")) {
    throw new ReviewError('The retained page does not identify the Sarah Lin author site.');
  }
  const canonical = $('link[rel="canonical"]').map((_, element) => $(element).attr('href') ?? '').get();
  if (canonical.length !== 1) throw new ReviewError('Sarah Lin author page has no unambiguous canonical identity.');
  checkedUrl(canonical[0], identity.path, true);

  const posts = $('.post.hentry').filter((_, element) => !$(element).closest(ancillary).length
    && normalizeIdentity($(element).children('.post-title.entry-title').text()) === normalizeIdentity(identity.title));
  if (posts.length !== 1) throw new ReviewError('Sarah Lin page has no unique selected series article.');
  const bodies = posts.first().children('.post-body.entry-content');
  if (bodies.length !== 1) throw new ReviewError('Sarah Lin selected article has no unique bibliography body.');
  const body = bodies.first().clone();
  body.find(excluded).remove();

  // Preserve explicit line/paragraph boundaries and opaque link tokens. A link on a
  // different row must never inherit the previous book number. Inline emphasis stays inline.
  if (/[\uE000\uE001]/.test(body.text())) throw new ReviewError('Sarah Lin bibliography contains ambiguous link markers.');
  const anchors: Anchor[] = [];
  body.find('a').each((_, element) => {
    const anchor = $(element), marker = `\uE000${anchors.length}\uE001`;
    anchors.push({ href: anchor.attr('href'), text: inline(anchor.text()) });
    anchor.replaceWith($('<span></span>').text(marker));
  });
  if (anchors.length > 200) throw new ReviewError('Sarah Lin bibliography exceeded the bounded link limit.');
  body.find('br').replaceWith('\n');
  body.find(block).prepend('\n').append('\n');
  const lines = body.text().split('\n').map(inline).filter(Boolean);
  if (lines.length > 500) throw new ReviewError('Sarah Lin bibliography exceeded the bounded row limit.');

  let rows: string[];
  if (identity.section) {
    const sections = lines.flatMap((line, index) => /^Audiobooks\s*:?$/i.test(line) ? [index] : []);
    if (sections.length !== 1) throw new ReviewError('Weirkey requires one explicit Audiobooks section.');
    rows = lines.slice(sections[0] + 1);
  } else {
    const boundary = lines.findIndex(line => stopHeading.test(line));
    const bibliography = boundary < 0 ? lines : lines.slice(0, boundary);
    const start = bibliography.findIndex(line => /^Audiobook\b/i.test(line));
    rows = start < 0 ? [] : bibliography.slice(start);
  }

  const found = new Map<number, SarahLinAudioLead>();
  for (const row of rows) {
    // Only the contiguous, explicitly labelled audio block belongs to this series.
    // Headings, prose, and recommendations end it rather than supplying more numbers.
    if (stopHeading.test(row)) break;
    const match = row.match(identity.section ? /^Book\s+(\d+)\s*:\s*(.*)$/i : /^Audiobook\s+(\d+)\s*:\s*(.*)$/i);
    if (!match) {
      if (collection.test(row) || planned.test(row)) continue;
      if (/^(?:Audio)?Books?\b/i.test(row)) throw new ReviewError('An audio row lacks one explicit integer volume number.');
      break;
    }
    const number = Number(match[1]);
    if (!Number.isInteger(number) || number < 1 || number > 200) throw new ReviewError('Sarah Lin audio volume is outside the supported range.');
    const rowAnchors = [...match[2].matchAll(/\uE000(\d+)\uE001/g)].map(token => anchors[Number(token[1])]);
    const visible = `${match[2]} ${rowAnchors.map(anchor => anchor.text).join(' ')}`;
    if (collection.test(visible) || planned.test(visible)) continue;
    // Unlinked intentions/placeholders and raw text URLs are not observed product links.
    if (!rowAnchors.length) continue;
    if (match[2].replace(/\uE000\d+\uE001/g, '').trim()) {
      throw new ReviewError('Sarah Lin audio link has ambiguous surrounding text.');
    }
    for (const anchor of rowAnchors) {
      let url: URL;
      try { url = new URL(anchor.href ?? ''); } catch { throw new ReviewError('Sarah Lin audio row has no usable retailer link.'); }
      const asin = audioLinkAsin(url.href);
      if (!['audible.com', 'www.audible.com'].includes(url.hostname) || !asin
        || !/^\/pd\/(?:[^/]+\/)?[A-Z0-9]{10}\/?$/.test(url.pathname)) {
        throw new ReviewError('Sarah Lin audio row is not an identified direct US Audible product link.');
      }
      const textUrl = /^https?:\/\//i.test(anchor.text) ? audioLinkAsin(anchor.text) : undefined;
      if (/^https?:\/\//i.test(anchor.text) && textUrl !== asin) {
        throw new ReviewError('Sarah Lin audio link text and destination disagree.');
      }
      url.search = ''; url.hash = '';
      const prior = found.get(number);
      if (prior && prior.asin !== asin || [...found.values()].some(lead => lead.asin === asin && lead.number !== number)) {
        throw new ReviewError('Sarah Lin bibliography assigns conflicting audio identifiers or volume numbers.');
      }
      if (!prior) found.set(number, { seriesId: seed.id, number, asin, url: url.href, sourceUrl: source.href });
    }
    if (found.size > 50) throw new ReviewError('Sarah Lin bibliography exceeded the bounded audio limit.');
  }
  if (!found.size) throw new ReviewError('Sarah Lin bibliography contains no explicitly numbered US audio product links.');
  return [...found.values()].sort((left, right) => left.number - right.number);
}
