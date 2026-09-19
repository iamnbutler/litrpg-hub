import { load } from 'cheerio';
import { clean } from './adapters.js';
import { normalizeIdentity } from '../../../src/lib/catalog.js';
import { ReviewError, type ExtractedBook, type SeedSeries } from './types.js';

const unpricedWork=(title:string,series:string,number:number,author:string):ExtractedBook=>({
  title,series,number,author,description:'',coverUrl:null,releaseDate:null,publicationStatus:'unknown',
  format:'print',narrator:null,audioReleaseDate:null,audioRuntimeMinutes:null,links:[]
});

/** Author-owned store: the explicit Book N label wins over the realm's ordinal. */
export function parseChatfieldBook(html:string):ExtractedBook {
  const $=load(html),heading=clean($('h1').first().text());
  const match=heading.match(/^(.+?)\s*[-–]?\s*The Ten Realms(?:\s+Series)?\s+Book\s+(\d+)\b/i);
  if(!match)throw new ReviewError('Author product does not explicitly identify a numbered Ten Realms work.');
  const title=match[1].replace(/\s*[-–]\s*$/,'').trim();
  const copy=$('.product-description').first().clone();copy.find('br').replaceWith('\n');
  const paragraphs=copy.find('p').map((_,p)=>clean($(p).text())).get()
    .filter(p=>p&&!/^PLEASE NOTE THAT YOU CANNOT PURCHASE\b/i.test(p));
  if(!paragraphs.length)throw new ReviewError('Author product description is missing.');
  const book=unpricedWork(title,'The Ten Realms',Number(match[2]),'Michael Chatfield');
  book.description=paragraphs.join('\n\n');
  // No store date, stock status, price, or format switch proves an audio release.
  for(const script of $('script[type="application/ld+json"]').toArray()){
    try{const item=JSON.parse($(script).text());if(item['@type']==='Product'&&typeof item.image==='string'&&item.image.startsWith('https://'))book.coverUrl=item.image;}catch{}
  }
  return book;
}

export function chatfieldSeriesLinks(html:string,base:string):{url:string;title:string}[] {
  const $=load(html),found=new Map<string,string>();
  $('a[href*="/products/"]').each((_,a)=>{
    const title=clean($(a).text());
    if(!/The Ten Realms(?:\s+Series)?\s+Book\s+\d+\b/i.test(title))return;
    const url=new URL($(a).attr('href')!,base);
    if(url.origin!==new URL(base).origin||!url.pathname.includes('/products/'))return;
    url.hash='';url.search='';found.set(url.href,title);
  });
  return [...found].map(([url,title])=>({url,title}));
}

/** The author's AO labels explicitly number side quests; Tarot and MRI are separate. */
export function parseBagwellBooks(html:string,seed:SeedSeries):ExtractedBook[] {
  if(normalizeIdentity(seed.title)!==normalizeIdentity('Awaken Online')||!seed.authorAliases.some(a=>normalizeIdentity(a)===normalizeIdentity('Travis Bagwell')))
    throw new ReviewError('Bagwell bibliography is not the selected series.');
  const $=load(html),found=new Map<number,ExtractedBook>();
  $('a[href*="mybook.to"]').each((_,a)=>{
    const card=$(a).clone();card.find('h3').remove();
    const label=clean(card.text()),match=label.match(/\bAO\s+#(\d+(?:\.\d+)?)(?![\d.])(?:\s|$)/),title=clean($(a).find('h3').text());
    if(!match||!title)return;
    const number=Number(match[1]),prior=found.get(number);
    if(prior&&normalizeIdentity(prior.title)!==normalizeIdentity(title))throw new ReviewError('Author bibliography gives conflicting titles for a volume.');
    const book=unpricedWork(title,'Awaken Online',number,'Travis Bagwell');
    const image=$(a).find('img').attr('src');
    if(image)book.coverUrl=new URL(image,'https://travisbagwell.com/').href;
    // A multi-format short link does not identify an audiobook or its release date.
    found.set(number,book);
  });
  if(!found.size||found.size>100)throw new ReviewError('Author bibliography has no bounded, identifiable Awaken Online books.');
  return [...found.values()].sort((a,b)=>a.number-b.number);
}
