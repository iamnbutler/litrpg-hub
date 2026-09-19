import { describe, expect, it } from 'vitest';
import { chatfieldSeriesLinks, parseBagwellBooks, parseChatfieldBook } from './author-adapters.js';
import { ReviewError, type SeedSeries } from './types.js';

describe('author bibliographies',()=>{
  it('uses the author book number rather than a realm ordinal or paperback date',()=>{
    const book=parseChatfieldBook('<h1>The Sixth Realm Part 2 - The Ten Realms Series Book 7 - (Paperback)</h1><div class="product-description"><p>PLEASE NOTE THAT YOU CANNOT PURCHASE THE PHYSICAL BOOK FROM THE STORE.</p><p>Two soldiers seek their next challenge.<br>Danger awaits beyond the gate.</p></div><time>2026-10-01</time>');
    expect(book).toMatchObject({title:'The Sixth Realm Part 2',number:7,format:'print',releaseDate:null,audioReleaseDate:null,narrator:null,links:[]});
    expect(book.description).toBe('Two soldiers seek their next challenge.\nDanger awaits beyond the gate.');
  });
  it('rejects unrelated products and unnumbered store pages',()=>{
    expect(()=>parseChatfieldBook('<h1>Other Series Book 4</h1>')).toThrow(ReviewError);
    expect(()=>parseChatfieldBook('<h1>The Ten Realms Collection</h1>')).toThrow(ReviewError);
  });
  it('discovers only explicitly numbered books and ignores recommendations or offsite links',()=>{
    const html='<a href="/products/realm">The Fourth Realm - The Ten Realms Series Book 4</a><a href="/products/other">Other Series Book 1</a><a href="https://elsewhere.example/products/realm">The Ten Realms Series Book 5</a>';
    expect(chatfieldSeriesLinks(html,'https://michaelchatfield.com/collections/the-ten-realms')).toEqual([{url:'https://michaelchatfield.com/products/realm',title:'The Fourth Realm - The Ten Realms Series Book 4'}]);
  });
  const seed:SeedSeries={id:'awaken-online',title:'Awaken Online',author:'Travis Bagwell',authorAliases:['Travis Bagwell'],aliases:[],genres:['litrpg'],priority:1,sources:[]};
  it('retains fractional side stories and excludes separate Tarot/MRI numbering',()=>{
    const card=(label:string,title:string)=>`<a href="https://mybook.to/test"><span>${label}</span><h3>${title}</h3><img src="/images/test.jpg"></a>`;
    const books=parseBagwellBooks(card('AO #1','Catharsis')+card('Side Quest Riley AO #2.5','Retribution')+card('Tarot #T1','Ember')+card('MRI #1','Hollow'),seed);
    expect(books.map(b=>[b.number,b.title])).toEqual([[1,'Catharsis'],[2.5,'Retribution']]);
    expect(books.every(b=>!b.audioReleaseDate&&!b.links.length&&!b.description)).toBe(true);
  });
  it('requires an explicit series binding and refuses conflicting same-volume titles',()=>{
    expect(()=>parseBagwellBooks('',{...seed,title:'Another Series'})).toThrow(ReviewError);
    expect(()=>parseBagwellBooks('<a href="https://mybook.to/a">AO #1<h3>First</h3></a><a href="https://mybook.to/b">AO #1<h3>Second</h3></a>',seed)).toThrow(ReviewError);
  });
});
