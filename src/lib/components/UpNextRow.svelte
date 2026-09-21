<script lang="ts">
	import { displayDate, formatRuntime, type CatalogBook } from '$lib/catalog';
	import { workRelease, type CatalogSeries, type CatalogWork } from '$lib/series';
	import Icon from './Icon.svelte';
	let { series, work, book, remaining, now = new Date().toISOString(), onopen, onread, onopenbook }: {
		series: CatalogSeries; work: CatalogWork; book?: CatalogBook; remaining: number; now?: string;
		onopen: (series: CatalogSeries) => void; onread: (series: CatalogSeries, work: CatalogWork) => void;
		onopenbook: (book: CatalogBook) => void;
	} = $props();
	let imageFailed = $state(false);
	// The resolved release, so the queue cannot show a date coverage has already corrected.
	const release = $derived(workRelease(series, work, now));
</script>
<article class="queue-row" role="listitem">
	<button class="queue-cover" onclick={() => onopen(series)} aria-label={`Open ${series.title}`}>
		{#if book?.coverUrl && !imageFailed}<img src={book.coverUrl} alt="" loading="lazy" onerror={() => imageFailed = true}/>{:else}<Icon name="book" size={20}/>{/if}
	</button>
	<div class="queue-info">
		<h3><button onclick={() => (book ? onopenbook(book) : onopen(series))}>{work.number != null ? `Book ${work.number} · ` : ''}{book?.title ?? work.title}</button></h3>
		<p class="queue-series"><button onclick={() => onopen(series)}>{series.title}</button> · {series.author}</p>
		<p class="queue-facts">
			{displayDate(release.date)}
			{#if book?.runtimeMinutes} · {formatRuntime(book.runtimeMinutes)}{/if}
			{#if book?.narrator} · {book.narrator}{/if}
			{#if remaining > 1} · {remaining - 1} more after this{/if}
		</p>
	</div>
	<button class="queue-read" onclick={() => onread(series, work)}><span class="tick" aria-hidden="true"></span>Mark read</button>
	<button class="queue-open" onclick={() => onopen(series)} aria-label={`Open ${series.title}`}><Icon name="chevron" size={15}/></button>
</article>
<style>
.queue-row { display:grid; grid-template-columns:46px minmax(0,1fr) 118px 26px; align-items:center; gap:14px; padding:11px 8px; border-bottom:1px solid var(--line); }
.queue-row:last-child { border-bottom:0; } .queue-row:hover { background:var(--surface-hover); }
.queue-cover { width:46px; height:46px; padding:0; border:0; background:var(--surface); border-radius:3px; overflow:hidden; color:var(--muted); display:grid; place-items:center; align-self:start; }
.queue-cover img { width:100%; height:100%; object-fit:contain; }
.queue-info { min-width:0; }
h3 { margin:0; font-size:15px; font-weight:500; line-height:1.35; }
h3 button { padding:0; border:0; background:none; font:inherit; text-align:left; display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
h3 button:hover { color:var(--green); text-decoration:underline; }
.queue-series { font-size:11px; margin-top:4px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.queue-series button { padding:0; border:0; background:none; font:inherit; color:var(--green); } .queue-series button:hover { text-decoration:underline; }
.queue-facts { font-family:var(--mono); font-size:10px; color:var(--muted); margin-top:4px; line-height:1.5; }
.queue-read { display:inline-flex; align-items:center; justify-content:center; gap:6px; border:1px solid var(--line); border-radius:4px; background:var(--surface); padding:6px 9px; font-size:11px; width:100%; }
.queue-read:hover { background:var(--surface-hover); color:var(--green); }
.tick { display:inline-grid; place-items:center; width:13px; height:13px; border:1px solid var(--line-strong); border-radius:2px; background:var(--surface); flex-shrink:0; }
.queue-open { border:0; background:none; color:var(--muted); display:grid; place-items:center; padding:4px; } .queue-open:hover { color:var(--green); }
@media(max-width:800px) {
	.queue-row { grid-template-columns:40px minmax(0,1fr) 26px; gap:6px 10px; padding:12px 0; }
	.queue-cover { width:40px; height:40px; grid-row:1 / 3; }
	.queue-read { grid-column:2; width:auto; justify-self:start; margin-top:8px; }
	.queue-open { grid-column:3; grid-row:1; }
}
</style>
