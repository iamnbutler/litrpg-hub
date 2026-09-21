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
	const volumeLabel = $derived(`${volumes} audiobook${volumes === 1 ? '' : 's'}`);
	const statusLabel = $derived(progress.state === 'caught-up' ? 'Up to date'
		: progress.state === 'caught-up-partial' ? 'All known audio read' : '');
	const label = $derived(statusLabel || (progress.read > 0 ? `${progress.read} of ${progress.total} read` : volumeLabel));
	const followLabel = $derived(`${following ? 'Unfollow' : 'Follow'} ${series.title}`);
</script>

<article class="series-row" class:grid={layout === 'grid'} role="listitem">
	<button class="series-cover" onclick={() => onopen(series)} aria-label={`Open ${series.title}${statusLabel ? ` · ${statusLabel}` : ''}`}>
		{#if cover?.coverUrl && !imageFailed}<img src={cover.coverUrl} alt="" loading="lazy" onerror={() => imageFailed = true}/>{:else}<Icon name="book" size={24}/>{/if}
		{#if statusLabel}
			<span class="cover-status" class:partial={progress.state === 'caught-up-partial'} title={statusLabel} aria-hidden="true">
				<Icon name={progress.caughtUp ? 'check' : 'circle'} size={13}/>
			</span>
		{/if}
	</button>
	<div class="series-info">
		<h3><button onclick={() => onopen(series)}>{series.title}</button></h3>
		<p class="author" title={series.author}>{series.author}</p>
		{#if reason}<p class="match-reason">{reason}</p>{:else if layout === 'list'}<p class="genres">{#each series.genres.slice(0, 2) as genre, i (genre)}{#if i}<span class="genre-separator"> · </span>{/if}<span class="genre" data-genre={genre}>{genreLabels[genre] ?? genre}</span>{/each}</p>{/if}
	</div>
	<div class="series-state"><span class="state-label">{layout === 'grid' && statusLabel ? volumeLabel : label}</span></div>
	<div class="series-release">{latest ? displayDate(latest) : 'Date to be announced'}</div>
	<button class="follow-button" class:following onclick={() => onfollow(series)} aria-label={followLabel} title={followLabel} aria-pressed={following}>
		<Icon name={following ? 'check' : 'plus'} size={16}/>
	</button>
</article>

<style>
.series-row { display:grid; grid-template-columns:50px minmax(0,1fr) 130px 114px 36px; align-items:center; gap:18px; min-width:0; padding:10px; border-bottom:1px solid var(--line); }
.series-row:last-child { border-bottom:0; } .series-row:hover { background:var(--surface-hover); }
.series-cover { position:relative; width:50px; height:50px; padding:0; background:var(--surface); border:0; border-radius:3px; color:var(--muted); display:grid; place-items:center; }
.series-cover img { display:block; width:100%; height:100%; object-fit:contain; border-radius:inherit; }
.cover-status { position:absolute; top:-4px; right:-4px; width:20px; height:20px; display:grid; place-items:center; border:1px solid var(--line-strong); border-radius:50%; background:var(--surface); color:var(--green); box-shadow:0 1px 5px #2e2c2620; }
.cover-status.partial { color:var(--secondary); }
.series-info { min-width:0; }
h3 { margin:0 0 4px; font:500 15px/1.4 var(--serif); }
h3 button { padding:0; border:0; background:none; text-align:left; font:inherit; display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
h3 button:hover { color:var(--accent); text-decoration:underline; text-decoration-thickness:1px; text-underline-offset:3px; }
.author { font:13px var(--serif); color:var(--secondary); margin:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.genres { color:var(--muted); font:10px/1.5 var(--mono); margin:6px 0 0; }
.match-reason { color:var(--blue); font:10px/1.6 var(--mono); margin:6px 0 0; }
.state-label { font:11px var(--mono); color:var(--muted); }
.series-release { color:var(--muted); font:11px var(--mono); font-variant-numeric:tabular-nums; }
.follow-button { width:36px; height:36px; display:grid; place-items:center; padding:0; border:0; border-radius:50%; background:transparent; color:var(--muted); }
.follow-button:hover { background:var(--surface-hover); color:var(--accent); }
.follow-button.following { color:var(--green); }
@media(max-width:1000px) { .series-row { grid-template-columns:50px minmax(0,1fr) 110px 95px 36px; gap:12px; } }
@media(max-width:800px) {
	.series-row { grid-template-columns:44px minmax(0,1fr) 36px; gap:5px 12px; padding:12px 0; }
	.series-cover { width:44px; height:44px; grid-row:1 / 3; align-self:start; }
	.series-info { grid-column:2; grid-row:1; }
	.follow-button { grid-column:3; grid-row:1 / 3; justify-self:end; }
	.series-state { grid-column:2; grid-row:2; }
	.series-release { grid-column:2; font-size:10px; }
}

.series-row.grid { grid-template-columns:minmax(0,1fr) 28px; align-content:start; align-items:start; gap:0; border:0; padding:0; }
.series-row.grid:hover { background:none; }
.grid .series-cover { grid-column:1 / -1; grid-row:1; width:100%; height:auto; aspect-ratio:1; overflow:hidden; }
.grid .cover-status { top:6px; right:6px; width:22px; height:22px; }
.grid .series-info { display:contents; }
.grid h3 { grid-column:1 / -1; grid-row:2; font:500 14px/1.4 var(--serif); margin:10px 0 2px; letter-spacing:-.015em; }
.grid .author { grid-column:1; grid-row:3; font-size:12px; line-height:28px; padding-right:3px; }
.grid .match-reason { grid-column:1 / -1; grid-row:4; font-size:10px; margin:0; display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.grid .series-state { grid-column:1 / -1; grid-row:5; margin-top:2px; }
.grid .state-label { font-size:10px; }
.grid .series-release { display:none; }
.grid .follow-button { grid-column:2; grid-row:3; width:28px; height:28px; }
</style>
