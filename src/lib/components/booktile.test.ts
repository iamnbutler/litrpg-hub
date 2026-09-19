import { describe, it, expect } from 'vitest';
import { render } from 'svelte/server';
import BookTile from './BookTile.svelte';

const book: any = { id: 'b1', title: 'Words of Creation', subtitle: '', author: 'Patrick G. Laplante', narrator: 'N', series: 'Painting the Mists', seriesKey: 'ptm', seriesNumber: 10, releaseDate: '2021-04-13', runtimeMinutes: 600, rating: 4.82, ratingCount: 268, subgenres: ['cultivation'], edition: 'audiobook', scope: 'indexed', cover: '', description: '', sources: [], traits: {}, content: {} };

describe('BookTile author line', () => {
  it('keeps a space on both sides of the series-number separator', () => {
    // Svelte trims leading whitespace inside an element, so the separator must be an expression.
    const { body } = render(BookTile, { props: { book, layout: 'list', entry: undefined, onopen: () => {}, onsave: () => {}, onlike: () => {} } as any });
    const text = body.replace(/<[^>]*>/g, '').replace(/<!--.*?-->/g, '');
    expect(text).toMatch(/Laplante\s+·\s+Book 10/);
  });
});
