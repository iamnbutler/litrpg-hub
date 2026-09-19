import { load } from 'cheerio';
import { clean, parseDate, parseRuntime } from './adapters.js';
import { normalizeIdentity } from '../../../src/lib/catalog.js';
import { ReviewError, type ExtractedBook, type SeedSeries } from './types.js';

/** Podium's recommendation carousel is deliberately outside the series grid. */
export function podiumSeriesLinks(html:string,base:string):{title:string;url:string}[] {
  const $=load(html),found=new Map<string,string>();
  $('main a[href^="/titles/"]').filter((_,el)=>$(el).find('[data-testid="grid-image"]').length>0).each((_,el)=>{
    const url=new URL($(el).attr('href')!,base);
    if(url.origin!==new URL(base).origin)return;
    found.set(url.href,clean($(el).find('img').first().attr('alt')??''));
  });
  return [...found].map(([url,title])=>({url,title}));
}
export function parsePodiumBook(html:string):ExtractedBook {
  const $=load(html);
  let data:Record<string,unknown>|undefined;
  $('script[type="application/ld+json"]').each((_,el)=>{try{const item=JSON.parse($(el).text());if(item['@type']==='Audiobook')data=item;}catch{}});
  const heading=clean($('[data-testid="title-header"]').first().text());
  const series=clean($('[data-testid="title-series"]').first().text()).match(/^(.+), Book (\d+(?:\.\d+)?)$/i);
  if(!data||!heading||!series)throw new ReviewError('Podium page is not an individually numbered audiobook.');
  const row=(name:string)=>clean($(`[data-testid="label-${name}"]`).first().children('span').last().text());
  const date=parseDate(row('release-date'));
  const description=clean($('[data-testid="description-section"]').first().find('[data-testid="story-header"],[data-testid="story-description"]').map((_,el)=>$(el).text()).get().join('\n\n'));
  const links:ExtractedBook['links']=[];
  $('[data-testid="sales-audiobook"] a[href],a.audiobook[href]').each((_,el)=>{
    const url=$(el).attr('href')!;if(!url.startsWith('https://'))return;
    let asin:string|undefined;const parsed=new URL(url);
    if(/(^|\.)audible\.[a-z.]+$/.test(parsed.hostname))asin=parsed.pathname.match(/\/pd\/(?:[^/]+\/)?([A-Z0-9]{10})(?:\/|$)/)?.[1];
    if(!links.some(l=>l.url===url))links.push({url,format:'audiobook',asin});
  });
  return {title:heading,series:series[1],number:Number(series[2]),author:$('[data-testid="label-written-by"] a').map((_,el)=>clean($(el).text()).replace(/^,\s*/, '')).get().join(', '),
    narrator:$('[data-testid="label-performed-by"] a').map((_,el)=>clean($(el).text()).replace(/^,\s*/, '')).get().join(', ')||null,
    description,coverUrl:typeof data.image==='string'?data.image:null,releaseDate:date,audioReleaseDate:date,audioRuntimeMinutes:parseRuntime(row('duration')),
    publicationStatus:date?date<=new Date().toISOString().slice(0,10)?'released':'announced':'unknown',format:'audiobook',links};
}

/** Author bibliographies establish book identity/order; a buy button alone is not an audio release. */
export function parsePortalAuthor(html:string,seed:SeedSeries):ExtractedBook[] {
  const $=load(html),author=clean($('h1.wp-block-post-title').first().text());
  if(!seed.authorAliases.some(a=>normalizeIdentity(a)===normalizeIdentity(author)))throw new ReviewError('Portal author page does not match the selected author.');
  const section=$('.ia-series-inner').filter((_,el)=>[seed.title,...seed.aliases].some(t=>normalizeIdentity(t)===normalizeIdentity($(el).find('h2').first().text()))).first();
  if(!section.length)throw new ReviewError('Portal bibliography does not contain the selected series.');
  const premise=clean(section.children('p.copy-wide').text());
  return section.find('.ia-book-card').map((_,el):ExtractedBook=>{
    const card=$(el),number=Number(card.find('.is-style-caption').text().match(/Book\s+(\d+)/i)?.[1]);
    const title=clean(card.find('.is-style-heading-h5').text());
    const url=card.find('a[href]').first().attr('href');
    return {title,series:seed.title,number,author,description:number===1?premise:'',coverUrl:card.find('img').attr('src')??null,
      releaseDate:null,audioReleaseDate:null,audioRuntimeMinutes:null,narrator:null,publicationStatus:'unknown',format:'ebook',
      links:url?[{url,format:'ebook'}]:[]};
  }).get();
}
