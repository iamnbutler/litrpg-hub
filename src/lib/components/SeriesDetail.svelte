<script lang="ts">
	import { displayDate, formatRuntime, genreLabels, type CatalogBook } from '$lib/catalog';
	import { shelfLabels, workEntry, type SeriesLibrary, type SeriesProgress } from '$lib/library';
	import { mainlineWorks, sideWorks, workRelease, type CatalogSeries, type CatalogWork } from '$lib/series';
	import Icon from './Icon.svelte';
	import ReaderImpressions from './ReaderImpressions.svelte';
	let { series, books, library, progress, today, now = today, following, starter, onback, onfollow, onmarkall, onwork, onthrough, onopenbook, onlike }: {
		series: CatalogSeries; books: Map<string, CatalogBook>; library: SeriesLibrary; progress: SeriesProgress; starter?: CatalogBook;
		today: string; now?: string; following: boolean; onback: () => void; onfollow: (series: CatalogSeries) => void;
		onmarkall: (series: CatalogSeries) => void; onwork: (series: CatalogSeries, work: CatalogWork, read: boolean) => void;
		onthrough: (series: CatalogSeries, work: CatalogWork) => void;
		onopenbook: (book: CatalogBook) => void; onlike: (book: CatalogBook) => void;
	} = $props();
	let coverFailed = $state(false);
	// The same book the grid card showed, so cover and description stay consistent.
	const cover = $derived(starter ?? books.get(series.coverBookId));
	const mainline = $derived(mainlineWorks(series));
	const extras = $derived(sideWorks(series));
	const blurb = $derived(series.description || cover?.description || '');
	const narrators = $derived([...new Set(series.works.flatMap((w) => books.get(w.bookId)?.narrator?.split(',').map((n) => n.trim()) ?? []))].filter(Boolean));
	const percent = $derived(progress.total ? Math.round((progress.read / progress.total) * 100) : 0);
	const released = $derived(mainline.filter((w) => workRelease(series, w, now).state === 'released'));
	// Only worth offering while something released is still unread.
	const catchUp = $derived(released.some((w) => workEntry(library, w)?.status !== 'read') ? released : []);
</script>

<nav class="series-back"><button class="subtle-button" onclick={onback}><Icon name="back" size={15}/>All series</button></nav>
<section class="series-head">
	<div class="series-art">{#if cover?.coverUrl && !coverFailed}<img src={cover.coverUrl} alt={`Cover of ${series.title}`} onerror={() => coverFailed = true}/>{:else}<Icon name="book" size={56}/>{/if}</div>
	<div class="series-meta">
		{#if series.genres.length}<div class="eyebrow">{series.genres.slice(0, 3).map((g) => genreLabels[g] ?? g).join(' · ')}</div>{/if}
		<h1>{series.title}</h1>
		<p class="by">by {series.author}</p>
		<p class="counts">
			<span>{progress.total} released audiobook{progress.total === 1 ? '' : 's'}</span>
			{#if progress.upcoming}<span class="announced">{progress.upcoming} announced</span>{/if}
			{#if extras.length}<span>{extras.length} side {extras.length === 1 ? 'entry' : 'entries'}</span>{/if}
			<!-- Story status, never audio coverage: a finished story can still be mid-production. -->
			{#if series.status !== 'unknown'}<span>{series.status === 'complete' ? 'Story complete' : 'Story ongoing'}</span>{/if}
			{#if series.audioCoverage?.verifiedAt}<span class="checked">Audio list checked {displayDate(series.audioCoverage.verifiedAt.slice(0, 10))}</span>{/if}
		</p>
		{#if blurb}<p class="blurb">{blurb}</p>{/if}
		{#if narrators.length}<p class="narrators">Narrated by {narrators.slice(0, 3).join(', ')}</p>{/if}
		<div class="series-buttons">
			<button class="primary-button" onclick={() => onfollow(series)} aria-pressed={following}>{#if following}<Icon name="check" size={16}/>Following{:else}<Icon name="plus" size={16}/>Follow series{/if}</button>
			<button class="secondary-button" onclick={() => onmarkall(series)} disabled={progress.total === 0 || progress.remaining === 0}>Mark all as read</button>
			{#if cover}<button class="subtle-button" onclick={() => onlike(cover)}><Icon name="sparkles" size={16}/>Similar series</button>{/if}
		</div>
	</div>
</section>

<section class="progress-panel" aria-label="Your progress">
	<div class="progress-top">
		<strong class:current={progress.caughtUp}>{#if progress.caughtUp}<Icon name="check" size={15}/>Up to date{:else if progress.state === 'caught-up-partial'}All known audio read{:else if progress.read}{progress.read} of {progress.total} released audiobooks read{:else}Not started{/if}</strong>
		{#if progress.nextUnread}<span class="up-next">Up next: {progress.nextUnread.number != null ? `Book ${progress.nextUnread.number} · ` : ''}{progress.nextUnread.title}</span>{/if}
	</div>
	{#if progress.total}<span class="track" aria-hidden="true"><span style:width={`${percent}%`}></span></span>{/if}
	{#if catchUp.length}
		<div class="catch-up">
			<label for={`through-${series.id}`}>Already listened through</label>
			<select id={`through-${series.id}`} value="" onchange={(e) => { const chosen = catchUp.find((w) => w.id === e.currentTarget.value); e.currentTarget.value = ''; if (chosen) onthrough(series, chosen); }}>
				<option value="">Choose a book…</option>
				{#each catchUp as work (work.id)}<option value={work.id}>{work.number != null ? `Book ${work.number} · ` : ''}{work.title}</option>{/each}
			</select>
		</div>
	{/if}
	<ul class="progress-notes">
		{#each progress.unresolved as note (note)}<li>{note}.</li>{/each}
		{#if progress.state === 'caught-up-partial'}<li>You’ve finished everything we hold, so we won’t call you behind — but we can’t confirm you’re current either.</li>{/if}
		{#if progress.upcoming}<li>Announced volumes are not counted until the audiobook is out.</li>{/if}
	</ul>
</section>

{#snippet workRow(work: CatalogWork)}
	{@const book = books.get(work.bookId)}
	{@const entry = workEntry(library, work)}
	{@const read = entry?.status === 'read'}
	{@const release = workRelease(series, work, now)}
	{@const released = release.state === 'released'}
	<li class="work-row" class:is-read={read} class:pending={!released}>
		<span class="work-number">{work.number ?? '—'}</span>
		<div class="work-info">
			<h3>{book ? book.title : work.title}</h3>
			<p>
				{#if release.state === 'unknown'}Audio release not confirmed{:else if release.state === 'scheduled'}Audio {displayDate(release.date)}{:else}{displayDate(release.date)}{/if}
				{#if book?.runtimeMinutes} · {formatRuntime(book.runtimeMinutes)}{/if}
				{#if book?.narrator} · {book.narrator}{/if}
				{#if work.editionIds.length > 1} · {work.editionIds.length} editions{/if}
				{#if entry && !read} · {shelfLabels[entry.status]}{/if}
			</p>
		</div>
		<button class="read-toggle" class:done={read} aria-pressed={read} disabled={!released && !read}
			onclick={() => onwork(series, work, !read)}
			title={released ? '' : release.state === 'scheduled' ? 'This audiobook has not been released yet' : 'We have no confirmed release for this audiobook'}>
			<span class="tick" aria-hidden="true">{#if read}<Icon name="check" size={13}/>{/if}</span>{read ? 'Read' : 'Mark read'}
		</button>
		{#if book}<button class="work-open" onclick={() => onopenbook(book)} aria-label={`Details for ${book.title}`}><Icon name="chevron" size={15}/></button>{:else}<span></span>{/if}
	</li>
{/snippet}

{#if cover?.readerContext}
	<section class="starter-impressions" aria-label="Reader impressions">
		<ReaderImpressions context={cover.readerContext} heading={`Reader impressions of ${cover.title}`}/>
	</section>
{/if}

<section class="work-section" aria-label="Audiobooks in this series">
	<div class="section-head"><h2>Audiobooks</h2><span class="small-note">In reading order</span></div>
	<ul class="work-list">{#each mainline as work (work.id)}{@render workRow(work)}{/each}</ul>
</section>
{#if extras.length}
	<section class="work-section" aria-label="Side entries">
		<div class="section-head"><h2>Side entries</h2><span class="small-note">Anthologies and shorts</span></div>
		<ul class="work-list">{#each extras as work (work.id)}{@render workRow(work)}{/each}</ul>
	</section>
{/if}

<style>
.series-back { padding:2px 0 12px; }
.series-head { display:grid; grid-template-columns:168px minmax(0,1fr); gap:26px; padding-bottom:22px; border-bottom:1px solid var(--line); }
.series-art { aspect-ratio:1; display:grid; place-items:center; background:var(--surface); border-radius:4px; overflow:hidden; color:var(--green); align-self:start; }
.series-art img { width:100%; height:100%; object-fit:contain; }
.eyebrow { font-family:var(--mono); font-size:10px; letter-spacing:.05em; text-transform:uppercase; color:var(--green); line-height:1.6; }
h1 { font:500 30px/1.25 var(--serif); margin:7px 0 6px; }
.by { font-size:16px; color:var(--secondary); }
.counts { display:flex; flex-wrap:wrap; gap:6px 14px; font-size:12px; color:var(--muted); margin-top:11px; }
.counts .announced { color:var(--gold); }
.counts .checked { color:var(--green); }
.blurb { font-size:15px; line-height:1.75; margin-top:14px; max-width:68ch; display:-webkit-box; -webkit-line-clamp:4; line-clamp:4; -webkit-box-orient:vertical; overflow:hidden; }
.narrators { font-size:12px; color:var(--muted); margin-top:10px; }
.series-buttons { display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin-top:18px; }

.progress-panel { background:var(--surface); border:1px solid var(--line); border-top:0; padding:14px 16px; }
.progress-top { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 16px; }
.progress-top strong { display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600; } .progress-top strong.current { color:var(--green); }
.up-next { font-size:12px; color:var(--muted); }
.track { display:block; height:5px; border-radius:3px; background:var(--line); overflow:hidden; margin-top:11px; } .track > span { display:block; height:100%; background:var(--green); }
.progress-notes { margin:10px 0 0; padding-left:17px; color:var(--muted); font-size:11px; line-height:1.7; } .progress-notes:empty { display:none; }
.catch-up { display:flex; flex-wrap:wrap; align-items:center; gap:8px 10px; margin-top:12px; font-size:11px; color:var(--muted); }
.catch-up select { min-height:28px; padding:4px 7px; font-size:11px; max-width:260px; }

.starter-impressions { margin-top:18px; }
.work-section { margin-top:26px; }
.section-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 14px; padding-bottom:8px; border-bottom:1px solid var(--line); }
h2 { font:500 20px var(--serif); }
.work-list { list-style:none; margin:0; padding:0; }
.work-row { display:grid; grid-template-columns:34px minmax(0,1fr) 118px 26px; align-items:center; gap:14px; padding:12px 8px; border-bottom:1px solid var(--line); }
.work-row:hover { background:var(--surface-hover); }
.work-row.pending { color:var(--muted); }
.work-number { font:500 16px var(--serif); color:var(--muted); text-align:center; }
.work-row.is-read .work-number { color:var(--green); }
.work-info { min-width:0; }
.work-info h3 { font-size:15px; font-weight:500; line-height:1.35; margin:0; }
.work-info p { font-family:var(--mono); font-size:10px; color:var(--muted); margin-top:5px; line-height:1.5; }
.read-toggle { display:inline-flex; align-items:center; gap:6px; justify-content:center; border:1px solid var(--line); border-radius:4px; background:var(--surface); padding:6px 9px; font-size:11px; width:100%; }
.read-toggle:hover:not(:disabled) { background:var(--surface-hover); color:var(--green); }
.read-toggle.done { background:var(--surface-hover); border-color:var(--line-strong); color:var(--green); font-weight:600; }
.tick { display:inline-grid; place-items:center; width:13px; height:13px; border:1px solid var(--line-strong); border-radius:2px; background:var(--surface); flex-shrink:0; }
.read-toggle.done .tick { background:var(--green); border-color:var(--green); color:var(--canvas); }
.work-open { border:0; background:none; color:var(--muted); display:grid; place-items:center; padding:4px; } .work-open:hover { color:var(--green); }
@media(max-width:800px) {
	.series-head { grid-template-columns:104px minmax(0,1fr); gap:16px; }
	h1 { font-size:21px; }
	.work-row { grid-template-columns:26px minmax(0,1fr) 26px; gap:6px 10px; padding:12px 0; }
	.read-toggle { grid-column:2; width:auto; justify-self:start; margin-top:8px; }
	.work-open { grid-column:3; grid-row:1; }
}
@media(max-width:480px) { .series-head { grid-template-columns:1fr; } .series-art { max-width:150px; } .series-buttons { gap:9px; } }
</style>
