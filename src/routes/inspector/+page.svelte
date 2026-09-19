<script lang="ts">
	import { onMount } from 'svelte';
	import { asset, resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { CatalogHealth } from '$lib/catalog-health';
	import Icon from '$lib/components/Icon.svelte';
	import CheckStatus from '$lib/inspector/CheckStatus.svelte';
	import DataScore from '$lib/inspector/DataScore.svelte';
	import SeriesInspector from '$lib/inspector/SeriesInspector.svelte';
	import { checkGroups, fetchHealthSnapshot, formatDate, groupCoverage, seriesGroupedCheck, seriesRows, visibleSeries, type InspectorFilter, type InspectorSort } from '$lib/inspector/health-view';

	let report = $state.raw<CatalogHealth | null>(null);
	let loading = $state(true);
	let error = $state('');
	let announcement = $state('');
	let filter = $state<InspectorFilter>('all');
	let sort = $state<InspectorSort>('attention');
	let query = $state('');
	let request: AbortController | null = null;
	let destroyed = false;
	const selectedId = $derived(page.url.searchParams.get('series'));
	const rows = $derived(report ? seriesRows(report) : []);
	const shown = $derived(visibleSeries(rows, filter, query, sort));
	const selected = $derived(rows.find((row) => row.series.id === selectedId));
	const counts = $derived({ all: rows.length, missing: rows.filter((row) => row.missing).length, review: rows.filter((row) => row.review).length });
	const filters: { id: InspectorFilter; label: string; icon: string }[] = [
		{ id: 'all', label: 'All series', icon: 'book' }, { id: 'missing', label: 'Missing data', icon: 'filter' }, { id: 'review', label: 'Needs review', icon: 'info' }
	];
	const filterLabels: Record<InspectorFilter, string> = { all: 'All series', missing: 'Missing data', review: 'Needs review' };

	async function refreshSnapshot() {
		request?.abort();
		const current = new AbortController();
		request = current;
		loading = true; error = ''; announcement = '';
		let timedOut = false;
		const timeout = setTimeout(() => { timedOut = true; current.abort(); }, 20_000);
		try {
			const next = await fetchHealthSnapshot(asset('/data/health.json'), current.signal);
			if (destroyed || current !== request) return;
			report = next;
			announcement = `Snapshot loaded. ${next.totals.series} series, ${next.totals.works} known works. Generated ${formatDate(next.generatedAt, true)}.`;
		} catch (cause) {
			if (destroyed || current !== request) return;
			error = timedOut ? 'The snapshot request timed out. Try refreshing it.' :
				cause instanceof Error && !(cause instanceof TypeError) ? cause.message : 'The snapshot could not be reached. Check your connection and try again.';
		} finally {
			clearTimeout(timeout);
			if (!destroyed && current === request) loading = false;
		}
	}
	function selectFilter(next: InspectorFilter) {
		filter = next;
		if (selectedId) void goto(resolve('/inspector/'), { keepFocus: true });
	}
	function resetFilters() { query = ''; filter = 'all'; sort = 'attention'; }
	onMount(() => {
		void refreshSnapshot();
		return () => { destroyed = true; request?.abort(); };
	});
</script>

<svelte:head>
	<title>{selected ? `${selected.series.title} · ` : ''}Catalog inspector · Shelf Goblin</title>
	<meta name="description" content="Inspect the completeness, evidence, and missing data behind the Shelf Goblin core catalog." />
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="inspector">
	<a class="inspector-skip" href="#inspector-content">Skip to catalog</a>
	<aside class="inspector-sidebar" aria-label="Catalog inspector navigation">
		<a class="inspector-brand" href={resolve('/inspector/')}><span class="inspector-mark" aria-hidden="true">🪎</span><span><strong>Shelf Goblin</strong><small>CATALOG INSPECTOR</small></span></a>
		<div class="nav-section-label">CORE CATALOG</div>
		<nav class="inspector-nav" aria-label="Series filters">
			{#each filters as item (item.id)}
				<button class:chosen={filter === item.id && !selectedId} aria-pressed={filter === item.id && !selectedId} onclick={() => selectFilter(item.id)}>
					<Icon name={item.icon} size={17} /><span>{item.label}</span><span class="nav-total">{report ? counts[item.id] : '—'}</span>
				</button>
			{/each}
		</nav>
		<div class="sidebar-links"><a href="#inspector-definitions"><Icon name="info" size={16} /> How checks work</a><a href={resolve('/')}><Icon name="back" size={16} /> Open Shelf Goblin</a></div>
		<div class="sidebar-foot"><span class="snapshot-marker" class:loaded={!!report}></span><span>{report ? 'Public snapshot' : loading ? 'Loading snapshot' : 'Snapshot unavailable'}<small>Read only · no background jobs</small></span></div>
	</aside>

	<main id="inspector-content" class="inspector-main">
		<header class="inspector-header">
			<div>
				{#if selectedId}<a class="back-link" href={resolve('/inspector/')}><Icon name="back" size={14} /> Back to series</a>{/if}
				<div class="title-line"><h1>{selected ? selected.series.title : selectedId && report ? 'Series not found' : 'Catalog inspector'}</h1><span class="read-only">READ ONLY</span></div>
				<p>{selected ? `${selected.series.author} · All known works and their evidence` : 'Core series, missing data, and the evidence behind each record.'}</p>
			</div>
			<div class="snapshot-tools"><span class="snapshot-time"><Icon name="clock" size={13} />{report ? formatDate(report.generatedAt, true) : loading ? 'Loading snapshot…' : 'No snapshot loaded'}</span>
				<button class="refresh-button" onclick={refreshSnapshot} disabled={loading} title="Reload the published snapshot. Does not run any catalog jobs.">
					<svg class:spinning={loading} aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5M4 17v-5h5M5.5 7a8 8 0 0 1 13-2L20 7M4 17l1.5 2a8 8 0 0 0 13-2" /></svg>
					{loading ? 'Loading…' : 'Refresh snapshot'}
				</button>
			</div>
		</header>

		<p class="visually-hidden" role="status">{announcement}</p>
		{#if error}
			<div class="snapshot-error" role="alert"><Icon name="info" size={18} /><div><strong>{report ? 'Refresh failed' : 'Snapshot unavailable'}</strong><p>{error}</p>{#if report}<p>Still showing the snapshot from {formatDate(report.generatedAt, true)}.</p>{/if}</div><button onclick={refreshSnapshot} disabled={loading}>Try again</button></div>
		{/if}

		{#if loading && !report}
			<div class="initial-loading" role="status"><span class="loading-dot"></span>Loading catalog checks…</div>
			<div class="table-skeleton" aria-hidden="true">{#each [1, 2, 3, 4, 5, 6] as row (row)}<div><span></span><span></span><span></span><span></span></div>{/each}</div>
		{:else if report}
			{#if selected}
				{#key selected.series.id}<SeriesInspector series={selected.series} works={selected.works} />{/key}
			{:else if selectedId}
				<div class="inspector-empty"><Icon name="search" size={28} /><h2>This series is not in the snapshot</h2><p>The inspector includes the core catalog. A series in the wider Hub may not have a core record.</p><a href={resolve('/inspector/')}>Return to all series</a></div>
			{:else}
				<div class="catalog-summary" aria-label="Snapshot totals">
					<div><span>Core series</span><strong>{report.totals.series}<small>{report.totals.works} known works</small></strong></div>
					<div><span>Verified audio</span><strong>{report.totals.confirmedAudioWorks}<small>of {report.totals.works} known works</small></strong></div>
					<div class="data-summary"><span>Data completeness</span><strong>{Math.round(report.totals.meanCompleteness)}<span class="summary-percent">%</span><small>Mean across works</small></strong></div>
					<div class="evidence-summary"><span>Evidence quality</span><strong>{Math.round(report.totals.meanEvidenceQuality)}<span class="summary-percent">%</span><small>Mean across works</small></strong></div>
				</div>

				<section class="series-section" aria-labelledby="series-table-heading">
					<div class="catalog-toolbar"><div class="table-heading"><h2 id="series-table-heading">{filterLabels[filter]}</h2><span>{shown.length} of {rows.length}</span></div>
						<label class="inspector-search"><Icon name="search" size={15} /><span class="visually-hidden">Search series, authors, or books</span><input type="search" bind:value={query} placeholder="Search series, author, or book…" autocomplete="off" spellcheck="false" /></label>
						<label class="sort-control"><span>Sort</span><select bind:value={sort} aria-label="Sort series"><option value="attention">Most gaps & review</option><option value="title">Title A–Z</option><option value="completeness">Lowest data completeness</option><option value="evidence">Lowest evidence quality</option><option value="freshness">Oldest source check</option></select></label>
					</div>
					<div class="table-context"><p>Scores describe catalog data, never book quality.</p><span>Missing = data not retained · Unknown = unresolved evidence</span></div>
					{#if shown.length}
						<div class="series-table-scroll" role="region" aria-label="Series evidence table">
							<table class="series-table"><caption class="visually-hidden">Core catalog series. Select a series to inspect every known work, including those without verified audio.</caption>
								<thead><tr><th scope="col">Series</th><th scope="col">Data</th><th scope="col">Evidence</th>{#each checkGroups as group (group.id)}<th scope="col">{group.label}</th>{/each}</tr></thead>
								<tbody>{#each shown as row (row.series.id)}<tr>
									<th scope="row"><a class="series-title" href={resolve(`/inspector/?series=${encodeURIComponent(row.series.id)}`)}><span class="series-symbol"><Icon name="book" size={17} /></span><span><strong>{row.series.title}</strong><small>{row.series.author} <span class="work-count">· {row.works.length} works</span></small></span><span class="series-chevron"><Icon name="chevron" size={14} /></span></a></th>
									<td><DataScore score={row.series.completeness} label="Data completeness" /></td><td><DataScore score={row.series.evidenceQuality} label="Evidence quality" kind="evidence" /></td>
									{#each checkGroups as group (group.id)}{@const check = seriesGroupedCheck(row.series, group)}{@const coverage = groupCoverage(row.works, group)}<td><CheckStatus status={check.status} explanation={check.explanation} label={group.id === 'audio' && check.status === 'present' ? 'Verified' : undefined} />{#if group.id === 'audio'}<small>{row.series.confirmedAudioWorks} / {row.works.length} works</small>{:else}<small>{coverage.current} / {coverage.total} current</small>{/if}</td>{/each}
								</tr>{/each}</tbody>
							</table>
						</div>
					{:else}
						<div class="inspector-empty"><Icon name="search" size={28} /><h2>{rows.length ? 'No matching series' : 'No core series in this snapshot'}</h2><p>{rows.length ? 'Try another title, author, or view. Your filters only affect this inspector.' : 'There are no records to inspect in the published snapshot.'}</p>{#if rows.length}<button onclick={resetFilters}>Clear search and filters</button>{/if}</div>
					{/if}
				</section>
			{/if}

			<details class="inspector-definitions" id="inspector-definitions"><summary><Icon name="info" size={14} /> How the checks work <span>Data and evidence, not ratings</span></summary>
				<div class="definitions-grid"><section><h2>Data completeness</h2><p>{report.definitions.completeness}</p></section><section><h2>Evidence quality</h2><p>{report.definitions.evidenceQuality}</p></section><section><h2>Verified audio</h2><p>{report.definitions.audio}</p></section><section><h2>Cover evidence</h2><p>{report.definitions.cover}</p></section><section><h2>Reader samples</h2><p>{report.definitions.readerAdequacy}</p></section><section><h2>Bibliography</h2><p>{report.definitions.bibliography}</p></section></div>
			</details>
			<footer class="inspector-footer"><div class="status-legend" aria-label="Check status legend"><CheckStatus status="present" /><CheckStatus status="missing" /><CheckStatus status="unknown" /><CheckStatus status="stale" /></div><p>Checks as of {formatDate(report.generatedAt, true)}. Refresh reloads this file; it does not run checks.</p></footer>
		{/if}
	</main>
</div>

<style>
	.inspector { --ins-line:#2a3442; --ins-panel:#1b222d; --green:#7bd5d5; color-scheme:dark; display:grid; grid-template-columns:205px minmax(0,1fr); min-height:100vh; min-height:100dvh; background:#131923; color:#dce5f1; font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
	.inspector :global(:is(a,button,input,select,summary):focus-visible) { outline:2px solid #80d7dd; outline-offset:3px; }
	.inspector-skip { position:fixed; left:16px; top:-60px; z-index:100; color:#10212a; background:#8edee0; padding:10px 14px; border-radius:4px; } .inspector-skip:focus { top:12px; }
	.inspector-sidebar { position:sticky; top:0; height:100vh; height:100dvh; display:flex; flex-direction:column; background:#10151d; border-right:1px solid #28313d; padding:25px 12px 18px; }
	.inspector-brand { display:flex; align-items:center; gap:11px; padding:0 9px; color:#e2eaf4; text-decoration:none; margin-bottom:42px; }
	.inspector-mark { flex-shrink:0; width:31px; height:35px; display:grid; place-items:center; font:27px/1 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif; }
	.inspector-brand strong { display:block; font-size:17px; letter-spacing:.01em; font-weight:650; } .inspector-brand small { display:block; margin-top:5px; font-size:8px; color:#8396ac; letter-spacing:.12em; }
	.nav-section-label { color:#64758b; letter-spacing:.11em; font-size:9px; font-weight:650; padding:0 12px 11px; }
	.inspector-nav { display:flex; flex-direction:column; gap:4px; align-self:auto; min-height:0; }
	.inspector-nav button { display:flex; align-items:center; gap:10px; width:100%; padding:11px 12px; border:1px solid transparent; border-radius:4px; background:transparent; color:#9baabf; text-align:left; font-size:12px; }
	.inspector-nav button:hover { color:#e0eaf5; background:#1b2532; } .inspector-nav button.chosen { background:#223342; border-color:#344c5d; color:#9adfe3; font-weight:550; }
	.nav-total { margin-left:auto; color:#9dadc1; font:10px ui-monospace,SFMono-Regular,Consolas,monospace; background:#101b27; border-radius:3px; padding:2px 5px; min-width:22px; text-align:center; }
	.sidebar-links { display:flex; flex-direction:column; gap:5px; margin-top:22px; padding-top:16px; border-top:1px solid #232e3b; }
	.sidebar-links a { padding:9px 12px; display:flex; align-items:center; gap:10px; color:#8d9eb4; font-size:11px; }
	.sidebar-foot { margin-top:auto; padding:30px 10px 0; display:flex; align-items:start; gap:8px; color:#a9b7c8; font-size:10px; line-height:1.5; }
	.sidebar-foot small { display:block; color:#64778f; font-size:9px; margin-top:4px; } .snapshot-marker { width:6px; height:6px; background:#6a7c92; border-radius:50%; flex:none; margin-top:4px; } .snapshot-marker.loaded { background:#71c9ad; }
	.inspector-main { min-width:0; padding:27px 27px 18px; }
	.inspector-header { display:flex; align-items:start; justify-content:space-between; gap:24px; margin-bottom:26px; }
	.title-line { display:flex; align-items:center; gap:12px; } h1 { font-size:22px; letter-spacing:-.025em; font-weight:600; line-height:1.35; color:#e7edf6; }
	.read-only { font-size:8px; letter-spacing:.06em; padding:3px 5px; white-space:nowrap; border:1px solid #3c4b5d; color:#8b9eb6; border-radius:3px; }
	.inspector-header p { margin-top:7px; font-size:11px; color:#90a1b8; line-height:1.6; }
	.back-link { color:#8fcfd4; font-size:11px; display:inline-flex; gap:6px; align-items:center; margin-bottom:12px; }
	.snapshot-tools { display:flex; flex-direction:column; align-items:end; gap:9px; flex:none; }
	.snapshot-time { display:flex; align-items:center; gap:6px; color:#8a9bb1; font:10px ui-monospace,SFMono-Regular,Consolas,monospace; white-space:nowrap; }
	.refresh-button { display:inline-flex; gap:7px; align-items:center; min-height:32px; border:1px solid #3b4b5e; border-radius:4px; background:#202b39; color:#cbdaec; font-size:11px; padding:6px 10px; }
	.refresh-button:hover:not(:disabled) { border-color:#638198; background:#28384a; }
	.catalog-summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border:1px solid #2e3948; border-radius:5px; background:#1a222e; margin-bottom:24px; }
	.catalog-summary > div { padding:15px 18px; border-right:1px solid #2d3745; } .catalog-summary > div:last-child { border:0; }
	.catalog-summary > div > span { font-size:11px; color:#99aabe; } .catalog-summary strong { display:flex; align-items:baseline; gap:8px; color:#e1eaf5; font-size:25px; font-weight:500; font-variant-numeric:tabular-nums; margin-top:8px; }
	.catalog-summary strong small { font-size:10px; color:#7e91ab; font-weight:400; margin-left:2px; } .catalog-summary .summary-percent { font-size:13px; margin-left:-6px; color:#7fa0b2; }
	.data-summary strong { color:#77c7d5; } .evidence-summary strong { color:#b8abda; }
	.catalog-toolbar { display:flex; align-items:center; gap:16px; padding:0 0 13px; }
	.table-heading { display:flex; align-items:center; gap:9px; white-space:nowrap; } h2 { font-size:13px; color:#d9e3f0; font-weight:550; } .table-heading > span { color:#8ca0b6; font-size:10px; padding:3px 6px; border:1px solid #303d4e; border-radius:3px; }
	.inspector-search { margin-left:auto; display:flex; align-items:center; gap:5px; background:#111822; border:1px solid #324153; border-radius:4px; min-width:170px; width:260px; padding:0 9px; color:#7f93ac; }
	.inspector .inspector-search input { width:100%; min-width:0; border:0; min-height:34px; padding:7px 4px; font-size:11px; background:transparent; color:#d6e1ee; } .inspector-search input::placeholder { color:#8090a6; }
	.sort-control { display:flex; gap:7px; align-items:center; color:#8c9db3; font-size:10px; white-space:nowrap; }
	.inspector .sort-control select { border:1px solid #324153; background:#1b2532; color:#bbcadc; min-height:34px; font-size:11px; padding:5px 8px; max-width:195px; }
	.table-context { display:flex; align-items:center; justify-content:space-between; gap:14px; color:#869ab2; font-size:10px; line-height:1.6; margin-bottom:10px; }
	.table-context > span { color:#75889f; }
	.series-table-scroll { position:relative; overflow:auto; border:1px solid #2b3747; border-radius:5px; }
	.series-table { border-collapse:collapse; width:100%; min-width:1050px; text-align:left; }
	.series-table thead th { background:#212b38; padding:12px 11px; border-bottom:1px solid #3a4759; color:#a6b6c9; font-size:10px; font-weight:500; white-space:nowrap; }
	.series-table thead th:first-child { padding-left:17px; }
	.series-table tbody td { padding:13px 11px; border-bottom:1px solid #283442; vertical-align:middle; }
	.series-table tbody th { min-width:245px; width:30%; padding:0; border-bottom:1px solid #283442; font-weight:400; }
	.series-table tbody tr { background:#181f2a; } .series-table tbody tr:nth-child(even) { background:#161d27; } .series-table tbody tr:hover { background:#1e2b39; }
	.series-table tbody tr:last-child :is(th,td) { border-bottom:0; }
	.series-title { display:flex; gap:10px; align-items:center; color:#dce6f4; padding:14px 14px; text-decoration:none; min-height:62px; } .series-title:hover strong { color:#90dde0; text-decoration:underline; }
	.series-title > span:nth-child(2) { min-width:0; } .series-title strong { display:block; font-weight:550; font-size:12px; line-height:1.35; } .series-title small { display:block; color:#8599b1; font-size:10px; line-height:1.45; margin-top:5px; } .work-count { color:#687f99; }
	.series-symbol { width:29px; height:31px; flex:none; display:grid; place-items:center; color:#738ca7; border:1px solid #334457; background:#1f2b39; border-radius:3px; }
	.series-chevron { margin-left:auto; color:#657c96; display:flex; }
	.series-table td > small { display:block; color:#8c9eb6; font-size:10px; margin-top:4px; white-space:nowrap; font-variant-numeric:tabular-nums; }
	.inspector-definitions { border:1px solid #2c394a; border-radius:4px; margin-top:20px; background:#161f2a; }
	.inspector-definitions summary { display:flex; align-items:center; gap:7px; padding:12px 14px; color:#aac0d6; font-size:11px; cursor:pointer; } .inspector-definitions summary > span { margin-left:auto; color:#748ca6; font-size:10px; }
	.definitions-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:20px; padding:4px 16px 18px; border-top:1px solid #2c394a; } .definitions-grid section { padding-top:13px; } .definitions-grid h2 { font-size:11px; } .definitions-grid p { color:#8ea3bc; font-size:11px; line-height:1.65; margin-top:7px; }
	.inspector-footer { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:15px 0 0; margin-top:0; border:0; color:#788da6; font-size:10px; }
	.status-legend { display:flex; flex-wrap:wrap; gap:15px; } .inspector-footer p { text-align:right; line-height:1.7; }
	.snapshot-error { display:flex; align-items:start; gap:12px; border:1px solid #67523a; background:#30291f; color:#ebc793; padding:15px; border-radius:4px; margin-bottom:22px; font-size:12px; } .snapshot-error p { font-size:11px; margin-top:6px; line-height:1.6; color:#c4b29c; } .snapshot-error button { margin-left:auto; background:#423522; color:#eed6b0; padding:7px 11px; border:1px solid #745f40; border-radius:4px; white-space:nowrap; }
	.initial-loading { display:flex; align-items:center; gap:9px; margin:30px 0 20px; color:#98abc2; font-size:12px; } .loading-dot { width:7px; height:7px; background:#77cbd3; border-radius:50%; }
	.table-skeleton { border:1px solid #2b3747; border-radius:5px; } .table-skeleton > div { height:60px; border-bottom:1px solid #27323f; padding:21px 18px; display:grid; grid-template-columns:3fr 1fr 1fr 1fr; gap:40px; } .table-skeleton > div:last-child { border:0; } .table-skeleton span { background:#222d3b; border-radius:3px; height:8px; }
	.inspector-empty { display:flex; flex-direction:column; align-items:center; padding:55px 20px; border:1px solid #2c394a; border-radius:5px; color:#7892ad; gap:14px; text-align:center; } .inspector-empty h2 { font-size:15px; } .inspector-empty p { max-width:470px; color:#96a9c0; line-height:1.7; font-size:12px; } .inspector-empty button,.inspector-empty a { margin-top:6px; background:#233244; border:1px solid #425b75; color:#a9d9e6; padding:8px 13px; border-radius:4px; font-size:11px; }
	.spinning { animation:spin 1.4s linear infinite; } @keyframes spin { to { transform:rotate(360deg); } }
	@media(prefers-reduced-motion:reduce) { .spinning { animation:none; } }
	@media(max-width:1280px) { .inspector { grid-template-columns:185px minmax(0,1fr); } .inspector-main { padding:23px 20px 18px; } .catalog-summary strong { flex-wrap:wrap; gap:5px; } .catalog-summary strong small { flex-basis:100%; margin:2px 0 0; } .table-context { align-items:start; flex-direction:column; gap:2px; } }
	@media(max-width:950px) { .inspector { grid-template-columns:170px minmax(0,1fr); } .inspector-sidebar { padding-inline:8px; } .inspector-brand { gap:8px; padding-inline:6px; } .inspector-mark { display:none; } .inspector-nav button { padding-inline:9px; gap:7px; } .inspector-header { flex-direction:column; gap:16px; } .snapshot-tools { flex-direction:row; align-items:center; width:100%; justify-content:space-between; } .catalog-toolbar { flex-wrap:wrap; gap:12px; } .table-heading { flex-basis:100%; } .inspector-search { margin-left:0; flex:1; } .definitions-grid { grid-template-columns:1fr 1fr; } .inspector-footer { align-items:start; flex-direction:column; gap:10px; } .inspector-footer p { text-align:left; } }
	@media(max-width:680px) { .inspector { display:block; } .inspector-sidebar { position:static; height:auto; padding:14px 12px 10px; border-right:0; border-bottom:1px solid #2d3948; } .inspector-brand { margin:0 0 15px; } .inspector-mark { display:grid; width:26px; height:29px; } .inspector-brand strong { font-size:14px; } .inspector-brand small { font-size:8px; margin-top:3px; } .nav-section-label,.sidebar-foot { display:none; } .inspector-nav { flex-direction:row; gap:5px; } .inspector-nav button { font-size:11px; justify-content:center; gap:6px; padding:10px 7px; } .inspector-nav button :global(svg) { display:none; } .nav-total { margin-left:0; font-size:9px; } .sidebar-links { flex-direction:row; position:absolute; top:15px; right:12px; border:0; margin:0; padding:0; } .sidebar-links a { padding:7px; font-size:10px; } .sidebar-links a:first-child { display:none; } .inspector-main { padding:20px 14px 18px; } h1 { font-size:21px; } .read-only { font-size:7px; } .title-line { align-items:start; } .inspector-header { margin-bottom:20px; } .snapshot-time { font-size:9px; } .refresh-button { min-height:36px; font-size:10px; } .catalog-summary { grid-template-columns:1fr 1fr; margin-bottom:21px; } .catalog-summary > div { padding:14px; border-bottom:1px solid #2d3745; } .catalog-summary > div:nth-child(2) { border-right:0; } .catalog-summary > div:nth-child(3) { border-bottom:0; } .catalog-summary > div > span { font-size:10px; } .catalog-summary strong { font-size:23px; } .catalog-toolbar { gap:10px; } .inspector-search { flex-basis:100%; } .sort-control { margin-left:auto; } .table-heading { flex-basis:auto; } .inspector .inspector-search input { min-height:39px; font-size:12px; } .inspector .sort-control select { min-height:38px; } .definitions-grid { grid-template-columns:1fr; gap:3px; } .inspector-definitions summary > span { display:none; } .snapshot-error { flex-wrap:wrap; } .snapshot-error button { margin-left:30px; } .status-legend { gap:13px; } }
</style>
