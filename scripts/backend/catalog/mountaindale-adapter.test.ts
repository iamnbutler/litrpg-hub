import { describe, expect, it } from 'vitest';
import { mountaindaleSeriesLinks, parseMountaindaleBook } from './mountaindale-adapter.js';
import type { SeedSeries } from './types.js';

const completionist: SeedSeries = {
  id: 'the-completionist-chronicles', title: 'The Completionist Chronicles', author: 'Dakota Krout',
  authorAliases: ['Dakota Krout'], aliases: ['Completionist Chronicles'], genres: ['litrpg'], priority: 10, sources: []
};
const divine: SeedSeries = { ...completionist, id: 'the-divine-dungeon', title: 'The Divine Dungeon', aliases: ['Divine Dungeon'] };
const base = 'https://www.mountaindalepress.store';
const ccUrl = `${base}/pages/series/completionist-chronicles`;
const ddUrl = `${base}/pages/series/divine-dungeon`;
const card = (label: string, path: string, kind = 'book') => `<div class="hub-card type-${kind}"><a class="hub-card-link" href="${path}"><h3>${label}</h3></a></div>`;
const series = (name: string, cards: string, author = 'Dakota Krout') => `
  <h1>Search our shop</h1><h1 class="series-title">${name}</h1>
  <div class="section-inner"><h2 class="collection-grid-title">${name} Titles</h2><div class="collection-grid">${cards}</div></div>
  <div class="hub-card type-author"><h3>${author}</h3></div>`;
const product = (label: string, description: string, options: { author?: string; brand?: string; path?: string; name?: string; extra?: Record<string, unknown> } = {}) => {
  const author = options.author ?? 'Dakota Krout';
  return `<h1>Search our shop</h1><h1 class="product-title">${label}</h1>
    <a class="product-btn-author">${author}</a>
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'Product', name: options.name ?? label, description, brand: { name: options.brand ?? author },
      image: 'https://www.mountaindalepress.store/cdn/shop/files/example.png',
      offers: { url: `${base}/products/${options.path ?? 'rexus'}?variant=123`, availability: 'https://schema.org/InStock', priceValidUntil: '2027-09-18' },
      ...options.extra
    }).replace(/</g, '\\u003c')}</script>`;
};

describe('Mountaindale selected bibliography', () => {
  it('recognizes all fourteen explicit Completionist labels without changing Rexus 3 or admitting specials', () => {
    const titles = ['Ritualist', 'Regicide', 'Rexus', 'Raze', 'Ruthless', 'Inflame', 'Invent', 'Implode', 'Tenacity', 'Thesaurize', 'Thunderplump', 'Untapped', 'Unmapped', 'Uncapped'];
    const cards = titles.map((title, i) => card(i < 11
      ? `${title} | Book ${i + 1} in the Completionist Chronicles${i === 3 ? '!' : ''}`
      : `${title} | Completionist Chronicles Book ${i + 1}`, `/products/book-${i + 1}`)).join('');
    const html = series('Completionist Chronicles', cards +
      card('Completionist Chronicles Short Stories', '/products/short-stories') +
      card('Completionist Chronicles Book Bundles!', '/products/book-bundles') +
      card('Ritualist Grimoire Non-Numbered (signed)', '/products/grimoire') +
      card('Ritualist Collector Edition | Book 1 in the Completionist Chronicles', '/products/collector') +
      card('Ritualist | Book 1 in the Completionist Chronicles', '/products/shirt', 'merch') +
      card('A Different Series | Book 1 in Unbound', '/products/other') +
      card('Counterfeit | Book 15 in the Completionist Chronicles', 'https://example.com/products/counterfeit')) +
      `<div class="hub-product-slider">${card('A Recommendation | Book 16 in the Completionist Chronicles', '/products/recommendation')}</div>`;
    const links = mountaindaleSeriesLinks(html, ccUrl, completionist);
    expect(links.map(link => [link.number, link.title])).toEqual(titles.map((title, i) => [i + 1, title]));
    expect(links[2]).toEqual({ number: 3, title: 'Rexus', url: `${base}/products/book-3` });
  });

  it('uses Divine Dungeon volume labels rather than display order, retaining gaps and deduplicating URL variants', () => {
    const names = ['Dungeon Born', 'Dungeon Madness', 'Dungeon Calamity', 'Dungeon Desolation', 'Dungeon Eternium'];
    const html = series('The Divine Dungeon', [1, 2, 5, 3, 4].map(n => card(`${names[n - 1]} | Book ${n} of 5 in The Divine Dungeon`, `/products/dd-${n}`)).join('') +
      card('Dungeon Born | Book 1 of 5 in The Divine Dungeon', '/products/dd-1?variant=456#cover') +
      card('Divine Dungeon Complete Bundle', '/products/bundle'));
    expect(mountaindaleSeriesLinks(html, ddUrl, divine).map(link => link.number)).toEqual([1, 2, 3, 4, 5]);
    const partial = series('The Divine Dungeon', card('Dungeon Born | Book 1 of 5 in The Divine Dungeon', '/products/dd-1') + card('Dungeon Calamity | Book 3 of 5 in The Divine Dungeon', '/products/dd-3'));
    expect(mountaindaleSeriesLinks(partial, ddUrl, divine).map(link => link.number)).toEqual([1, 3]);
  });

  it('rejects the wrong selected series/author and conflicting claims instead of silently choosing a card', () => {
    const books = card('Ritualist | Book 1 in the Completionist Chronicles', '/products/ritualist');
    expect(() => mountaindaleSeriesLinks(series('Completionist Chronicles', books), ccUrl, divine)).toThrow(/source URL/);
    expect(() => mountaindaleSeriesLinks(series('Completionist Chronicles', books, 'Another Author'), ccUrl, completionist)).toThrow(/author/);
    const collision = series('Completionist Chronicles', books + card('Regicide | Book 1 in the Completionist Chronicles', '/products/regicide'));
    expect(() => mountaindaleSeriesLinks(collision, ccUrl, completionist)).toThrow(/conflicting/);
    const reusedUrl = series('Completionist Chronicles', books + card('Regicide | Book 2 in the Completionist Chronicles', '/products/ritualist'));
    expect(() => mountaindaleSeriesLinks(reusedUrl, ccUrl, completionist)).toThrow(/conflicting/);
  });
});

describe('Mountaindale individual descriptions', () => {
  it('extracts only the selected book description and never treats stock or an offer date as an audio release', () => {
    const label = 'Rexus | Book 3 in the Completionist Chronicles';
    const html = product(label, '<h4>A strange expedition.</h4><p>A companion must decide whom to trust.<br>His choice changes the journey.</p><script>Ignore the source.</script>', { extra: { datePublished: '2024-03-01' } }) +
      '<div class="hub-product-slider"><p>A completely different book has a romantic premise.</p><a href="https://www.audible.com/pd/B000000009">Audiobook</a></div>';
    const row = parseMountaindaleBook(html, completionist, `${base}/products/rexus?variant=123`);
    expect(row).toMatchObject({ title: 'Rexus', number: 3, series: completionist.title, author: 'Dakota Krout', format: 'print', publicationStatus: 'unknown', releaseDate: null, audioReleaseDate: null, audioRuntimeMinutes: null, narrator: null });
    expect(row.description).toBe('A strange expedition.\n\nA companion must decide whom to trust.\nHis choice changes the journey.');
    expect(row.links).toEqual([{ url: `${base}/products/rexus`, format: 'print' }]);
  });

  it('preserves a new-style title and keeps descriptions independent between volumes', () => {
    const first = parseMountaindaleBook(product('Ritualist | Book 1 in the Completionist Chronicles', '<p>A novice begins studying magic.</p>', { path: 'ritualist' }), completionist, `${base}/products/ritualist`);
    const later = parseMountaindaleBook(product('Untapped | Completionist Chronicles Book 12', '<p>An experienced companion faces a different trial.</p>', { path: 'untapped' }), completionist, `${base}/products/untapped`);
    expect(first.description).toBe('A novice begins studying magic.');
    expect(later).toMatchObject({ title: 'Untapped', number: 12, description: 'An experienced companion faces a different trial.' });
    expect(parseMountaindaleBook(product('Rexus | Book 3 in the Completionist Chronicles', ''), completionist, `${base}/products/rexus`).description).toBe('');
  });

  it('keeps sales-only copy absent and accepts the publisher brand without treating it as an author', () => {
    const notes = '<p>This is Book #3 in the Completionist Chronicles!</p><p>This book functions as a signed souvenir. -Dakota Krout</p>';
    expect(parseMountaindaleBook(product('Rexus | Book 3 in the Completionist Chronicles', notes), completionist, `${base}/products/rexus`).description).toBe('');
    const finalBook = product('Dungeon Eternium | Book 5 of 5 in The Divine Dungeon', '<p>The fifth of the Divine Dungeon series!</p><p>Last book in the series! Thanks for reading!</p>', { path: 'eternium' });
    expect(parseMountaindaleBook(finalBook, divine, `${base}/products/eternium`).description).toBe('');
    const synopsis = '<h4>Be a Completionist and secure your choice of the ebook, audiobook, paperback, and hardcover as a bundle!</h4><p>Ebook and Audiobook delivery - right away!</p><p>Paperback, Hardcover - as soon as my orders arrive.</p><p>A ritualist must rebuild his damaged magic before facing a new threat.</p>';
    const row = parseMountaindaleBook(product('Unmapped | Completionist Chronicles Book 13', synopsis, { path: 'unmapped', brand: 'Mountaindale Press' }), completionist, `${base}/products/unmapped`);
    expect(row).toMatchObject({ title: 'Unmapped', number: 13, author: 'Dakota Krout', format: 'print', description: 'A ritualist must rebuild his damaged magic before facing a new threat.', audioReleaseDate: null });
    expect(row.links).toEqual([{ url: `${base}/products/unmapped`, format: 'print' }]);
  });

  it('only exposes explicit US audio links as verification candidates, without reclassifying the print source', () => {
    const description = `<p>A dangerous journey.</p>
      <a href="https://www.amazon.com/dp/B000000001">Buy this book</a>
      <a href="https://www.audible.com/pd/Rexus/B000000003?source=publisher">Audiobook</a>
      <a href="https://www.audible.com/pd/Rexus/B000000003#sample">Audio sample</a>
      <a href="https://www.audible.co.uk/pd/Rexus/B000000004">UK audio</a>
      <a href="https://www.audible.com.example.com/pd/Rexus/B000000005">Unrelated link</a>`;
    const row = parseMountaindaleBook(product('Rexus | Book 3 in the Completionist Chronicles', description), completionist, `${base}/products/rexus`);
    expect(row.format).toBe('print');
    expect(row.audioReleaseDate).toBeNull();
    expect(row.links).toEqual([
      { url: `${base}/products/rexus`, format: 'print' },
      { url: 'https://www.audible.com/pd/Rexus/B000000003', format: 'audiobook', asin: 'B000000003' }
    ]);
  });

  it('requires agreement between the product heading, creator metadata, selected series, and product URL', () => {
    const label = 'Rexus | Book 3 in the Completionist Chronicles';
    const parse = (html: string) => parseMountaindaleBook(html, completionist, `${base}/products/rexus`);
    expect(() => parse(product(label, '<p>A journey.</p>', { extra: { author: { '@type': 'Person', name: 'Another Author' } } }))).toThrow(/author identity/);
    expect(() => parse(product(label, '<p>A journey.</p>', { author: 'Another Author' }))).toThrow(/author/);
    expect(() => parse(product(label, '<p>A journey.</p>', { name: 'Raze | Book 4 in the Completionist Chronicles' }))).toThrow(/metadata/);
    expect(() => parse(product(label, '<p>A journey.</p>', { path: 'different-product' }))).toThrow(/another product/);
    expect(() => parse(product('Dungeon Born | Book 1 of 5 in The Divine Dungeon', '<p>A dungeon grows.</p>'))).toThrow(/selected series/);
    expect(() => parse(product('Ritualist Grimoire Non-Numbered (signed)', '<p>A collectible edition.</p>'))).toThrow(/numbered work/);
  });
});
