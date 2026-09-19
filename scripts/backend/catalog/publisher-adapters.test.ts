import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePodiumBook, parsePortalAuthor, podiumSeriesLinks } from './publisher-adapters.js';
import { sbtPageLinks } from './adapters.js';
import { enrichCatalogSeries } from '../exporters/series.js';
import { classifyContent } from '../classifiers/content.js';
import { importWork } from './import.js';
import { seeds } from './pipeline.js';
import type { CatalogBook } from '../../../src/lib/catalog.js';
import type { Document, ExtractedBook } from './types.js';

describe('publisher adapters', () => {
  it('takes Podium books from the actual series grid, excluding recommendations', () => {
    const html='<main><a href="/titles/1/first"><img data-testid="grid-image" alt="First"></a><a href="/titles/2/recommendation"><img alt="Another series"></a></main>';
    expect(podiumSeriesLinks(html,'https://podiumentertainment.com/series/1/test')).toEqual([{url:'https://podiumentertainment.com/titles/1/first',title:'First'}]);
  });
  it('parses an audiobook title page without treating an unavailable duration as zero', () => {
    const html=`<script type="application/ld+json">{"@type":"Audiobook","image":"https://assets.podiumentertainment.com/test.jpg"}</script>
      <h1 data-testid="title-header">A New Adventure</h1><p data-testid="title-series">Test Series, Book 3</p>
      <div data-testid="label-written-by"><a>Writer One</a><a>, Writer Two</a></div><div data-testid="label-performed-by"><a>Voice One</a></div>
      <div data-testid="label-release-date"><span>Release date</span><span>October 6, 2026</span></div>
      <div data-testid="label-duration"><span>Duration</span><span>Coming Soon</span></div>
      <section data-testid="description-section"><h2 data-testid="story-header">A city disappears.</h2><div data-testid="story-description">Its people must find a way home.</div></section>
      <div data-testid="sales-audiobook"><a href="https://www.audible.com/pd/A-New-Adventure/B000000003">Audible</a></div>`;
    expect(parsePodiumBook(html)).toMatchObject({title:'A New Adventure',series:'Test Series',number:3,author:'Writer One, Writer Two',narrator:'Voice One',audioReleaseDate:'2026-10-06',audioRuntimeMinutes:null,format:'audiobook',links:[{format:'audiobook',asin:'B000000003'}]});
  });
  it('does not duplicate a Portal series premise into every volume or invent audio dates', () => {
    const seed={...seeds[0],title:'Test Series',author:'Test Author',authorAliases:['Test Author'],aliases:[]};
    const card=(n:number)=>`<div class="ia-book-card"><div class="is-style-caption">Book ${n}</div><div class="is-style-heading-h5">Test Series ${n}</div><a href="https://www.amazon.com/dp/B00000000${n}">Buy</a></div>`;
    const rows=parsePortalAuthor(`<h1 class="wp-block-post-title">Test Author</h1><div class="ia-series-inner"><h2>Test Series</h2><p class="copy-wide">A healer wakes in another world.</p>${card(1)}${card(2)}</div>`,seed);
    expect(rows[0].description).toBe('A healer wakes in another world.');
    expect(rows[1]).toMatchObject({description:'',format:'ebook',releaseDate:null,audioReleaseDate:null});
  });
  it('discovers bounded Soundbooth pagination from data without evaluating page scripts', () => {
    expect(sbtPageLinks('<script>var misha_loadmore_params = {"max_page":"3"};</script>','https://soundbooththeater.com/series/')).toEqual(['https://soundbooththeater.com/series/page/2/','https://soundbooththeater.com/series/page/3/']);
    expect(()=>sbtPageLinks('<script>var misha_loadmore_params = {"max_page":"99999"};</script>','https://soundbooththeater.com/series/')).toThrow(/bounded/);
  });
});

it.each(['cradle','dungeon-crawler-carl'])('uses the reviewed %s genre registry ahead of inherited retailer tags',id=>{
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');
  try{
    for(const name of ['001_initial.sql','006_catalog_pipeline.sql'])db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
    const seed=seeds.find(s=>s.id===id)!,stamp='2026-09-19T00:00:00Z';
    db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run(seed.id,seed.title,seed.author,stamp);
    db.prepare('INSERT INTO series(id,title,author) VALUES(?,?,?)').run('legacy',seed.title,seed.author);
    db.prepare('INSERT INTO books(id,title,author,series_id,series_number,release_date) VALUES(?,?,?,?,?,?)').run('GENRE00001',seed.title,seed.author,'legacy',1,'2025-01-01');
    const source:Document={id:'genre-source',url:'https://aethonbooks.com/book/test/',content_hash:'genre-source',body:'source',fetched_at:stamp};
    db.prepare('INSERT INTO catalog_documents VALUES(?,?,?,?,?)').run(source.id,source.url,source.content_hash,source.body,stamp);
    importWork(db,seed,{title:seed.title,series:seed.title,author:seed.author,number:1,description:'A retained description of a protagonist whose magic grows through training and dangerous challenges.',format:'unknown',publicationStatus:'released',coverUrl:null,releaseDate:null,audioReleaseDate:null,audioRuntimeMinutes:null,narrator:null,links:[]},source);
    const books:CatalogBook[]=[{id:'GENRE00001',title:seed.title,subtitle:'',author:seed.author,series:seed.title,seriesKey:'legacy',seriesNumber:1,narrator:null,releaseDate:'2025-01-01',coverUrl:null,runtimeMinutes:null,description:'',url:null,rating:null,ratingCount:0,subgenres:['litrpg'],edition:'audiobook',scope:'indexed',content:classifyContent({title:seed.title,subtitle:'',description:'',narrator:null}),assessment:null,sources:[],issues:[]}];
    enrichCatalogSeries(db,books);
    expect(books[0].subgenres.includes('litrpg')).toBe(id!=='cradle');
    for(const genre of seed.genres)expect(books[0].subgenres).toContain(genre);
  }finally{db.close();}
});

it('uses the work credit on a publisher audiobook card while retaining the series author roster',()=>{
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');
  try{
    for(const name of ['001_initial.sql','006_catalog_pipeline.sql'])db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
    const seed=seeds.find(s=>s.id==='rune-seeker')!,stamp='2026-09-19T00:00:00Z';
    db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run(seed.id,seed.title,seed.author,stamp);
    const source:Document={id:'coauthor-source',url:'https://podiumentertainment.com/titles/example/',content_hash:'test',body:'test',fetched_at:stamp};
    db.prepare('INSERT INTO catalog_documents VALUES(?,?,?,?,?)').run(source.id,source.url,source.content_hash,source.body,stamp);
    const credited=seed.authorAliases[0];
    importWork(db,seed,{title:seed.title,series:seed.title,author:credited,number:1,description:'An adventurer explores a remote wilderness and discovers the first traces of an old civilization.',format:'audiobook',publicationStatus:'released',coverUrl:null,releaseDate:'2025-01-01',audioReleaseDate:'2025-01-01',audioRuntimeMinutes:null,narrator:null,links:[]},source);
    const books:CatalogBook[]=[],series=enrichCatalogSeries(db,books);
    expect(books[0].author).toBe(credited);
    expect(series[0].author).toBe(seed.author);
  }finally{db.close();}
});

it.each(['different-narrator','same-narrator-new-id','same-narrator-new-performance'])('keeps %s while using corroborated publisher audio to fill missing retailer facts', kind => {
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');
  try {
    for(const name of ['001_initial.sql','006_catalog_pipeline.sql'])db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
    const seed=seeds.find(s=>s.id==='dungeon-crawler-carl')!,stamp='2026-09-19T00:00:00Z';
    db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run(seed.id,seed.title,seed.author,stamp);
    db.prepare('INSERT INTO series(id,title,author) VALUES(?,?,?)').run('legacy',seed.title,seed.author);
    db.prepare('INSERT INTO books(id,title,author,series_id,series_number,release_date,narrator) VALUES(?,?,?,?,?,?,?)').run('B000000001',seed.title,seed.author,'legacy',1,'','First Narrator');
    const work:ExtractedBook={title:seed.title,series:seed.title,number:1,author:seed.author,description:'A man and his cat enter a deadly dungeon after the destruction of their city. The two companions must overcome a series of challenges.',coverUrl:null,releaseDate:'2024-01-01',audioReleaseDate:null,audioRuntimeMinutes:null,narrator:null,publicationStatus:'released',format:'ebook',links:[]};
    const save=(key:string,url:string,input:ExtractedBook)=>{const source:Document={id:key,url,content_hash:key,body:key,fetched_at:stamp};db.prepare('INSERT INTO catalog_documents VALUES(?,?,?,?,?)').run(key,url,key,key,stamp);importWork(db,seed,input,source);};
    save('print','https://aethonbooks.com/book/test/',work);
    save('audio-a','https://soundbooththeater.com/shop/audiobooks/test/',{...work,format:'audiobook',releaseDate:'2024-05-01',audioReleaseDate:'2024-05-01',narrator:'First Narrator',audioRuntimeMinutes:720,coverUrl:'https://soundbooththeater.com/cover.jpg'});
    const nextNarrator=kind==='different-narrator'?'Second Narrator':'First Narrator';
    save('audio-b','https://podiumentertainment.com/titles/test/',{...work,format:'audiobook',releaseDate:'2024-08-01',audioReleaseDate:'2024-08-01',narrator:nextNarrator,audioRuntimeMinutes:750,links:kind==='same-narrator-new-id'?[{format:'audiobook',asin:'B000000002',url:'https://www.audible.com/pd/B000000002'}]:[]});
    const books:CatalogBook[]=[{id:'B000000001',title:seed.title,subtitle:'',author:seed.author,series:seed.title,seriesKey:'legacy',seriesNumber:1,narrator:'First Narrator',releaseDate:null,coverUrl:null,runtimeMinutes:null,description:'',url:null,rating:null,ratingCount:0,subgenres:['litrpg'],edition:'audiobook',scope:'indexed',content:classifyContent({title:seed.title,subtitle:'',description:'',narrator:null}),assessment:null,coverAssessment:null,sources:[],issues:[]}];
    const series=enrichCatalogSeries(db,books);
    expect(books).toHaveLength(2);
    expect(books.every(b=>b.description==='')).toBe(true);
    expect(books[0]).toMatchObject({releaseDate:'2024-05-01',runtimeMinutes:720,coverUrl:'https://soundbooththeater.com/cover.jpg'});
    expect(books[1]).toMatchObject({narrator:nextNarrator,releaseDate:'2024-08-01',runtimeMinutes:750});
    expect(series[0].works).toHaveLength(1);
    expect(series[0].works[0].audioReleaseDate).toBe('2024-05-01');
    const printId=(db.prepare("SELECT id FROM catalog_editions WHERE format='ebook'").get() as {id:string}).id;
    expect(series[0].works[0].editionIds).not.toContain(printId);
  } finally {db.close();}
});
