import { describe, expect, it } from 'vitest';
import { grandGameSeriesBooks, parseGrandGameBook, parseNovaRoma } from './author-series.js';
import { ReviewError, type SeedSeries } from './types.js';

const grand: SeedSeries = {
  id: 'the-grand-game', title: 'The Grand Game', author: 'Tom Elliot', authorAliases: ['Tom Elliot'],
  aliases: [], genres: ['litrpg'], priority: 1, sources: []
};
const nova: SeedSeries = {
  id: 'portal-to-nova-roma', title: 'Portal to Nova Roma', author: 'J.R. Mathews', authorAliases: ['J.R. Mathews'],
  aliases: [], genres: ['litrpg'], priority: 1, sources: []
};

const grandCard = (number: number, title = `Grand Volume ${number}`, slug = `volume-${number}`) => `<article class="kt-blocks-post-grid-item book-category-the-grand-game book-tag-book-${number}">
  <a href="/book-tag/book-${number}/">Book ${number}</a>
  <h2 class="entry-title"><a href="/book/${slug}/">${title}</a></h2>
  <img src="https://tomlitrpg.com/covers/${number}.jpg"><p>A carousel review should not become the source synopsis.</p>
</article>`;

const grandBook = (title = 'The Grand Game') => `<html><head>
  <link rel="canonical" href="https://tomlitrpg.com/book/the-grand-game/">
  <meta property="og:image" content="https://tomlitrpg.com/covers/one.jpg">
  <meta property="article:published_time" content="2021-04-01T00:00:00Z">
</head><body><main><div class="entry-content">
  <h2 class="wp-block-post-title">${title}</h2>
  <div class="kb-dynamic-html">
    <p>A player enters a dangerous world.</p><p>He must find allies.<br>Enemies are watching.</p>
    <p>The rules keep changing.</p><p>A difficult choice awaits.</p><p>The stakes rise.</p>
    <p>Another challenge begins.</p><p>His journey continues.</p>
    <div class="wp-block-group"><p>Subscribe for new posts.</p></div>
    <div class="wpsr"><p>Reader: the most brilliant book ever written.</p></div>
  </div>
  <div class="kb-dynamic-html"><p>This later widget is not the book synopsis.</p></div>
  <div><a href="https://amzn.to/ebookLead">AMAZON</a><a href="https://amzn.to/audioLead">AUDIBLE</a>
    <a href="https://amzn.to/ukAudio">AUDIBLE (UK)</a><a href="https://amzn.to/ukBook">AMAZON (UK)</a></div>
  <div class="wpsr-review"><a href="https://amzn.to/reviewerLink">AUDIBLE</a></div>
  <article class="kt-blocks-post-grid-item"><h2 class="entry-title">Other book</h2><a href="https://amzn.to/otherAudio">AUDIBLE</a></article>
  <p>Paperback published April 1, 2021. Narrated by A General Footer Credit.</p>
</div></main></body></html>`;

const novaTitles = ['Portal to Nova Roma', 'Portal to Nova Roma, Venice', 'Portal to Nova Roma, The Rhine', 'Portal to Nova Roma, Paris', 'Portal to Nova Roma, Empire'];
const audioAsins = ['B0BCH43V6V', 'B0BJSF2FBB', 'B0BW4WDCWK', 'B0H7SH5DYS'];
const novaCard = (number: number, title = novaTitles[number - 1]) => `<div class="list-item">
  <img src="data:image/gif;base64,placeholder" data-src="https://images.squarespace-cdn.com/covers/${number}.jpg">
  <h2 class="list-item-content__title">Portal to Nova Roma #${number}</h2>
  <div class="list-item-content__description"><p>Book ${number} of 5: ${title}</p></div>
  <a href="https://www.amazon.com/dp/B${String(number).padStart(9, '0')}/ref=tracking?tag=example#fragment">Buy Now</a>
</div>`;
const novaOmnibus = `<div class="list-item"><h2 class="list-item-content__title">Portal to Nova Roma Omnibus</h2>
  <div class="list-item-content__description"><p>Compilation of Books 1-3</p></div>
  <a href="https://www.amazon.com/dp/B0GSGG3G7T">Buy Now</a></div>`;
const novaAudio = (number: number, href = audioAsins[number - 1] ? `https://www.audible.com/pd/Book-${number}-Audiobook/${audioAsins[number - 1]}?ref=tracking#fragment` : '') => `<div class="sqs-html-content">
  <p><strong>Portal to Nova Roma #${number} Audiobook</strong></p><p>Book ${number} of 5: ${novaTitles[number - 1]}</p>
</div><div class="sqs-block-button"><a href="${href}">${href ? 'Buy Now' : 'Available September 2026'}</a><style>.button { color: black }</style></div>`;
const novaAudioOmnibus = `<div class="sqs-html-content"><p><strong>Portal to Nova Roma Omnibus Audiobook</strong></p>
  <p>Books 1-3: Portal to Nova Roma</p></div><div class="sqs-block-button"><a href="https://www.audible.com/pd/Omnibus/B0GTBJS911?tag=omni">Buy Now</a></div>`;

function novaPage(cards = [novaCard(1), novaCard(2), novaCard(3), novaOmnibus, novaCard(4), novaCard(5)].join(''),
  audio = [novaAudio(1), novaAudio(2), novaAudio(3), novaAudioOmnibus, novaAudio(4), novaAudio(5)].join('')): string {
  return `<html><head><link rel="canonical" href="https://jrmathewsauthor.com/portal-to-nova-roma"></head><body><main><section id="page">
    <section id="introduction"><div class="sqs-html-content"><h2>Portal to Nova Roma</h2></div>
      <div class="sqs-html-content"><p><strong>*** SERIES NOW COMPLETE Spring 2026 ***</strong></p>
      <p>An intelligence seeks another world.<br><br>A threatened city becomes his home.</p>
      <p>He must learn to survive.</p><blockquote><p>A reader calls it the best ending ever.</p></blockquote>
      <p>Cover art by An Artist https://example.com/artist</p><p>Narrated by A Narrator https://example.com/narrator</p></div></section>
    <section id="ebook-cards">${cards}</section>
    <section id="audio"><div class="sqs-html-content"><h2>Shop <strong>Audiobooks</strong> #1-3:</h2></div>${audio}</section>
    <section id="reviews"><div class="sqs-html-content"><h3>Highlighted Reviews</h3>
      <p>A reviewer praises all five books and their ending.</p><p>- A Reader</p></div></section>
  </section></main><footer><section><div class="sqs-html-content"><h2><a href="/portal-to-nova-roma">Portal to Nova Roma</a></h2>
    <p>Subscribe for more news.</p></div></section></footer></body></html>`;
}

describe('The Grand Game author pages', () => {
  it('enumerates only the eight observed taxonomy cards without inventing book nine', () => {
    const html = '<main>' + Array.from({ length: 8 }, (_, index) => grandCard(index + 1)).reverse().join('')
      + '<a href="/book/nine/">Book 9 news</a>'
      + '<article class="book-category-other-series book-tag-book-9"><h2 class="entry-title">Other Book 9</h2></article></main>';
    const results = grandGameSeriesBooks(html, grand);
    expect(results.map(result => result.book.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(results[0]).toMatchObject({ url: 'https://tomlitrpg.com/book/volume-1/', book: {
      title: 'Grand Volume 1', series: grand.title, author: grand.author, format: 'unknown', description: '',
      releaseDate: null, audioReleaseDate: null, narrator: null, links: []
    } });
  });

  it('uses explicit taxonomy rather than article order or numbers in a title', () => {
    const result = grandGameSeriesBooks(grandCard(4, 'The Ninth Challenge', 'challenge') + grandCard(2), grand);
    expect(result.map(entry => [entry.book.number, entry.book.title])).toEqual([[2, 'Grand Volume 2'], [4, 'The Ninth Challenge']]);
  });

  it('excludes collections without assigning their range to a numbered work', () => {
    const results = grandGameSeriesBooks(grandCard(1) + grandCard(2, 'The Grand Game Omnibus Books 1–3'), grand);
    expect(results.map(result => result.book.number)).toEqual([1]);
  });

  it('requires consistent explicit taxonomy and an author-owned book URL', () => {
    expect(() => grandGameSeriesBooks(grandCard(1).replace('>Book 1<', '>Book 9<'), grand)).toThrow(ReviewError);
    expect(() => grandGameSeriesBooks(grandCard(1).replace('book-tag-book-1', 'book-tag-book-9'), grand)).toThrow(ReviewError);
    expect(() => grandGameSeriesBooks(grandCard(1).replace('href="/book/volume-1/"', 'href="https://other.example/book/one/"'), grand)).toThrow(ReviewError);
    expect(() => grandGameSeriesBooks('<article class="book-category-the-grand-game"><h2 class="entry-title">Book 1</h2></article>', grand)).toThrow(ReviewError);
  });

  it('deduplicates repeated cards but flags conflicting numbers, titles, or book URLs', () => {
    expect(grandGameSeriesBooks(grandCard(1) + grandCard(1), grand)).toHaveLength(1);
    expect(() => grandGameSeriesBooks(grandCard(1) + grandCard(1, 'Different Book'), grand)).toThrow(ReviewError);
    expect(() => grandGameSeriesBooks(grandCard(1) + grandCard(2, 'Second', 'volume-1'), grand)).toThrow(ReviewError);
  });

  it('reads the first synopsis block direct paragraphs and excludes subscriptions and reader feedback', () => {
    const book = parseGrandGameBook(grandBook(), grand, 1);
    expect(book.description).toBe('A player enters a dangerous world.\n\nHe must find allies.\nEnemies are watching.\n\nThe rules keep changing.\n\nA difficult choice awaits.\n\nThe stakes rise.\n\nAnother challenge begins.\n\nHis journey continues.');
    expect(book.description).not.toMatch(/Subscribe|brilliant|widget/);
    expect(book.coverUrl).toBe('https://tomlitrpg.com/covers/one.jpg');
  });

  it('returns only the explicitly US-labelled observed short-link lead without audio facts', () => {
    const book = parseGrandGameBook(grandBook(), grand, 1);
    expect(book.links).toEqual([{ url: 'https://amzn.to/audioLead', format: 'audiobook' }]);
    expect(book).toMatchObject({ format: 'unknown', releaseDate: null, publicationStatus: 'unknown', narrator: null, audioReleaseDate: null, audioRuntimeMinutes: null });
  });

  it('takes volume identity from the retained parent argument and refuses a missing synopsis or invalid number', () => {
    expect(parseGrandGameBook(grandBook('A Scion’s Duty'), grand, 6).number).toBe(6);
    expect(() => parseGrandGameBook(grandBook(), grand, NaN)).toThrow(ReviewError);
    expect(() => parseGrandGameBook(grandBook(), grand, 0)).toThrow(ReviewError);
    expect(() => parseGrandGameBook('<main><h2 class="wp-block-post-title">The Grand Game</h2><div class="wpsr"><p>Only feedback</p></div></main>', grand, 1)).toThrow(ReviewError);
  });

  it('rejects the wrong selected series, author, canonical page, and omnibus book', () => {
    expect(() => grandGameSeriesBooks(grandCard(1), { ...grand, title: 'Another Series' })).toThrow(ReviewError);
    expect(() => grandGameSeriesBooks(grandCard(1), { ...grand, author: 'Another Author' })).toThrow(ReviewError);
    expect(() => parseGrandGameBook(grandBook(), { ...grand, authorAliases: ['Another Author'] }, 1)).toThrow(ReviewError);
    expect(() => parseGrandGameBook(grandBook().replace('https://tomlitrpg.com/book/the-grand-game/', 'https://other.example/book/the-grand-game/'), grand, 1)).toThrow(ReviewError);
    expect(() => parseGrandGameBook(grandBook('The Grand Game Omnibus'), grand, 1)).toThrow(ReviewError);
  });
});

describe('Portal to Nova Roma author bibliography', () => {
  it('returns five individually numbered ebook works, excluding the interleaved omnibus', () => {
    const books = parseNovaRoma(novaPage(), nova);
    expect(books.map(book => [book.number, book.title])).toEqual(novaTitles.map((title, index) => [index + 1, title]));
    expect(books.every(book => book.series === nova.title && book.author === nova.author && book.format === 'ebook')).toBe(true);
    expect(books[0].coverUrl).toBe('https://images.squarespace-cdn.com/covers/1.jpg');
    expect(books[0].links.find(link => link.format === 'ebook')).toEqual({ url: 'https://www.amazon.com/dp/B000000001', format: 'ebook', asin: 'B000000001' });
  });

  it('attributes only the first-book premise and excludes completion banners, credits, reviews, and footers', () => {
    const books = parseNovaRoma(novaPage(), nova);
    expect(books[0].description).toBe('An intelligence seeks another world.\n\nA threatened city becomes his home.\n\nHe must learn to survive.');
    expect(books.slice(1).map(book => book.description)).toEqual(['', '', '', '']);
    expect(books.map(book => book.description).join(' ')).not.toMatch(/complete|artist|narrator|reviewer|reader|subscribe/i);
  });

  it('associates US audio product IDs with explicit cards across the omnibus boundary and strips tracking', () => {
    const books = parseNovaRoma(novaPage(), nova);
    expect(books.map(book => book.links.filter(link => link.format === 'audiobook').map(link => link.asin))).toEqual(audioAsins.map(asin => [asin]).concat([[]]));
    expect(books[2].links.find(link => link.format === 'audiobook')).toEqual({
      url: 'https://www.audible.com/pd/Book-3-Audiobook/B0BW4WDCWK', format: 'audiobook', asin: 'B0BW4WDCWK'
    });
    expect(books.flatMap(book => book.links).some(link => link.asin === 'B0GTBJS911')).toBe(false);
  });

  it('leaves the fifth audio unresolved when only a month and an empty buy link are present', () => {
    const fifth = parseNovaRoma(novaPage(), nova)[4];
    expect(fifth.links.filter(link => link.format === 'audiobook')).toEqual([]);
    expect(fifth).toMatchObject({ format: 'ebook', releaseDate: null, publicationStatus: 'unknown', narrator: null, audioReleaseDate: null, audioRuntimeMinutes: null });
  });

  it('does not derive narrator, release dates, or verified audio from ebook metadata or a completed-series notice', () => {
    const html = novaPage().replace('</head>', '<meta property="article:published_time" content="2026-05-01T00:00:00Z"></head>');
    const books = parseNovaRoma(html, nova);
    expect(books.every(book => book.releaseDate === null && book.audioReleaseDate === null && book.narrator === null && book.publicationStatus === 'unknown')).toBe(true);
  });

  it('never fills omitted volumes from an “of 5” count', () => {
    const books = parseNovaRoma(novaPage(novaCard(1) + novaCard(3), novaAudio(1) + novaAudio(3)), nova);
    expect(books.map(book => book.number)).toEqual([1, 3]);
  });

  it('ignores unrelated series cards, UK products, and ASIN-like URLs on unrelated hosts', () => {
    const other = novaCard(1).replaceAll('Portal to Nova Roma', 'Different Series');
    const badLinks = novaAudio(2, 'https://www.audible.co.uk/pd/Title/B0BJSF2FBB')
      + novaAudio(3, 'https://www.audible.com.evil.example/pd/Title/B0BW4WDCWK');
    const books = parseNovaRoma(novaPage(novaCard(1) + novaCard(2) + novaCard(3) + other, novaAudio(1) + badLinks), nova);
    expect(books.map(book => book.number)).toEqual([1, 2, 3]);
    expect(books.slice(1).flatMap(book => book.links).filter(link => link.format === 'audiobook')).toEqual([]);
  });

  it('clears the prior audio-card association for an unrelated text block and for a new section', () => {
    const foreign = '<div class="sqs-html-content"><p>Another author’s recommendation</p></div><div class="sqs-block-button"><a href="https://www.audible.com/pd/Other/B000000099">Buy Now</a></div>';
    const html = novaPage(novaCard(1), novaAudio(1) + foreign).replace('</main>', '<section><div class="sqs-block-button"><a href="https://www.audible.com/pd/Other/B000000098">Buy Now</a></div></section></main>');
    expect(parseNovaRoma(html, nova)[0].links.filter(link => link.format === 'audiobook').map(link => link.asin)).toEqual([audioAsins[0]]);
  });

  it('rejects mismatched ebook numbering and contradictory audio card titles instead of guessing', () => {
    expect(() => parseNovaRoma(novaPage(novaCard(1).replace('Book 1 of 5:', 'Book 2 of 5:'), ''), nova)).toThrow(ReviewError);
    expect(() => parseNovaRoma(novaPage(novaCard(1), novaAudio(1).replace('Book 1 of 5:', 'Book 2 of 5:')), nova)).toThrow(ReviewError);
    expect(() => parseNovaRoma(novaPage(novaCard(1), novaAudio(1).replace('Book 1 of 5: Portal to Nova Roma', 'Book 1 of 5: Portal to Nova Roma, Wrong Subtitle')), nova)).toThrow(ReviewError);
  });

  it('rejects wrong seeds, foreign canonical pages, and a footer link posing as the series introduction', () => {
    expect(() => parseNovaRoma(novaPage(), { ...nova, title: 'Jake’s Magical Market' })).toThrow(ReviewError);
    expect(() => parseNovaRoma(novaPage(), { ...nova, author: 'Another Author' })).toThrow(ReviewError);
    expect(() => parseNovaRoma(novaPage(), { ...nova, authorAliases: ['Another Author'] })).toThrow(ReviewError);
    expect(() => parseNovaRoma(novaPage().replace('https://jrmathewsauthor.com/portal-to-nova-roma', 'https://jrmathewsauthor.com/jakes-magical-market'), nova)).toThrow(ReviewError);
    expect(() => parseNovaRoma(novaPage().replace('<h2>Portal to Nova Roma</h2>', '<h2>Other Series</h2>'), nova)).toThrow(ReviewError);
  });
});
