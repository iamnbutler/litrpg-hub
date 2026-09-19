import { describe, expect, it } from 'vitest';
import { explicitEditionKind, explicitVolumeNumbers, hasExplicitLaterVolume } from './edition.js';

describe('explicit volume labels', () => {
	it.each([
		['The Last Portal Jumper: Book 5', '', [5]],
		['Beef Cutlets and the Bandit King\'s Treasure', 'Campfire Cooking in Another World with My Absurd Skill, Volume 10', [10]],
		['Unintended Cultivator: Volume 9', '', [9]],
		['A New Journey', 'Series Name, Vol. 3', [3]],
		['A New Journey: Part IV', '', [4]],
		['A New Journey', 'Series Name, Book IX', [9]],
		['A New Journey', 'Series Name, volume xi', [11]],
		['A New Journey', 'Book #2', [2]],
		['A New Journey', 'Book 2.5', [2.5]],
		['A New Journey: Book I', 'Book 1', [1]],
		['A New Journey: Book I', 'Part II', [1, 2]]
	] as const)('reads only explicit numbers in %s / %s', (title, subtitle, numbers) => {
		expect(explicitVolumeNumbers({ title, subtitle })).toEqual(numbers);
		expect(hasExplicitLaterVolume({ title, subtitle })).toBe(numbers.some(number => number > 1));
	});

	it.each(['12 Miles Below', '1984', '1% Lifesteal', 'The Book of the Dead', 'Part of the Family', 'The Complete Mage', 'Book Club', 'Volume of Magic', 'Book IIV', 'Book IIII'])('does not invent an ordinal from %s', title => {
		expect(explicitVolumeNumbers({ title })).toEqual([]);
		expect(hasExplicitLaterVolume({ title })).toBe(false);
	});
});

describe('explicit edition labels', () => {
	it.each([
		['Way of the Immortals: The Complete 4-Book Series', 'Isekai Cultivation Fantasy'],
		['Dungeon Exploiters Bundle', 'The Complete GameLit Series'],
		['Station Cores Complete Compilation', ''],
		['Dungeon Crafting Series Books 1 Through 3', ''],
		['Holiday Dungeon Core: Novella 1-5', ''],
		['Series Name', 'Books I–III'],
		['Series Name', 'Volumes 1 and 2'],
		['The Collected Stories', ''],
		['2026 LitRPG Anthology', ''],
		['Series Name', 'Boxed Set'],
		['Series Name', 'Omnibus Edition']
	])('identifies the collection %s / %s', (title, subtitle) => {
		expect(explicitEditionKind({ title, subtitle })).toBe('collection');
	});

	it.each([
		'In Other Worlds - A LitRPG, GameLit, and Fantasy Podcast',
		'Don’t Gaslight Me, Jesus: A Dungeon Crawler Carl Podcast'
	])('identifies the explicitly named podcast %s', title => {
		expect(explicitEditionKind({ title })).toBe('podcast');
	});

	it('uses retained retailer type for an otherwise ambiguous radio title', () => {
		expect(explicitEditionKind({ title: 'Dungeon Crawlers Radio' })).toBeNull();
		expect(explicitEditionKind({ title: 'Dungeon Crawlers Radio', contentType: 'Podcast' })).toBe('podcast');
		expect(explicitEditionKind({ title: 'Dungeon Crawlers Radio', contentDeliveryType: 'PodcastParent' })).toBe('podcast');
		expect(explicitEditionKind({ title: 'Episode 12', contentDeliveryType: 'PodcastEpisode' })).toBe('podcast');
	});

	it.each(['Dramatized Adaptation', 'Dramatised Adaptation', 'GraphicAudio', 'Full-Cast Recording'])('identifies %s as an adaptation', subtitle => {
		expect(explicitEditionKind({ title: 'The Grand Game', subtitle })).toBe('dramatized');
	});

	it.each([
		['The Wandering Inn', 'The Wandering Inn Series, Book 1: Parts 1 and 2'],
		['Dungeon Player', 'Glendaria Awakens Trilogy, Book 1'],
		['Lost Soul', 'The Tian Trilogy, Book 1'],
		['Traveller’s Trial', 'The Traveller’s Trilogy, Book 1'],
		['12 Miles Below', 'A Progression Fantasy'],
		['The Complete Mage', ''],
		['A Collection of Debts', ''],
		['A Bundle of Trouble', ''],
		['The Podcast Murders', 'A Mystery Novel'],
		['Radio Silence', 'A Novel']
	])('does not infer a format from ordinary title words in %s / %s', (title, subtitle) => {
		expect(explicitEditionKind({ title, subtitle })).toBeNull();
	});
});
