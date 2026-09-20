import type { CatalogHealth, HealthCheck, HealthScore, HealthStatus, SeriesHealth, WorkHealth } from '../catalog-health';
import { compareTitles } from '../title-sort';

export type InspectorFilter = 'all' | 'missing' | 'review';
export type InspectorSort = 'attention' | 'title' | 'completeness' | 'evidence' | 'freshness';
export const checkGroups = [
	{ id: 'audio', label: 'Verified audio', checks: ['audio-verified'] },
	{ id: 'date', label: 'Audio date', checks: ['audio-date'] },
	{ id: 'cover', label: 'Cover evidence', checks: ['cover-url', 'cover-asset', 'cover-observation'] },
	{ id: 'metadata', label: 'Metadata', checks: ['source-description', 'original-summary', 'extracted-metadata', 'reviewed-metadata', 'jev-assessment'] },
	{ id: 'readers', label: 'Reader evidence', checks: ['reader-sample', 'reader-adequacy', 'reader-traits', 'reader-observation'] },
	{ id: 'freshness', label: 'Source freshness', checks: ['source-freshness'] }
] as const;
export type CheckGroup = typeof checkGroups[number];
export const statusLabels: Record<HealthStatus, string> = { present: 'Present', missing: 'Missing', unknown: 'Unknown', stale: 'Stale' };
const severity: Record<HealthStatus, number> = { present: 0, unknown: 1, stale: 2, missing: 3 };

/** A missing check is missing catalog data, never proof that a book/audio edition does not exist. */
export function groupedCheck(checks: HealthCheck[], group: { id: string; label: string; checks: readonly string[] }): HealthCheck {
	const selected = group.checks.map((id) => checks.find((check) => check.id === id) ?? {
		id, label: id, status: 'unknown' as const, available: false,
		explanation: 'This check was not included in the snapshot.', sourceUrl: null, observedAt: null, dueAt: null
	});
	const status = selected.reduce<HealthStatus>((worst, check) => severity[check.status] > severity[worst] ? check.status : worst, 'present');
	return { id: group.id, label: group.label, status, available: selected.every((check) => check.available),
		explanation: selected.map((check) => `${check.label}: ${statusLabels[check.status]}. ${check.explanation}`).join('\n'),
		sourceUrl: null, observedAt: null, dueAt: null };
}

export function seriesGroupedCheck(series: SeriesHealth, group: CheckGroup): HealthCheck {
	return groupedCheck(series.checks, group.id === 'metadata' ? { ...group, checks: [...group.checks, 'series-summary', 'series-extracted-metadata', 'series-reviewed-metadata'] } : group);
}

export function groupCoverage(works: WorkHealth[], group: CheckGroup): { current: number; total: number } {
	return { current: works.filter((work) => groupedCheck(work.checks, group).status === 'present').length, total: works.length };
}

export interface SeriesRow {
	series: SeriesHealth;
	works: WorkHealth[];
	missing: boolean;
	review: boolean;
	missingWorks: number;
	attention: number;
	oldestSource: string | null;
}

/** Start from all canonical works, not the audiobook-only public discovery list. */
export function seriesRows(report: CatalogHealth): SeriesRow[] {
	const workGroups = new Map<string, WorkHealth[]>();
	for (const work of report.works) workGroups.set(work.seriesId, [...(workGroups.get(work.seriesId) ?? []), work]);
	return report.series.map((series) => {
		const works = [...(workGroups.get(series.id) ?? [])].sort((a, b) =>
			(a.number ?? Infinity) - (b.number ?? Infinity) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
		const statuses = [...series.checks.map((check) => check.status), ...series.issues.map((issue) => issue.status), ...works.flatMap((work) => work.checks.map((check) => check.status)), ...series.missingVolumes.map((gap) => gap.status)];
		const sourceDates = series.sources.map((source) => source.checkedAt).filter((date): date is string => !!date).sort();
		return { series, works, missing: statuses.includes('missing'), review: statuses.some((status) => status === 'unknown' || status === 'stale'),
			missingWorks: works.filter((work) => work.checks.some((check) => check.status === 'missing')).length,
			attention: works.reduce((n, work) => n + work.checks.filter((check) => check.status !== 'present').length, 0) + series.issues.length + series.missingVolumes.length,
			oldestSource: series.sources.some((source) => !source.checkedAt) ? null : sourceDates[0] ?? null };
	});
}

export function visibleSeries(rows: SeriesRow[], filter: InspectorFilter, query: string, sort: InspectorSort): SeriesRow[] {
	const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
	return rows.filter((row) => {
		if (filter === 'missing' && !row.missing || filter === 'review' && !row.review) return false;
		const text = `${row.series.title} ${row.series.author} ${row.works.map((work) => `${work.title} ${work.author}`).join(' ')}`.toLocaleLowerCase();
		return terms.every((term) => text.includes(term));
	}).sort((a, b) => {
		const order = sort === 'attention' ? b.attention - a.attention :
			sort === 'completeness' ? a.series.completeness.percent - b.series.completeness.percent :
			sort === 'evidence' ? a.series.evidenceQuality.percent - b.series.evidenceQuality.percent :
			sort === 'freshness' ? (a.oldestSource ?? '').localeCompare(b.oldestSource ?? '') : 0;
		return order || compareTitles(a.series.title, b.series.title) || a.series.id.localeCompare(b.series.id);
	});
}

export function formatDate(value: string | null, withTime = false): string {
	if (!value || !Number.isFinite(Date.parse(value))) return 'Unknown';
	return new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
		...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' } as const : {}) }).format(new Date(value));
}

export function safeSourceUrl(value: string | null): string | null {
	if (!value) return null;
	try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
	catch { return null; }
}

export function sourceHost(value: string): string { return new URL(value).hostname.replace(/^www\./, ''); }
export function percent(score: HealthScore): number { return Math.max(0, Math.min(100, Math.round(score.percent))); }
export function audioLabel(work: WorkHealth): string {
	return { released: 'Released', scheduled: 'Scheduled', undated: 'Date unknown', unverified: 'Unverified', none: 'No audio retained' }[work.audio.state];
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === 'string';
const nullableText = (value: unknown) => value === null || text(value);
const list = (value: unknown, valid: (item: unknown) => boolean) => Array.isArray(value) && value.every(valid);
const isStatus = (value: unknown) => text(value) && Object.hasOwn(statusLabels, value);
const score = (value: unknown) => record(value) && finite(value.percent) && value.percent >= 0 && value.percent <= 100 && finite(value.earned) && finite(value.possible) && text(value.explanation);
const check = (value: unknown) => record(value) && text(value.id) && text(value.label) && isStatus(value.status) && typeof value.available === 'boolean' && text(value.explanation) && nullableText(value.sourceUrl) && nullableText(value.observedAt) && nullableText(value.dueAt);
const source = (value: unknown) => record(value) && text(value.url) && isStatus(value.status) && nullableText(value.checkedAt) && nullableText(value.fetchedAt) && nullableText(value.nextCheckAt);
const issue = (value: unknown) => record(value) && text(value.code) && text(value.message) && isStatus(value.status) && value.status !== 'present';
const common = (value: unknown): value is Record<string, unknown> => record(value) && text(value.id) && text(value.title) && text(value.author) && score(value.completeness) && score(value.evidenceQuality) && list(value.checks, check) && list(value.issues, issue) && list(value.sources, source);

/** Reject a mismatched export explicitly instead of rendering misleading zeroes or partial rows. */
export function parseHealthSnapshot(value: unknown): CatalogHealth {
	const invalid = () => { throw new Error('This snapshot has an unsupported or incomplete format. Refresh after the next catalog export.'); };
	if (!record(value) || value.schemaVersion !== 1 || !text(value.generatedAt) || !Number.isFinite(Date.parse(value.generatedAt)) || !record(value.definitions) || !record(value.totals) || !record(value.thresholds)) return invalid();
	if (!['completeness', 'evidenceQuality', 'readerAdequacy', 'audio', 'cover', 'bibliography'].every((key) => text((value.definitions as Record<string, unknown>)[key])) ||
		!['series', 'works', 'confirmedAudioWorks', 'verifiedAudioDates', 'coverAssets', 'reviewedMetadata', 'adequateReaderSamples', 'meanCompleteness', 'meanEvidenceQuality'].every((key) => finite((value.totals as Record<string, unknown>)[key]))) return invalid();
	if (!list(value.series, (item) => common(item) && list(item.workIds, text) && finite(item.knownWorks) && finite(item.confirmedAudioWorks) &&
		list(item.missingVolumes, (gap) => record(gap) && finite(gap.number) && ['reviewed-bibliography', 'observed-numbering'].includes(String(gap.evidence)) && ['missing', 'unknown', 'stale'].includes(String(gap.status)) && text(gap.explanation) && list(gap.sourceUrls, text)) &&
		record(item.bibliography) && isStatus(item.bibliography.status) && ['verified', 'incomplete', 'unknown', 'stale'].includes(String(item.bibliography.audioCoverageStatus)) && list(item.bibliography.expectedNumbers, finite) && list(item.bibliography.missingWorkNumbers, finite) && nullableText(item.bibliography.reviewedAt) && nullableText(item.bibliography.validUntil) && list(item.bibliography.sourceUrls, text) && text(item.bibliography.explanation))) return invalid();
	if (!list(value.works, (item) => common(item) && text(item.seriesId) && (item.number === null || finite(item.number)) && list(item.formats, text) &&
		record(item.audio) && finite(item.audio.retainedEditionCount) && finite(item.audio.confirmedEditionCount) && ['released', 'scheduled', 'undated', 'unverified', 'none'].includes(String(item.audio.state)) && nullableText(item.audio.releaseDate) &&
		record(item.reader) && finite(item.reader.selectedCount) && finite(item.reader.minimum) && typeof item.reader.eligible === 'boolean' && typeof item.reader.currentTraits === 'boolean' && ['published', 'corrected', 'withheld', 'missing'].includes(String(item.reader.observation)) && list(item.reader.sourceUrls, text) &&
		record(item.cover) && nullableText(item.cover.url) && typeof item.cover.cached === 'boolean' && typeof item.cover.hashVerified === 'boolean' && typeof item.cover.observationCurrent === 'boolean' && (item.cover.bytes === null || finite(item.cover.bytes)) && nullableText(item.cover.checkedAt))) return invalid();
	const report = value as unknown as CatalogHealth;
	const ids = new Set(report.series.map((series) => series.id));
	if (ids.size !== report.series.length || new Set(report.works.map((work) => work.id)).size !== report.works.length || report.works.some((work) => !ids.has(work.seriesId))) return invalid();
	return report;
}

export async function fetchHealthSnapshot(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<CatalogHealth> {
	const response = await fetcher(url, { method: 'GET', cache: 'no-store', credentials: 'omit', signal });
	if (!response.ok) throw new Error(response.status === 404 ? 'The catalog health snapshot has not been published yet.' : `The snapshot could not be loaded (HTTP ${response.status}).`);
	let value: unknown;
	try { value = await response.json(); }
	catch { throw new Error('The snapshot response could not be read. Try refreshing it.'); }
	return parseHealthSnapshot(value);
}
