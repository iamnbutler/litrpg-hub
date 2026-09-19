import type Database from 'better-sqlite3';
import type { CatalogBook } from '../../../src/lib/catalog.js';

/** Classifiers see source copy, even when the public catalog shows a rewritten synopsis. */
export function contentBook(db:Database.Database,book:CatalogBook):CatalogBook {
  if(!book.workId||!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_works'").get())return book;
  const work=db.prepare('SELECT title,author,source_description FROM catalog_works WHERE id=?').get(book.workId) as {title:string;author:string;source_description:string}|undefined;
  return work?.source_description?{...book,title:work.title,author:work.author,subtitle:'',description:work.source_description}:book;
}
