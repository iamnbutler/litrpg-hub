import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import type { CatalogHealth, HealthCheck, HealthScore, SeriesHealth, WorkHealth } from '../catalog-health';
import { audioLabel, checkGroups, fetchHealthSnapshot, groupCoverage, groupedCheck, parseHealthSnapshot, safeSourceUrl, seriesGroupedCheck, seriesRows, visibleSeries } from './health-view';
import SeriesInspector from './SeriesInspector.svelte';
import InspectorPage from '../../routes/inspector/+page.svelte';

vi.mock('$app/paths', () => ({ resolve: (path: string) => `/litrpg-hub${path}`, asset: (path: string) => `/litrpg-hub${path}` }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('https://example.test/litrpg-hub/inspector/') } }));

const NOW = '2026-09-19T15:04:00.000Z';
const score = (percent = 100): HealthScore => ({ percent, earned: percent, possible: 100, explanation: 'A catalog evidence measure, not a book rating.' });
function check(id: string, status: HealthCheck['status'] = 'present'): HealthCheck {
	return { id, label: id, status, available: status !== 'missing', explanation: `Evidence for ${id}.`, sourceUrl: null, observedAt: NOW, dueAt: null };
}
const checks = () => [...new Set(checkGroups.flatMap((group) => [...group.checks]))].map((id) => check(id));
function work(over: Partial<WorkHealth> = {}): WorkHealth {
	return {
		id: 'work-series-1', seriesId: 'series', number: 1, title: 'First Title', author: 'A. Author', formats: ['audiobook'], publicationStatus: 'released',
		completeness: score(), evidenceQuality: score(), checks: checks(), issues: [],
		flags: { sourceDescription: true, summary: true, metadataExtracted: true, metadataReviewed: true, audiobook: true, audioVerified: true, audioDateVerified: true, coverAsset: true, coverReviewed: true, readerSample: true, readerAdequate: true },
		audio: { retainedEditionCount: 1, confirmedEditionCount: 1, state: 'released', releaseDate: '2026-01-01' },
		reader: { retainedCount: 943, selectedCount: 12, minimum: 10, eligible: true, currentTraits: true, observation: 'published', sourceUrls: [] },
		cover: { url: null, cached: true, hashVerified: true, bytes: 12_300, observationCurrent: true, checkedAt: NOW }, sources: [], ...over
	};
}
function series(over: Partial<SeriesHealth> = {}): SeriesHealth {
	return {
		id: 'series', title: 'A Series', author: 'A. Author', workIds: ['work-series-1'], knownWorks: 1, confirmedAudioWorks: 1,
		completeness: score(), evidenceQuality: score(), checks: [...checks(), check('series-summary'), check('series-extracted-metadata'), check('series-reviewed-metadata'), check('bibliography')], issues: [], missingVolumes: [], sources: [],
		bibliography: { status: 'present', audioCoverageStatus: 'verified', expectedNumbers: [1], missingWorkNumbers: [], reviewedAt: NOW, validUntil: '2026-09-26T15:04:00.000Z', sourceUrls: ['https://example.test/author/series'], explanation: 'A reviewed list of expected audio works.' }, ...over
	};
}
function report(works = [work()], allSeries = [series()]): CatalogHealth {
	return { schemaVersion: 1, generatedAt: NOW,
		definitions: { completeness: 'Retained data fields.', evidenceQuality: 'Current proof and review.', readerAdequacy: 'Usable sampled comments.', audio: 'Verified audio only.', cover: 'Cached bytes and their current observation.', bibliography: 'An explicit reviewed list.' },
		thresholds: { sourceDescriptionChars: 500, readerVoices: 10, readerBodyChars: 80, readerCap: 50, coverFreshnessDays: 30 },
		totals: { series: allSeries.length, works: works.length, confirmedAudioWorks: 1, verifiedAudioDates: 1, coverAssets: 1, reviewedMetadata: 1, adequateReaderSamples: 1, meanCompleteness: 100, meanEvidenceQuality: 100 }, series: allSeries, works
	};
}

describe('inspector membership and honest missing states', () => {
	it('keeps a source-only later work in its series, even when no audiobook exists in the retained data', () => {
		const sourceOnly = work({ id: 'work-series-2', number: 2, title: 'The Later Source Title', formats: ['ebook'], audio: { retainedEditionCount: 0, confirmedEditionCount: 0, state: 'none', releaseDate: null } });
		const rows = seriesRows(report([sourceOnly, work()]));
		expect(rows[0].works.map((work) => work.number)).toEqual([1, 2]);
		expect(visibleSeries(rows, 'all', 'later source', 'title')).toHaveLength(1);
		expect(audioLabel(sourceOnly)).toBe('No audio retained');
	});
	it('puts unknown evidence in review without manufacturing missing data', () => {
		const data = report([work({ checks: [check('audio-verified', 'unknown')] })]);
		const rows = seriesRows(data);
		expect(visibleSeries(rows, 'missing', '', 'attention')).toEqual([]);
		expect(visibleSeries(rows, 'review', '', 'attention')).toHaveLength(1);
		expect(groupedCheck([], checkGroups[0]).status).toBe('unknown');
	});
	it('keeps mixed missing and unresolved evidence in both views', () => {
		const data = report([work()], [series({ checks: [check('cover-observation', 'missing')], issues: [{ code: 'cover-observation', status: 'unknown', message: 'Another work has unresolved evidence.' }] })]);
		const rows = seriesRows(data);
		expect(visibleSeries(rows, 'missing', '', 'attention')).toHaveLength(1);
		expect(visibleSeries(rows, 'review', '', 'attention')).toHaveLength(1);
	});
	it('does not treat an inferred numbering gap as a proved missing book', () => {
		const data = report([work()], [series({ missingVolumes: [{ number: 3, evidence: 'observed-numbering', status: 'unknown', explanation: 'The numbering needs investigation.', sourceUrls: [] }] })]);
		expect(seriesRows(data)[0]).toMatchObject({ missing: false, review: true });
		const html = render(SeriesInspector, { props: { series: data.series[0], works: data.works } }).body;
		expect(html).toContain('Numbering needs review');
		expect(html).not.toContain('Reviewed bibliography</span>');
	});
	it('includes series-specific review in the metadata column', () => {
		const data = series({ checks: [...checks(), check('series-summary'), check('series-extracted-metadata'), check('series-reviewed-metadata', 'stale')] });
		expect(seriesGroupedCheck(data, checkGroups[3]).status).toBe('stale');
		expect(groupedCheck(checks(), checkGroups[3]).status).toBe('present');
	});
	it('shows partial coverage without counting missing, unknown, or stale work evidence as current', () => {
		const partial = ['present', 'missing', 'unknown', 'stale'].map((status, index) => work({ id: `work-${index}`, checks: [check('cover-url'), check('cover-asset'), check('cover-observation', status as HealthCheck['status'])] }));
		expect(groupCoverage(partial, checkGroups[2])).toEqual({ current: 1, total: 4 });
		expect(groupCoverage([work({ checks: [] })], checkGroups[2])).toEqual({ current: 0, total: 1 });
	});
	it('ranks data completeness and evidence independently without changing canonical work order', () => {
		const a = series({ id: 'a', title: 'Same title', completeness: score(100), evidenceQuality: score(20) });
		const b = series({ id: 'b', title: 'Same title', completeness: score(60), evidenceQuality: score(90) });
		const rows = seriesRows(report([], [a, b]));
		expect(visibleSeries(rows, 'all', '', 'completeness').map((row) => row.series.id)).toEqual(['b', 'a']);
		expect(visibleSeries(rows, 'all', '', 'evidence').map((row) => row.series.id)).toEqual(['a', 'b']);
		expect(visibleSeries([...rows].reverse(), 'all', '', 'title').map((row) => row.series.id)).toEqual(['a', 'b']);
		expect(rows.map((row) => row.series.id)).toEqual(['a', 'b']);
	});
	it('puts undated source checks before known dates when sorting for freshness', () => {
		const a = series({ id: 'a', sources: [{ url: 'https://example.test/a', status: 'present', checkedAt: NOW, fetchedAt: NOW, nextCheckAt: null }] });
		const b = series({ id: 'b', sources: [{ url: 'https://example.test/b', status: 'unknown', checkedAt: null, fetchedAt: null, nextCheckAt: null }] });
		expect(visibleSeries(seriesRows(report([], [a, b])), 'all', '', 'freshness').map((row) => row.series.id)).toEqual(['b', 'a']);
	});
});

describe('public snapshot read boundary', () => {
	it('accepts the contract, including a genuinely empty catalog', () => {
		expect(parseHealthSnapshot(report()).works).toHaveLength(1);
		expect(parseHealthSnapshot(report([], [])).series).toEqual([]);
	});
	it.each([
		{ ...report(), schemaVersion: 2 },
		{ ...report(), generatedAt: 'not a timestamp' },
		{ ...report(), definitions: {} },
		{ ...report(), works: [{ ...work(), reader: null }] },
		{ ...report(), works: [work({ seriesId: 'not-in-snapshot' })] },
		{ ...report(), works: [work(), work()] },
		{ ...report(), series: [series(), series()] }
	])('rejects incomplete or mismatched exports instead of silently dropping records', (value) => {
		expect(() => parseHealthSnapshot(value)).toThrow('unsupported or incomplete format');
	});
	it('only fetches the snapshot with GET, no cache and no credentials', async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(report())));
		const signal = new AbortController().signal;
		await fetchHealthSnapshot('/litrpg-hub/data/health.json', signal, fetcher);
		expect(fetcher).toHaveBeenCalledExactlyOnceWith('/litrpg-hub/data/health.json', { method: 'GET', cache: 'no-store', credentials: 'omit', signal });
	});
	it('reports an unpublished snapshot without displaying response payloads', async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response('PRIVATE_RESPONSE_MARKER', { status: 404 }));
		await expect(fetchHealthSnapshot('/data/health.json', new AbortController().signal, fetcher)).rejects.toThrow('has not been published yet');
	});
	it('does not reveal an invalid response body in the error message', async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response('<html>PRIVATE_RESPONSE_MARKER</html>'));
		await expect(fetchHealthSnapshot('/data/health.json', new AbortController().signal, fetcher)).rejects.toThrow('The snapshot response could not be read. Try refreshing it.');
	});
	it.each(['javascript:alert(1)', 'data:text/html,unsafe', 'https://user:secret@example.test/path', '/private-file', 'not a url'])('rejects unsafe source links: %s', (url) => {
		expect(safeSourceUrl(url)).toBeNull();
	});
	it('allows ordinary public source links', () => expect(safeSourceUrl('https://publisher.example/book/1')).toBe('https://publisher.example/book/1'));
});

describe('inspector rendering', () => {
	it('does not show fabricated zero metrics while the snapshot is loading', () => {
		const html = render(InspectorPage).body;
		expect(html).toContain('Loading catalog checks');
		expect(html).not.toContain('0 known works');
		expect(html).not.toContain('Mean across works');
		expect(html).toContain('/litrpg-hub/inspector/');
	});
	it('shows source-only works, usable reader counts, independent scores, and a base-aware Hub link', () => {
		const sourceOnly = work({ id: 'work-series-2', number: 2, title: 'Source-only Volume', formats: ['ebook'], checks: [check('audio-verified', 'unknown')], audio: { retainedEditionCount: 0, confirmedEditionCount: 0, state: 'none', releaseDate: null } });
		const html = render(SeriesInspector, { props: { series: series(), works: [work(), sourceOnly] } }).body;
		expect(html).toContain('Source-only Volume');
		expect(html).toContain('No audio retained');
		expect(html).toContain('12 usable / 10 min.');
		expect(html).not.toContain('943');
		expect(html).toContain('Data completeness');
		expect(html).toContain('Evidence quality');
		expect(html).toContain('/litrpg-hub/?view=series&amp;series=series');
	});
	it('shows scheduled audio as scheduled and does not insert a fake missing work', () => {
		const scheduled = work({ audio: { retainedEditionCount: 1, confirmedEditionCount: 1, state: 'scheduled', releaseDate: '2027-04-01' } });
		const html = render(SeriesInspector, { props: { series: series(), works: [scheduled] } }).body;
		expect(html).toContain('Scheduled');
		expect(html).toContain('Apr 1, 2027');
		expect(html).not.toContain('Volume 2');
	});
});
