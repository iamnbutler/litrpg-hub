<script lang="ts">
	import { displayDate, genreLabels, type CatalogBook } from '$lib/catalog';
	import type { SeriesProgress } from '$lib/library';
	import type { CatalogSeries } from '$lib/series';
	import Icon from './Icon.svelte';
	let { series, cover, progress, following, latest, upcoming, reason = '', layout = 'grid', onopen, onfollow }: {
		layout?: 'grid' | 'list'; series: CatalogSeries; cover?: CatalogBook; progress: SeriesProgress;
		following: boolean; latest: string | null; upcoming: number; reason?: string;
		onopen: (series: CatalogSeries) => void; onfollow: (series: CatalogSeries) => void;
	} = $props();
	let imageFailed = $state(false);
	const volumes = $derived(progress.total + upcoming);
	const label = $derived(
		progress.state === 'caught-up' ? 'Up to date'
		: progress.state === 'caught-up-partial' ? 'All known audio read'
		: progress.read > 0 ? `${progress.read} of ${progress.total} read`
		: `${volumes} audiobook${volumes === 1 ? '' : 's'}`);
</script>
<article class="series-row" class:grid={layout === 'grid'} role="listitem">
	<button class="series-cover" onclick={() => onopen(series)} aria-label={`Open ${series.title}`}>
		{#if cover?.coverUrl && !imageFailed}<img src={cover.coverUrl} alt="" loading="lazy" onerror={() => imageFailed = true}/>{:else}<Icon name="book" size={24}/>{/if}
	</button>
	<div class="series-info">
		<h3><button onclick={() => onopen(series)}>{series.title}</button></h3>
		<p class="author">{series.author}</p>
		{#if reason}<p class="match-reason">{reason}</p>{:else}<p class="genres">{series.genres.slice(0, 2).map((g) => genreLabels[g] ?? g).join(' · ')}</p>{/if}
	</div>
	<div class="series-state">
		<span class="state-label" class:current={progress.caughtUp} class:partial={progress.state === 'caught-up-partial'}>{#if progress.caughtUp}<Icon name="check" size={13}/>{/if}{label}</span>
		{#if progress.total && progress.state !== 'not-started'}<span class="track" aria-hidden="true"><span style:width={`${Math.round((progress.read / progress.total) * 100)}%`}></span></span>{/if}
		{#if upcoming}<span class="next-up">{upcoming} announced</span>{/if}
	</div>
	<div class="series-release">{latest ? displayDate(latest) : 'Date to be announced'}</div>
	<div class="series-actions">
		<button class="follow-button" class:following onclick={() => onfollow(series)} aria-pressed={following}>{following ? 'Following' : '+ Follow'}</button>
		<button class="open-series" onclick={() => onopen(series)}>{progress.remaining > 0 && progress.read > 0 ? `${progress.remaining} left` : 'View series'}</button>
	</div>
</article>
<style>
.series-row { display:grid; grid-template-columns:50px minmax(0,1fr) 130px 114px 170px; align-items:center; gap:18px; min-width:0; padding:10px; border-bottom:1px solid var(--line); }
.series-row:last-child { border-bottom:0; } .series-row:hover { background:#f1f3eb; }
.series-cover { width:50px; height:50px; padding:0; background:none; border:0; color:var(--muted); display:grid; place-items:center; }
.series-cover img { display:block; width:100%; height:100%; object-fit:contain; } .series-info { min-width:0; }
h3 { margin:0 0 4px; font-size:13px; line-height:1.35; font-weight:600; }
h3 button { padding:0; border:0; background:none; text-align:left; font:inherit; display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
h3 button:hover { color:var(--green); text-decoration:underline; }
.author { font-size:12px; margin:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .genres { color:var(--muted); font-size:11px; margin:4px 0 0; line-height:1.4; }
.match-reason { color:var(--green); font-size:11px; margin:4px 0 0; line-height:1.4; }
.state-label { display:flex; align-items:center; gap:5px; font-size:12px; font-weight:600; } .state-label.current { color:var(--green); }
.state-label.partial { color:var(--green); font-weight:500; }
.state-label.partial::before { content:''; width:7px; height:7px; border-radius:50%; border:1.5px solid var(--green); flex-shrink:0; }
.track { display:block; height:4px; border-radius:3px; background:var(--line); overflow:hidden; margin-top:6px; max-width:110px; } .track > span { display:block; height:100%; background:var(--green); }
.next-up { display:block; font-size:10px; color:var(--gold); margin-top:5px; }
.series-release { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
.series-actions { display:flex; align-items:start; flex-direction:column; gap:6px; }
.follow-button { border:1px solid #d4d8ce; border-radius:4px; background:white; color:var(--ink); padding:5px 9px; min-width:112px; font-size:11px; }
.follow-button:hover,.follow-button.following { background:var(--sage); color:var(--green); }
.open-series { border:0; background:none; color:var(--green); padding:0; font-size:11px; } .open-series:hover { text-decoration:underline; }
@media(max-width:1000px) { .series-row { grid-template-columns:50px minmax(0,1fr) 110px 95px 135px; gap:12px; } }
@media(max-width:800px) { .series-row { grid-template-columns:44px minmax(0,1fr) 115px; gap:5px 12px; padding:12px 0; } .series-cover { width:44px; height:44px; grid-row:1 / 3; align-self:start; } .series-info { grid-column:2; grid-row:1; } .series-actions { grid-column:3; grid-row:1 / 3; justify-self:end; } .series-state { grid-column:2; grid-row:2; margin-top:3px; } .series-release { grid-column:2; font-size:10px; } }
@media(max-width:420px) { .series-row { grid-template-columns:38px minmax(0,1fr) 103px; gap:5px 8px; } .series-cover { width:38px; height:38px; } .follow-button { min-width:0; padding:5px 7px; } h3 { font-size:12px; } .author { font-size:11px; } }

.series-row.grid { display:flex; flex-direction:column; align-items:stretch; gap:0; border:0; padding:0; height:100%; }
.series-row.grid:hover { background:none; }
.grid .series-cover { width:100%; height:auto; aspect-ratio:1; border-radius:3px; overflow:hidden; background:#eceee7; }
.grid .series-cover img { width:100%; height:100%; object-fit:contain; }
.grid .series-info { margin-top:11px; }
.grid h3 { font:600 16px/1.3 var(--serif); min-height:42px; margin-bottom:4px; }
.grid .author { font-size:12px; }
.grid .genres { font-size:10px; white-space:nowrap; text-overflow:ellipsis; overflow:hidden; min-height:14px; margin-top:5px; }
.grid .match-reason { font-size:10px; min-height:28px; margin-top:5px; display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.grid .series-state { margin-top:10px; min-height:26px; }
.grid .state-label { font-size:11px; }
.grid .track { max-width:none; }
.grid .series-release { display:none; }
.grid .series-actions { flex-direction:row; justify-content:space-between; align-items:center; gap:8px; margin-top:auto; padding-top:11px; }
.grid .follow-button { flex:1; padding:7px 6px; background:transparent; min-width:0; }
.grid .follow-button:hover,.grid .follow-button.following { background:var(--sage); }
.grid .open-series { white-space:nowrap; font-size:10px; }
@media(max-width:580px) { .grid h3 { font-size:15px; min-height:39px; } .grid .series-actions { align-items:stretch; flex-direction:column; gap:7px; } .grid .open-series { text-align:left; } }
</style>
