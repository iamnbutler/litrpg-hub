import { readFileSync } from 'node:fs';
import { normalizeIdentity, type CatalogBook } from '../../../src/lib/catalog.js';
interface AuthorRule { id:string;name:string;aliases:string[];reviewedAt:string;source:string;signals:Partial<Record<keyof CatalogBook['content'],{verdict:'present'|'absent'|'unknown';note:string}>> }
export const authorRules=JSON.parse(readFileSync(new URL('../config/author-content.json',import.meta.url),'utf8')) as AuthorRule[];
export function applyAuthorRules(book:CatalogBook,rules:AuthorRule[]=authorRules):void {
  const credited=book.author.split(/,|\s+and\s+|\s*&\s*/i).map(normalizeIdentity);
  for(const rule of rules) {
    if(!rule.aliases.some(alias=>credited.includes(normalizeIdentity(alias))))continue;
    for(const [field,signal] of Object.entries(rule.signals)) {
      if(!(field in book.content)||!signal||!['present','absent','unknown'].includes(signal.verdict)||!signal.note)throw new Error('Invalid author content rule.');
      book.content[field as keyof CatalogBook['content']]={...signal,confidence:1,source:'manual'};
    }
  }
}
