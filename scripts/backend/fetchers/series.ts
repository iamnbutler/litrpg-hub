import { load } from 'cheerio';
import { normalizeIdentity } from '../../../src/lib/catalog.js';
import { createHttpClient } from '../http.js';
import { completeFetchRun, insertFetchRun, upsertBook, upsertBookSource, getBook, setBookSubgenresWithMeta } from '../db/index.js';
import { productToBookRow, type AudibleProduct } from './audible.js';

export interface SeriesReference { id: string; asin: string; title: string; slug: string; authors: string[]; genres: string[] }
export interface SeriesPage { asins: string[]; descriptions: Record<string, string>; next: string | null }

export function parseSeriesPage(html: string, pageUrl: string): SeriesPage {
	const $ = load(html);
	if (/robot check|captcha/i.test($('title').text())) throw new Error('Audible requested a browser check. No data or cursor changed.');
	// Recommendations, samples, and upsells live outside these product containers.
	const asins = [...new Set($('.productListItem[id^="product-list-item-"]').map((_, el) => $(el).attr('id')!.replace('product-list-item-', '')).get().filter(id => /^[A-Z0-9]{10}$/.test(id)))];
	if (!asins.length) throw new Error('No series product list was found. The source may be blocked or its markup may have changed.');
	const descriptions: Record<string, string> = {};
	$('.productListItem[id^="product-list-item-"]').each((_, el) => {
		const id = $(el).attr('id')!.replace('product-list-item-', '');
		// The product's own popover contains the publisher synopsis, separate from reviews.
		const summary = $(el).find('.bc-popover-inner > p').map((_, p) => $(p).text().replace(/\s+/g, ' ').trim()).get().filter(text => text.length >= 60).sort((a,b) => b.length - a.length)[0];
		if (asins.includes(id) && summary) descriptions[id] = summary;
	});
	const current = new URL(pageUrl), currentPage = Number(current.searchParams.get('page') ?? 1);
	const nextPages = $('a[href]').map((_, el) => $(el).attr('href')!).get().flatMap(href => {
		try {
			const url = new URL(href, current);
			const page = Number(url.searchParams.get('page'));
			return url.origin === current.origin && url.pathname === current.pathname && Number.isInteger(page) && page > currentPage ? [{ url: url.href, page }] : [];
		} catch { return []; }
	}).sort((a,b) => a.page - b.page);
	return { asins, descriptions, next: nextPages[0]?.url ?? null };
}

/** Stable source ID plus an independently checked author. A title match alone is not enough. */
export function matchesSeries(product: AudibleProduct, series: SeriesReference): boolean {
	return Boolean(product.series?.some(s => s.asin === series.asin) && product.authors?.some(author =>
		series.authors.some(expected => normalizeIdentity(expected) === normalizeIdentity(author.name))));
}

async function getHtml(url: string): Promise<string> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'litrpg-hub/0.1 (+https://github.com/iamnbutler/litrpg-hub)' } });
		if (response.ok) return response.text();
		if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) throw new Error(`Series page returned HTTP ${response.status}.`);
		await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
	}
	throw new Error('Series page could not be loaded.');
}

export async function fetchSeries(series: SeriesReference, options: { limit: number; dryRun?: boolean }): Promise<{ found: number; updated: number; complete: boolean }> {
	let url: string | null = `https://www.audible.com/series/${series.slug}/${series.asin}`;
	const http = createHttpClient({ minDelayMs: 600, maxRetries: 2 });
	const seen = new Set<string>(), visited = new Set<string>();
	let updated = 0, pages = 0, attempted = 0;
	if (options.dryRun) { console.log(`Would fetch ${series.title}, maximum ${options.limit} product lookups.`); return { found: 0, updated: 0, complete: false }; }
	const runId = insertFetchRun('audible', `series-page:${series.asin}`, 0);
	try {
		while (url && pages < 10) {
			if (visited.has(url)) throw new Error('Series pagination loop detected.');
			visited.add(url);
			const page = parseSeriesPage(await getHtml(url), url);
			pages++;
			for (const asin of page.asins) {
				if (seen.has(asin)) continue;
				seen.add(asin);
				if (attempted >= options.limit) {
					completeFetchRun(runId, pages, updated, 'partial');
					return { found: seen.size, updated, complete: false };
				}
				attempted++;
				const data = await http.get<{ product?: AudibleProduct }>(`https://api.audible.com/1.0/catalog/products/${asin}`, {
					response_groups: 'product_attrs,contributors,series,media,rating,category_ladders', image_sizes: '500'
				});
				const product = data.product;
				if (!product || product.asin !== asin || !product.series?.length || !product.authors?.length) throw new Error(`Incomplete product response for ${asin}. Stopping to preserve existing metadata.`);
				if (!matchesSeries(product, series)) { console.log(`Skipped ${asin}: series ID or author mismatch.`); continue; }
				if (product.language?.toLowerCase() !== 'english') continue;
				const existing = getBook(asin);
				if (!existing && !product.title) throw new Error(`New product ${asin} is missing its title.`);
				const matchingSeries = product.series!.find(s => s.asin === series.asin)!;
				// The API may list a shared universe before the series we actually verified.
				const row = productToBookRow({ ...product, series: [matchingSeries] });
				const description = page.descriptions[asin];
				if (description && description.length > (row.description?.length ?? 0)) row.description = description;
				upsertBook(row);
				upsertBookSource(asin, 'audible', JSON.stringify(product));
				if (description) upsertBookSource(asin, 'audible-series', JSON.stringify({ description, url, seriesAsin: series.asin }));
				setBookSubgenresWithMeta(asin, series.genres.map(subgenre => ({ subgenre, confidence: 1, source: 'series-reference' })));
				updated++;
				console.log(`${existing ? 'Refreshed' : 'Added'} #${row.series_number ?? '?'} ${row.title}`);
			}
			url = page.next;
		}
		const complete = url === null;
		completeFetchRun(runId, pages, updated, complete ? 'completed' : 'partial');
		return { found: seen.size, updated, complete };
	} catch (error) {
		completeFetchRun(runId, pages, updated, 'failed');
		throw error;
	}
}
