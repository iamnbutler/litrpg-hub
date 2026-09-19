import { describe, expect, it } from 'vitest';
import { parseSarahLinAudioLeads } from './sarah-lin-adapter.js';
import { ReviewError, type SeedSeries } from './types.js';

// Synthetic layout fixtures: no author descriptions, comment bodies, or retained HTML.
const weirkey: SeedSeries = {
  id: 'the-weirkey-chronicles', title: 'The Weirkey Chronicles', author: 'Sarah Lin', authorAliases: ['Sarah Lin'],
  aliases: [], genres: ['progression', 'cultivation'], priority: 1, sources: []
};
const street: SeedSeries = { ...weirkey, id: 'street-cultivation', title: 'Street Cultivation' };
const origin = 'https://sarahlinauthor.blogspot.com';
const path = (seed: SeedSeries) => `/p/${seed.id}.html`;
const source = (seed: SeedSeries) => `${origin}${path(seed)}?m=0`;
const asin = (number: number) => `B${String(number).padStart(9, '0')}`;
const audioUrl = (number: number) => `https://www.audible.com/pd/${asin(number)}`;
const link = (href: string, label = href) => `<a href="${href}">${label}</a>`;
const row = (number: number, seed = weirkey, href = audioUrl(number), label = href) => `${seed.id === weirkey.id ? 'Book' : 'Audiobook'} ${number}: ${link(href, label)}<br>`;
const audioSection = (rows: string) => `<div><span>Audiobooks</span><br>${rows}</div>`;
function page(seed: SeedSeries, contents: string) {
  return `<html><head><title>Sarah Lin's Books: ${seed.title}</title>
    <link rel="canonical" href="http://sarahlinauthor.blogspot.com${path(seed)}"></head><body>
    <header><h1 class="title">Sarah Lin's Books</h1><nav><a href="${origin}/p/new-game-minus.html">New Game Minus</a></nav></header>
    <main><div class="widget Blog" id="Blog1"><div class="post hentry"><h3 class="post-title entry-title">${seed.title}</h3>
      <div class="post-body entry-content">${contents}</div>
      <div class="post-footer"><p>Posted in 2020. Narrator mentioned elsewhere.</p></div>
      <div class="comments">${audioSection(row(99))}</div>
    </div></div></main><aside>${audioSection(row(98))}</aside></body></html>`;
}
const ebookSection = `<p>A short synthetic introduction.</p><div>Ebooks</div>
  <div>Book 1: ${link('https://www.amazon.com/gp/product/B000000101/')}<br>
  Book 2: ${link('https://www.amazon.com/dp/B000000102')}<br>
  WIP Book 3: ${link('https://www.patreon.com/sarahlin', 'Patreon')}</div>`;

describe('bounded Sarah Lin author audio discovery', () => {
  it('reads five explicit Weirkey audio labels while keeping ebooks and an unrecorded sixth separate', () => {
    const html = page(weirkey, ebookSection + audioSection(Array.from({ length: 5 }, (_, i) => row(i + 1)).join('') + 'Book 6: Will be recorded!'));
    const leads = parseSarahLinAudioLeads(html, weirkey, source(weirkey));
    expect(leads.map(lead => [lead.number, lead.asin])).toEqual([1, 2, 3, 4, 5].map(n => [n, asin(n)]));
    expect(leads[0]).toEqual({ seriesId: weirkey.id, number: 1, asin: asin(1), url: audioUrl(1), sourceUrl: source(weirkey) });
    expect(Object.keys(leads[0]).sort()).toEqual(['asin', 'number', 'seriesId', 'sourceUrl', 'url']);
    expect(JSON.stringify(leads)).not.toMatch(/Narrator|2020|B000000101|B000000102/);
  });

  it('reads Street Cultivation audio labels without treating its completed ebook trilogy as three recordings', () => {
    const html = page(street, `<div>A synthetic series introduction.</div>
      Completed Book 1: ${link('https://www.amazon.com/dp/B000000101')}<br>
      Completed Book 2: ${link('https://www.amazon.com/dp/B000000102')}<br>
      Completed Book 3: ${link('https://www.amazon.com/dp/B000000103')}<br>
      ${row(1, street, 'https://www.audible.com/pd/Example-Audiobook/1541438200')}${row(2, street)}
      Description: Synthetic source copy must not be returned.<br>${row(3, street)}`);
    const leads = parseSarahLinAudioLeads(html, street, source(street));
    expect(leads.map(lead => [lead.number, lead.asin])).toEqual([[1, '1541438200'], [2, asin(2)]]);
    expect(leads[0].url).toBe('https://www.audible.com/pd/Example-Audiobook/1541438200');
    expect(JSON.stringify(leads)).not.toContain('Synthetic source copy');
  });

  it('uses explicit numbers after reordering and does not fill missing volumes', () => {
    const html = page(weirkey, audioSection(row(5) + row(2)));
    expect(parseSarahLinAudioLeads(html, weirkey, source(weirkey)).map(lead => lead.number)).toEqual([2, 5]);
  });

  it('preserves inline formatting without joining links from a different line', () => {
    const html = page(weirkey, `<p>Audiobooks</p><p><b>Book 2</b>: <span>${link(audioUrl(2), 'Listen')}</span></p>
      <p>Book 3:</p><p>${link(audioUrl(3))}</p><p>${row(4)}</p>`);
    expect(parseSarahLinAudioLeads(html, weirkey, source(weirkey)).map(lead => lead.number)).toEqual([2]);
  });

  it('ignores breadcrumb, sidebar, comment, recommendation, and quoted audio links', () => {
    const html = page(weirkey, `<blockquote>${audioSection(row(91))}</blockquote>
      <div class="recommendations">${audioSection(row(92))}</div>${audioSection(row(1))}
      <div class="comment-content">${row(93)}</div><h2>Recommendations</h2>${row(94)}`);
    expect(parseSarahLinAudioLeads(html, weirkey, source(weirkey)).map(lead => lead.number)).toEqual([1]);
  });

  it('does not start a Street list in recommendations after the selected bibliography', () => {
    const html = page(street, `Completed Book 1: ${link('https://www.amazon.com/dp/B000000101')}<br>
      <h2>Recommendations</h2>${row(1, street)}`);
    expect(() => parseSarahLinAudioLeads(html, street, source(street))).toThrow(/no explicitly numbered/);
  });

  it('stops at unrelated prose instead of continuing into another series block', () => {
    const html = page(weirkey, audioSection(row(1) + '<p>Other stories from another series.</p>' + row(2)));
    expect(parseSarahLinAudioLeads(html, weirkey, source(weirkey)).map(lead => lead.number)).toEqual([1]);
  });

  it('keeps planned audio, WIP, and collections out even when they contain product links', () => {
    const html = page(weirkey, audioSection(row(1) + `Book 2: Will be recorded! ${link(audioUrl(2))}<br>
      WIP Book 3: ${link(audioUrl(3))}<br>Books 1–3 omnibus: ${link(audioUrl(90))}<br>
      ${row(4, weirkey, audioUrl(4), 'Box set')}${row(5)}`));
    expect(parseSarahLinAudioLeads(html, weirkey, source(weirkey)).map(lead => lead.number)).toEqual([1, 5]);
  });

  it('deduplicates the same numbered identifier and removes link tracking', () => {
    const html = page(weirkey, audioSection(row(1, weirkey, `${audioUrl(1)}?ref=example#sample`, 'Listen') + row(1)));
    expect(parseSarahLinAudioLeads(html, weirkey, source(weirkey))).toEqual([
      { seriesId: weirkey.id, number: 1, asin: asin(1), url: audioUrl(1), sourceUrl: source(weirkey) }
    ]);
  });

  it('rejects different identifiers for one volume or one identifier assigned to two volumes', () => {
    for (const rows of [row(1) + row(1, weirkey, audioUrl(2)), row(1) + row(2, weirkey, audioUrl(1))]) {
      expect(() => parseSarahLinAudioLeads(page(weirkey, audioSection(rows)), weirkey, source(weirkey))).toThrow(/conflicting/);
    }
  });

  it('rejects conflicting destination and displayed product identifiers', () => {
    const html = page(weirkey, audioSection(row(1, weirkey, audioUrl(1), audioUrl(2))));
    expect(() => parseSarahLinAudioLeads(html, weirkey, source(weirkey))).toThrow(/text and destination disagree/);
  });

  it('rejects merged volume rows instead of assigning both products to the first volume', () => {
    const html = page(weirkey, audioSection(`Book 1: ${link(audioUrl(1))}Book 2: ${link(audioUrl(2))}`));
    expect(() => parseSarahLinAudioLeads(html, weirkey, source(weirkey))).toThrow(/ambiguous surrounding text/);
  });

  it.each([
    'https://www.amazon.com/dp/B000000001',
    'https://www.audible.co.uk/pd/B000000001',
    'https://www.audible.com.evil.example/pd/B000000001',
    'https://reader:password@www.audible.com/pd/B000000001',
    'http://www.audible.com/pd/B000000001',
    'https://www.audible.com:8443/pd/B000000001',
    'https://amzn.to/example',
    'https://www.audible.com/series/B000000001',
    'https://www.audible.com/pd/B000000001/extra'
  ])('rejects an unsupported, non-US, or unsafe audio destination: %s', href => {
    expect(() => parseSarahLinAudioLeads(page(weirkey, audioSection(row(1, weirkey, href))), weirkey, source(weirkey))).toThrow(ReviewError);
  });

  it('requires actual anchors instead of turning raw URLs or planned recordings into leads', () => {
    for (const rows of [`Book 1: ${audioUrl(1)}`, 'Book 1: Will be recorded!', 'Book 1: Coming soon']) {
      expect(() => parseSarahLinAudioLeads(page(weirkey, audioSection(rows)), weirkey, source(weirkey))).toThrow(/no explicitly numbered/);
    }
  });

  it('requires a unique audio section for Weirkey and never uses the ebook section', () => {
    for (const contents of [ebookSection, audioSection(row(1)) + audioSection(row(2)), `<div>Ebooks</div>${row(1)}`]) {
      expect(() => parseSarahLinAudioLeads(page(weirkey, contents), weirkey, source(weirkey))).toThrow(/explicit Audiobooks section/);
    }
  });

  it.each(['Book 0', 'Book 201', 'Book -1', 'Book 1.5', 'Book I'])('rejects unsupported volume labels: %s', label => {
    expect(() => parseSarahLinAudioLeads(page(weirkey, audioSection(`${label}: ${link(audioUrl(1))}`)), weirkey, source(weirkey))).toThrow(ReviewError);
  });

  it('requires the selected series, author, source path, and site heading to agree', () => {
    const html = page(weirkey, audioSection(row(1)));
    for (const seed of [{ ...weirkey, id: 'other-series' }, { ...weirkey, id: 'toString' }, { ...weirkey, title: 'Other Series' }, { ...weirkey, author: 'Other Author' }, { ...weirkey, authorAliases: [] }]) {
      expect(() => parseSarahLinAudioLeads(html, seed, source(weirkey))).toThrow(ReviewError);
    }
    expect(() => parseSarahLinAudioLeads(html, street, source(street))).toThrow(ReviewError);
    expect(() => parseSarahLinAudioLeads(html.replace('<h1 class="title">Sarah Lin', '<h1 class="title">Other Author'), weirkey, source(weirkey))).toThrow(ReviewError);
  });

  it.each([
    'http://sarahlinauthor.blogspot.com/p/the-weirkey-chronicles.html',
    'https://other.example/p/the-weirkey-chronicles.html',
    'https://sarahlinauthor.blogspot.com/p/my-work.html',
    'https://sarahlinauthor.blogspot.com/2024/',
    'https://sarahlinauthor.blogspot.com/p/the-weirkey-chronicles.html?m=1',
    'https://sarahlinauthor.blogspot.com/p/the-weirkey-chronicles.html?redirect=other',
    'https://sarahlinauthor.blogspot.com/p/the-weirkey-chronicles.html#comments'
  ])('rejects an unreviewed source variant: %s', url => {
    expect(() => parseSarahLinAudioLeads(page(weirkey, audioSection(row(1))), weirkey, url)).toThrow(ReviewError);
  });

  it('accepts the observed HTTP canonical only as identity metadata, not a fetch target', () => {
    const html = page(weirkey, audioSection(row(1)));
    expect(parseSarahLinAudioLeads(html, weirkey, `${origin}${path(weirkey)}`)[0].sourceUrl).toBe(`${origin}${path(weirkey)}`);
    for (const changed of [html.replace('http://sarahlinauthor.blogspot.com/p/the-weirkey-chronicles.html', 'http://other.example/p/the-weirkey-chronicles.html'), html.replace('rel="canonical"', 'rel="alternate"')]) {
      expect(() => parseSarahLinAudioLeads(changed, weirkey, source(weirkey))).toThrow(ReviewError);
    }
  });

  it('rejects duplicate selected articles and interstitials', () => {
    const html = page(weirkey, audioSection(row(1)));
    expect(() => parseSarahLinAudioLeads(html + html, weirkey, source(weirkey))).toThrow(ReviewError);
    expect(() => parseSarahLinAudioLeads('<html><title>Access denied</title></html>', weirkey, source(weirkey))).toThrow(ReviewError);
  });

  it('enforces bounded work discovery without truncating an oversized list', () => {
    const html = page(weirkey, audioSection(Array.from({ length: 51 }, (_, index) => row(index + 1)).join('')));
    expect(() => parseSarahLinAudioLeads(html, weirkey, source(weirkey))).toThrow(/bounded audio limit/);
  });
});
