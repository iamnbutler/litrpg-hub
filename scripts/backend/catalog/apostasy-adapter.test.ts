import { describe, expect, it } from 'vitest';
import { parseDivineApostasy } from './apostasy-adapter.js';
import { ReviewError, type SeedSeries } from './types.js';

const seed: SeedSeries = {
  id: 'divine-apostasy', title: 'Divine Apostasy', author: 'A. F. Kay', authorAliases: ['A. F. Kay', 'A.F. Kay'],
  aliases: [], genres: ['litrpg'], priority: 1, sources: []
};
const authorFooter = '<footer><p data-aid="FOOTER_COPYRIGHT_RENDERED">Copyright © 2019 A. F. Kay - All Rights Reserved.</p></footer>';
const recap = (title: string, component: number) => `<div>
  <img data-aid="ABOUT_IMAGE_RENDERED${component}" src="//isteam.wsimg.com/covers/${component}.jpg">
  <div><h4 data-aid="ABOUT_HEADLINE_RENDERED${component}">${title} - Summary</h4>
    <div data-aid="ABOUT_DESCRIPTION_RENDERED${component}"><p>This recap reveals the ending and every major twist.</p>
      <p>The protagonist wins the final battle, and an ally dies.</p>
      <a href="https://www.audible.com/pd/Unrelated-Book/B000000099">Another audio mentioned in the recap</a></div>
  </div></div>`;
const recapPage = (cards: string) => `<html><head><link rel="canonical" href="https://afkauthor.com/book-recaps"></head><body>
  <header><h2 data-aid="HEADER_TAGLINE_RENDERED">The twelfth conclave - Available october 7th Audiobook release early novem</h2>
    <p data-aid="HEADER_TAGLINE2_RENDERED">Divine Apostasy Book 13 chapters available in November</p></header>
  <section><h1 data-aid="ABOUT_SECTION_TITLE_RENDERED">Book Recaps</h1>${cards}</section>${authorFooter}</body></html>`;
const homepage = `<html><head><title>A new LitRPG World is coming</title></head><body><header>
  <h1 data-aid="HEADER_TAGLINE_RENDERED">The twelfth conclave - Available october 7th Audiobook release early novem</h1>
  <p data-aid="HEADER_TAGLINE2_RENDERED">Divine Apostasy Book 13 chapters available in November</p>
  <a data-aid="HEADER_CTA_BTN" href="https://www.amazon.com/gp/product/B0FV4GQ61P">Purchase The Twelfth Conclave Here</a>
</header>${authorFooter}</body></html>`;
const observedTitles = [
  "Shade's First Rule", 'The Second Betrayal', "Uru's Third Temple", 'The Fourth Secret', "Legion's Fifth Vault",
  'The Sixth Rune', "Shadow's Seventh Step", 'The Eighth Harmony', "Tarot's Ninth Harbinger", 'The Tenth Muse', "Zealot's Eleventh Crusade"
];

describe('Divine Apostasy identity-only author adapter', () => {
  it('extracts eleven observed recap titles using reviewed mappings rather than widget positions', () => {
    const cards = observedTitles.map((title, index) => recap(title, 40 - index)).reverse().join('');
    const books = parseDivineApostasy(recapPage(cards), seed, 'https://afkauthor.com/book-recaps');
    expect(books.map(book => book.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(books[0]).toMatchObject({ title: 'Shade’s First Rule', author: 'A. F. Kay', series: 'Divine Apostasy', coverUrl: 'https://isteam.wsimg.com/covers/40.jpg' });
    expect(books.at(-1)).toMatchObject({ title: 'Zealot’s Eleventh Crusade', coverUrl: 'https://isteam.wsimg.com/covers/30.jpg' });
  });

  it('keeps every recap out of descriptions, audio links, dates, and narrator facts', () => {
    const books = parseDivineApostasy(recapPage(recap(observedTitles[0], 0)), seed, 'https://afkauthor.com/book-recaps');
    expect(books[0]).toMatchObject({ description: '', format: 'unknown', releaseDate: null, publicationStatus: 'unknown', narrator: null, audioReleaseDate: null, audioRuntimeMinutes: null, links: [] });
    expect(JSON.stringify(books)).not.toMatch(/major twist|final battle|ally dies|B000000099/);
  });

  it('does not insert unobserved earlier books or the homepage announcement into the recap list', () => {
    const books = parseDivineApostasy(recapPage(recap('The Tenth Muse', 0) + recap("Zealot's Eleventh Crusade", 1)), seed, 'https://afkauthor.com/book-recaps');
    expect(books.map(book => book.number)).toEqual([10, 11]);
  });

  it('corroborates the reviewed twelfth title from the homepage without promoting yearless launch language', () => {
    const books = parseDivineApostasy(homepage, seed, 'https://afkauthor.com/');
    expect(books).toEqual([{
      number: 12, title: 'The Twelfth Conclave', series: 'Divine Apostasy', author: 'A. F. Kay', description: '', coverUrl: null,
      format: 'unknown', releaseDate: null, publicationStatus: 'unknown', narrator: null, audioReleaseDate: null, audioRuntimeMinutes: null, links: []
    }]);
  });

  it('can establish the twelve reviewed identities across the two sources without inventing a thirteenth audiobook', () => {
    const recaps = parseDivineApostasy(recapPage(observedTitles.map(recap).join('')), seed, 'https://afkauthor.com/book-recaps');
    const announcement = parseDivineApostasy(homepage, seed, 'https://afkauthor.com/');
    const all = [...recaps, ...announcement];
    expect(all.map(book => book.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(all.flatMap(book => book.links)).toEqual([]);
  });

  it('excludes bundles and known related or coauthored works without making their authors aliases', () => {
    const cards = ["Hamma's Last Prayer", 'Hamma’s Last Prayer by A. F. Kay and B. R. Bea', 'Divine Apostasy Boxed Set Books 1–3', 'Grey Warden', "Cevin's Sword", observedTitles[0]].map(recap).join('');
    const before = structuredClone(seed);
    const books = parseDivineApostasy(recapPage(cards), seed, 'https://afkauthor.com/book-recaps');
    expect(books.map(book => book.number)).toEqual([1]);
    expect(seed).toEqual(before);
    expect(books[0].author).toBe('A. F. Kay');
  });

  it('surfaces a newly observed Summary title for review instead of assigning the next number', () => {
    const cards = recap(observedTitles[0], 0) + recap('An Unreviewed Thirteenth Tale', 1);
    expect(() => parseDivineApostasy(recapPage(cards), seed, 'https://afkauthor.com/book-recaps')).toThrow(/Unmapped.*needs review/);
  });

  it('requires the whole observed title rather than matching a title fragment or an ordinal word', () => {
    expect(() => parseDivineApostasy(recapPage(recap('Someone Else’s First Rule', 0)), seed, 'https://afkauthor.com/book-recaps')).toThrow(ReviewError);
    expect(() => parseDivineApostasy(recapPage(recap('The Tenth Muse and Other Tales', 0)), seed, 'https://afkauthor.com/book-recaps')).toThrow(ReviewError);
  });

  it('allows typographic apostrophe differences but does not rely on recap order', () => {
    const books = parseDivineApostasy(recapPage(recap('Zealot’s Eleventh Crusade', 0) + recap('Shade’s First Rule', 1)), seed, 'https://afkauthor.com/book-recaps/');
    expect(books.map(book => [book.number, book.title])).toEqual([[1, 'Shade’s First Rule'], [11, 'Zealot’s Eleventh Crusade']]);
  });

  it('deduplicates an identically repeated observed title without duplicating a work', () => {
    const books = parseDivineApostasy(recapPage(recap(observedTitles[0], 0) + recap(observedTitles[0], 7)), seed, 'https://afkauthor.com/book-recaps');
    expect(books).toHaveLength(1);
  });

  it('does not harvest known titles embedded in recap body text or another section', () => {
    const html = recapPage(recap(observedTitles[0], 0)).replace('</section>', '<p>The Twelfth Conclave is mentioned in prose.</p></section><section>' + recap('The Tenth Muse', 5) + '</section>');
    expect(parseDivineApostasy(html, seed, 'https://afkauthor.com/book-recaps').map(book => book.number)).toEqual([1]);
  });

  it('requires both the correct selected author and the page’s author identity evidence', () => {
    expect(() => parseDivineApostasy(homepage, { ...seed, author: 'B. R. Bea' }, 'https://afkauthor.com/')).toThrow(ReviewError);
    expect(() => parseDivineApostasy(homepage, { ...seed, authorAliases: ['B. R. Bea'] }, 'https://afkauthor.com/')).toThrow(ReviewError);
    expect(() => parseDivineApostasy(homepage.replace(authorFooter, ''), seed, 'https://afkauthor.com/')).toThrow(ReviewError);
    expect(() => parseDivineApostasy(homepage.replace('2019 A. F. Kay', '2019 B. R. Bea'), seed, 'https://afkauthor.com/')).toThrow(ReviewError);
    expect(parseDivineApostasy(homepage, { ...seed, author: 'A.F. Kay' }, 'https://afkauthor.com/')[0].author).toBe('A. F. Kay');
  });

  it('rejects unrelated series, unreviewed origins and paths, and a conflicting canonical URL', () => {
    expect(() => parseDivineApostasy(homepage, { ...seed, title: 'Divine Dungeon' }, 'https://afkauthor.com/')).toThrow(ReviewError);
    for (const url of ['http://afkauthor.com/', 'https://other.example/', 'https://afkauthor.com/faq', 'https://afkauthor.com/?book=1']) {
      expect(() => parseDivineApostasy(homepage, seed, url)).toThrow(ReviewError);
    }
    expect(() => parseDivineApostasy(recapPage(recap(observedTitles[0], 0)), seed, 'https://afkauthor.com/')).toThrow(ReviewError);
  });

  it('surfaces an unreviewed homepage title and never maps serial chapter announcements as books', () => {
    const html = homepage.replace('The twelfth conclave - Available october 7th Audiobook release early novem', 'A Brand New Universe - Available soon');
    expect(() => parseDivineApostasy(html, seed, 'https://afkauthor.com/')).toThrow(/needs review/);
    expect(() => parseDivineApostasy(homepage.replace('data-aid="HEADER_TAGLINE_RENDERED"', 'data-aid="OTHER_NOTICE"'), seed, 'https://afkauthor.com/')).toThrow(ReviewError);
  });

  it('rejects a missing or empty recap bibliography instead of treating it as complete', () => {
    expect(() => parseDivineApostasy(recapPage(''), seed, 'https://afkauthor.com/book-recaps')).toThrow(ReviewError);
    expect(() => parseDivineApostasy(recapPage(recap(observedTitles[0], 0)).replace('>Book Recaps<', '>Other Content<'), seed, 'https://afkauthor.com/book-recaps')).toThrow(ReviewError);
  });
});
