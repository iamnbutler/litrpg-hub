import { describe, expect, it } from 'vitest';
import { parseLibrary } from './library.js';

// Library import behavior belongs to the reader app, not the catalog producer.
describe('saved library imports', () => {
	it('validates saved shelf data rather than trusting arbitrary imports', () => {
		expect(parseLibrary({ BOOK1: { status: 'read', rating: 5 }, BOOK2: { status: 'broken', rating: 100 } })).toMatchObject({ BOOK1: { status: 'read', rating: 5 } });
		expect(Object.keys(parseLibrary({ BOOK2: { status: 'broken', rating: 100 } }))).toHaveLength(0);
	});
});
