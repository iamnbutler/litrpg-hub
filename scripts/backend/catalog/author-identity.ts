import { normalizeIdentity } from '../../../src/lib/catalog.js';
import type { SeedSeries } from './types.js';

const names = (value: string | readonly string[]) => (typeof value === 'string' ? [value] : value)
  .flatMap(credit => credit.split(/,|\s+and\s+/i)).map(name => name.trim()).filter(Boolean);

/** A pen name is the same person; a coauthor is not. A series-wide alias pool alone
 * cannot establish who wrote a particular volume. Unmapped or ambiguous names fail closed. */
export function creditedAuthorKeys(seed: SeedSeries, value: string | readonly string[]): string[] | null {
  const roster = names(seed.author);
  if (!roster.length) return null;
  const people = seed.authorIdentities ?? (roster.length === 1
    ? [{ name: roster[0], aliases: seed.authorAliases }]
    : roster.map(name => ({ name, aliases: seed.authorAliases.filter(alias => normalizeIdentity(alias) === normalizeIdentity(name)) })));
  const allowed = new Set([...roster, ...seed.authorAliases].map(normalizeIdentity));
  const aliases = new Map<string, string>();
  for (const person of people) {
    const key = normalizeIdentity(person.name);
    if (!key || !roster.some(name => normalizeIdentity(name) === key)) return null;
    for (const name of [person.name, ...person.aliases]) {
      const alias = normalizeIdentity(name);
      if (!alias || !allowed.has(alias) || aliases.has(alias) && aliases.get(alias) !== key) return null;
      aliases.set(alias, key);
    }
  }
  const credits = names(value).map(normalizeIdentity)
    .filter(name => !seed.publisherCredits?.some(publisher => normalizeIdentity(publisher) === name));
  if (!credits.length || credits.some(name => !aliases.has(name))) return null;
  return [...new Set(credits.map(name => aliases.get(name)!))].sort();
}

export function sameAuthorCredits(seed: SeedSeries, left: string | readonly string[], right: string | readonly string[]): boolean {
  const a = creditedAuthorKeys(seed, left), b = creditedAuthorKeys(seed, right);
  return !!a && !!b && a.join('|') === b.join('|');
}
