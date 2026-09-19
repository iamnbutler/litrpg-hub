import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blindQualityText, qualityEvidenceFor, qualityReviewState, redactRatings } from './evidence.js';
import { readerEvidenceFor, traitInput } from '../catalog/reader-evidence.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE catalog_series(id TEXT PRIMARY KEY,title TEXT);
    CREATE TABLE catalog_works(id TEXT PRIMARY KEY,series_id TEXT,title TEXT,author TEXT,number REAL);
    CREATE TABLE catalog_reader_evidence(id TEXT PRIMARY KEY,work_id TEXT,body TEXT,author_key TEXT,rating REAL,rating_best REAL,
      published_at TEXT,source_name TEXT,source_url TEXT,contains_spoilers INTEGER,removed_at TEXT);
    INSERT INTO catalog_series VALUES('series-a','Imaginary Saga');
    INSERT INTO catalog_works VALUES('work-a','series-a','Book of Testing','Test Writer',1);`);
});
afterEach(() => db.close());
const comment = 'The dialogue is precise and fluent, with distinct voices and carefully chosen words.';
function put(id: string, body = comment, overrides: Record<string, unknown> = {}) {
  const row = { id, work_id: 'work-a', body, author_key: `voice-${id}`, rating: 5, rating_best: 5,
    published_at: '2026-01-01', source_name: 'hardcover.app', source_url: 'https://hardcover.app/books/book-of-testing', contains_spoilers: 0, removed_at: null, ...overrides };
  db.prepare(`INSERT INTO catalog_reader_evidence(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(k => `@${k}`).join(',')})`).run(row);
}

describe('quality evidence excludes stars and identity', () => {
  it.each(['5 stars', 'one star', '4.5/5', '4.50/5.00', '7.5/10.00', '7/10', '3 out of 5', 'four-star', '5*', '5★', '4⭐️', '★★★★☆'])('redacts embedded rating %s', rating => {
    expect(redactRatings(`Rating: ${rating}. ${comment}`)).toBe(`Rating: [rating removed]. ${comment}`);
  });

  it('removes ordinal digits from an emoji-star rating legend', () => {
    expect(redactRatings('5★: masterpiece; 4★: excellent; 3★: enjoyable; 2★: mediocre; 1★: poor.'))
      .toBe('[rating removed]: masterpiece; [rating removed]: excellent; [rating removed]: enjoyable; [rating removed]: mediocre; [rating removed]: poor.');
  });

  it('removes explicit score idioms found in newly eligible spoiler reviews', () => {
    expect(redactRatings('This ends up being a 3.75 for me, whereas the other books have all been solid fours or fives. The middle was too long.'))
      .toBe('This [rating removed], whereas the other books have all been [rating removed]. The middle was too long.');
    expect(redactRatings('This gets another star for the ending. The middle dragged.'))
      .toBe('This [rating removed] for the ending. The middle dragged.');
  });

  it.each(['four stars instead of five', '4/5 star reviews vs. 3', '2.5 rounded up to 3', '3.5 rounded down to 3'])('redacts the whole pilot rating comparison %s', rating => {
    expect(redactRatings(`${rating}. ${comment}`)).toBe(`[rating removed]. ${comment}`);
  });

  it.each(['book 4/5', 'chapters 4/5', '4/5 of the book', '4 out of 5 chapters', '4/5/2026'])('preserves a non-rating number %s', context => {
    expect(redactRatings(`I read ${context} and the prose was precise.`)).toBe(`I read ${context} and the prose was precise.`);
  });

  it('preserves paragraph boundaries while redacting an actual pilot-shaped heading', () => {
    expect(blindQualityText('<p>2.5 rounded up to 3<br><br>The writing flowed well.</p><p>This book has deft transitions.</p>'))
      .toBe('[rating removed] The writing flowed well. This book has deft transitions.');
  });

  it('withholds a count attached to a removed star-rating claim', () => {
    expect(redactRatings('According to several thousand 5-star reviews, the plotting is coherent.'))
      .toBe('According to [rating removed], the plotting is coherent.');
  });

  it('retains craft text while removing markup and exact title/author names', () => {
    expect(blindQualityText('<p>Test Writer wrote Book of Testing: <b>5 stars</b>. The prose is precise.</p>', ['Test Writer', 'Book of Testing']))
      .toBe('[name withheld] wrote [name withheld]: [rating removed]. The prose is precise.');
  });

  it('does not blind a title inside an unrelated word', () => {
    expect(blindQualityText('The Land has a bland sentence, unlike LAND.', ['Land']))
      .toBe('The [name withheld] has a bland sentence, unlike [name withheld].');
  });

  it('changes neither model state nor evidence hash when numeric ratings change', () => {
    put('one', `5 stars. ${comment}`);
    const first = qualityEvidenceFor(db, 'work-a');
    db.prepare('UPDATE catalog_reader_evidence SET rating=1,rating_best=10,body=?').run(`1 star. ${comment}`);
    const second = qualityEvidenceFor(db, 'work-a');
    expect(second.inputHash).toBe(first.inputHash);
    expect(qualityReviewState(second.reviews[0])).toEqual(qualityReviewState(first.reviews[0]));
    const state = qualityReviewState(second.reviews[0]);
    expect(state).not.toHaveProperty('rating');
    expect(state).not.toHaveProperty('of');
    expect(JSON.stringify(state)).not.toContain('Test Writer');
    expect(JSON.stringify(state)).not.toContain('hardcover');
    expect(JSON.stringify(state)).not.toContain('voice-one');
  });

  it('changes the hash when actual craft evidence changes', () => {
    put('one');
    const first = qualityEvidenceFor(db, 'work-a');
    db.prepare('UPDATE catalog_reader_evidence SET body=?').run('The prose repeats entire paragraphs, with frequent spelling and punctuation errors throughout.');
    expect(qualityEvidenceFor(db, 'work-a').inputHash).not.toBe(first.inputHash);
  });
});

describe('one deterministic independent voice per private quality comment', () => {
  it('includes private spoiler evidence while public impressions still exclude it', () => {
    put('flagged', `${comment} More explanation here.`, { contains_spoilers: 1 });
    put('markup', `${comment}<p class="spoiler-free">fine</p><div class="spoiler">plot ending</div>`);
    put('safe', comment);
    const evidence = qualityEvidenceFor(db, 'work-a');
    expect(evidence.reviews.map(r => r.id)).toEqual(['flagged', 'markup', 'safe']);
    expect(evidence.reviews[0]).toMatchObject({ spoilerFlag: true, spoilerMarkup: false });
    expect(evidence.reviews[1]).toMatchObject({ spoilerFlag: false, spoilerMarkup: true });
    expect(evidence.sampling).toBe('bounded-independent-public-reviews-including-spoilers');
    expect(traitInput(readerEvidenceFor(db, 'work', 'work-a')).map(r => r.id)).toEqual(['safe']);
  });

  it('retains unknown spoiler provenance for sources without explicit flags and still deduplicates', () => {
    put('source', comment, { source_name: 'soundbooththeater.com', contains_spoilers: 1 });
    put('copy', `<span class="spoiler">${comment}</span>`, { source_name: 'hardcover.app', contains_spoilers: 1, published_at: '2026-02-01' });
    const evidence = qualityEvidenceFor(db, 'work-a');
    expect(evidence.reviews).toHaveLength(1);
    expect(evidence.reviews[0]).toMatchObject({ id: 'source', spoilerFlag: null, spoilerMarkup: false });
  });

  it('deduplicates both identities and equivalent HTML bodies', () => {
    put('short', comment, { author_key: 'same-person' });
    put('long', `${comment} Its transitions are also carefully developed.`, { author_key: 'same-person' });
    put('copy', `<p>${comment} Its transitions are also carefully developed.</p>`, { published_at: '2026-02-01' });
    expect(qualityEvidenceFor(db, 'work-a').reviews.map(r => r.id)).toEqual(['long']);
  });

  it('also deduplicates text differing only in the removed star rating', () => {
    put('a', `5 stars. ${comment}`);
    put('b', `1 star. ${comment}`);
    expect(qualityEvidenceFor(db, 'work-a').reviews.map(r => r.id)).toEqual(['a']);
  });

  it('breaks equal-length equal-date selection ties deterministically', () => {
    put('z', 'The prose is precise and fluent, with expressive imagery and carefully chosen words.', { author_key: 'same' });
    put('a', 'The prose is precise and fluent, with expressive imagery and carefully chosen words.', { author_key: 'same' });
    expect(qualityEvidenceFor(db, 'work-a').reviews.map(r => r.id)).toEqual(['a']);
  });

  it('excludes missing voices, removed reviews, private URLs and unbounded prose', () => {
    put('none', comment, { author_key: '' });
    put('removed', comment, { removed_at: '2026-02-01' });
    put('private', comment, { source_url: 'https://secret.internal/reviews' });
    put('long', `${comment}${'x'.repeat(12_000)}`);
    put('safe', comment);
    const result = qualityEvidenceFor(db, 'work-a');
    expect(result.reviews.map(r => r.id)).toEqual(['safe']);
    expect(result.excluded).toMatchObject({ missingVoice: 1, nonPublicUrl: 1, tooLong: 1 });
  });

  it('bounds a run without clipping a selected comment', () => {
    for (let i = 0; i < 5; i++) put(String(i), `${comment} Specific example number ${i}.`);
    const result = qualityEvidenceFor(db, 'work-a', { limit: 2 });
    expect(result.reviews).toHaveLength(2);
    expect(result.reviews[1].comment).toContain('Specific example number 1.');
    expect(() => qualityEvidenceFor(db, 'work-a', { limit: 0 })).toThrow(/1 to 60/);
    expect(() => qualityEvidenceFor(db, 'missing')).toThrow(/Unknown catalog work/);
  });
});
