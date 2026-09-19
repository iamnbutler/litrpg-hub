import { load, type CheerioAPI } from 'cheerio';
import { normalizeIdentity, validReleaseDate } from '../../../src/lib/catalog.js';
import { ReviewError, type ExtractedBook, type SeedSeries } from './types.js';
import { creditedAuthorKeys } from './author-identity.js';
export const ADAPTER_VERSION = 'publisher-audio-v1';
export const clean = (text: string) => text.replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n\n').trim();
const paragraphs = ($: CheerioAPI, selector: string) => clean($(selector).first().find('p').map((_,el)=>$(el).text().trim()).get().join('\n\n') || $(selector).first().text());
export function parseDate(value: string): string | null {
  if (!value.trim()) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return validReleaseDate(value);
  const us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return validReleaseDate(`${us[3]}-${us[1].padStart(2,'0')}-${us[2].padStart(2,'0')}`);
  if (!/^[A-Z][a-z]+ \d{1,2},? \d{4}$/.test(value)) return null;
  const time = Date.parse(value+' 12:00:00 UTC');
  return Number.isFinite(time) ? validReleaseDate(new Date(time).toISOString().slice(0,10)) : null;
}
export function verifyIdentity(book: ExtractedBook, seed: SeedSeries) {
  const series = normalizeIdentity(book.series);
  if (![seed.title,...seed.aliases].some(s => normalizeIdentity(s) === series)) throw new ReviewError('Series identity does not match the selected series.');
  if (!creditedAuthorKeys(seed,book.author)) throw new ReviewError('Author identity does not match the selected author identities.');
  if (!Number.isFinite(book.number) || book.number <= 0 || book.number > 200 || !book.title) throw new ReviewError('Missing book number or title.');
  if (/\b(light novel|graphic novel|comic|omnibus|box set|volume[s]?\s*1\s*[-–]\s*3)\b/i.test(book.title)) throw new ReviewError('Adaptation or collection requires an explicit work mapping.');
}
export function linksFrom(html: string, base: string, path: string): {title:string;url:string}[] {
  const $ = load(html), found = new Map<string,string>();
  $('main').length ? void 0 : $('header,footer,nav').remove();
  $($('main').length?'main a[href]':'body a[href]').each((_,el) => {
    try {
      const url = new URL($(el).attr('href')!,base);
      if (url.origin !== new URL(base).origin || !url.pathname.startsWith(path) || url.pathname === path) return;
      if (url.pathname === new URL(base).pathname || /\/page\/\d+\/?$/.test(url.pathname)) return;
      url.hash='';
      const title = clean($(el).text());
      if (title && !/^(See The Book|View Production Details|Play Sample)$/i.test(title)) found.set(url.href,title);
      else if (!found.has(url.href)) found.set(url.href,clean($(el).closest('article,.book-item,.mf-book-card').find('h2,h3,.book-title').first().text()));
    } catch { /* malformed unrelated link */ }
  });
  return [...found].map(([url,title])=>({url,title}));
}
export function aethonPageLinks(html: string, base: string): string[] {
  const $=load(html), urls=new Set<string>();
  $('a[href]').each((_,el)=>{try {const url=new URL($(el).attr('href')!,base);const page=Number(url.searchParams.get('pg'));if(url.origin===new URL(base).origin && url.pathname==='/litrpg/' && page>=1 && page<=10) urls.add(url.href);}catch{}});
  return [...urls];
}
export function sbtPageLinks(html:string,base:string):string[] {
  const $=load(html);
  const script=$('script').map((_,el)=>$(el).text()).get().find(text=>text.includes('var misha_loadmore_params ='));
  const raw=script?.match(/var misha_loadmore_params\s*=\s*(\{[^\n]+\});/)?.[1];
  if(!raw)return [];
  let settings:{max_page?:string};try{settings=JSON.parse(raw);}catch{return [];}
  const count=Number(settings.max_page);
  if(!Number.isInteger(count)||count<1||count>50)throw new ReviewError('Soundbooth index pagination exceeds the bounded discovery limit.');
  return Array.from({length:count-1},(_,i)=>new URL(`/series/page/${i+2}/`,base).href);
}
function asin(url: string): string | undefined {
  return url.match(/\/(?:dp|product)\/([A-Z0-9]{10})(?:[/?]|$)/)?.[1] ?? url.match(/\/pd\/(?:[^/]+\/)?([A-Z0-9]{10})(?:[/?]|$)/)?.[1];
}
export function parseRuntime(value: string): number | null {
  const hours=Number(value.match(/(\d+)\s*(?:hours?|hrs?)/i)?.[1]??0), minutes=Number(value.match(/(\d+)\s*(?:minutes?|mins?)/i)?.[1]??0);
  return hours*60+minutes || null;
}
export function parseAethonBook(html: string): ExtractedBook {
  const $=load(html), details:Record<string,string>={};
  $('.mfb-details__row').each((_,el)=>{ details[clean($(el).find('.mfb-details__label').text())]=clean($(el).find('.mfb-details__value').text()); });
  const title=clean($('h1').first().text()), series=clean($('.book-series strong').first().text());
  // Some publisher pages omit the number field but state it explicitly in the title.
  const escaped=series.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const number=Number($('.book-series strong').eq(1).text()) || Number(title.match(new RegExp(`^${escaped}\\s+(?:Book\\s+)?(\\d+(?:\\.\\d+)?)(?=[:\\s]|$)`,'i'))?.[1]);
  const releaseDate=parseDate(details['Publication Date']??'');
  const links: ExtractedBook['links']=[];
  $('a[href]').each((_,el)=>{
    const label=clean($(el).text()), url=$(el).attr('href')!;
    if (!/^https:\/\//.test(url)) return;
    if (/^Buy The (Book|Audiobook)$/i.test(label)) links.push({url,format:/Audiobook/i.test(label)?'audiobook':'ebook',asin:asin(url)});
  });
  return {title,series,number,author:$('.mfs-author-credit-entry .mfs-author-name').map((_,el)=>clean($(el).text())).get().join(', '),
    description:paragraphs($,'.book-page-description'),coverUrl:$('.modfarm-cover-art img').first().attr('src')??null,
    releaseDate,publicationStatus:releaseDate ? releaseDate<=new Date().toISOString().slice(0,10)?'released':'announced':'unknown',
    format:'ebook',narrator:details['Audiobook Narrator']||null,links,
    audioReleaseDate:parseDate(details['Audiobook Publication Date']??''),audioRuntimeMinutes:parseRuntime(details['Audiobook Duration']??'')};
}
export function parseSbtBook(html: string): ExtractedBook {
  const $=load(html), full=clean($('h1').first().text()), match=full.match(/^(.+?),?\s+Book\s+(\d+(?:\.\d+)?):\s*(.+)$/i);
  if (!match) throw new ReviewError('Soundbooth production is not an individually numbered full book.');
  const row=(label:string)=>clean($('.summary-meta li,.audiobook-meta li').filter((_,el)=>$(el).find('span').first().text().includes(label)).first().text()).replace(new RegExp(`^${label}:?\\s*`),'');
  const releaseDate=parseDate(row('Release Date'));
  const url=$('.buy-ab a[href]').first().attr('href');
  return {title:match[3],series:match[1],number:Number(match[2]),author:$('.entry-summary h3 a').map((_,el)=>$(el).text()).get().join(', '),
    description:paragraphs($,'.synopsis'),coverUrl:$('.woocommerce-product-gallery__image img').first().attr('src')??null,
    releaseDate,publicationStatus:releaseDate ? releaseDate<=new Date().toISOString().slice(0,10)?'released':'announced':'unknown',format:'audiobook',narrator:row('Narration')||null,
    links:url?[{url,format:'audiobook',asin:asin(url)}]:[],audioReleaseDate:releaseDate,audioRuntimeMinutes:parseRuntime(row('Length'))};
}
export function parsePrhBook(html: string): ExtractedBook {
  const $=load(html);
  let entity: Record<string,any> | undefined;
  $('script[type="application/ld+json"]').each((_,el)=>{try { const json=JSON.parse($(el).text()); if(json.mainEntity?.['@type']==='Book') entity=json.mainEntity; } catch {}});
  if (!entity) throw new ReviewError('Publisher book structured data is missing.');
  const copy=$('#book-description-copy').first().clone(); copy.find('br').replaceWith('\n');
  const description=clean(copy.text());
  const ordinals=['first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth','eleventh','twelfth'];
  const order=description.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\s+(?:book|installment)\b/i);
  if (!order) throw new ReviewError('Publisher description does not establish the volume number.');
  const releaseDate=parseDate(entity.workExample?.[0]?.datePublished??'');
  return {title:entity.name,series:entity.isPartOf?.name??'',number:ordinals.indexOf(order[1].toLowerCase())+1,author:typeof entity.author==='string'?entity.author:entity.author?.name??'',
    description,coverUrl:entity.image??null,releaseDate,publicationStatus:releaseDate?releaseDate<=new Date().toISOString().slice(0,10)?'released':'announced':'unknown',format:'print',narrator:null,links:[],audioReleaseDate:null,audioRuntimeMinutes:null};
}
