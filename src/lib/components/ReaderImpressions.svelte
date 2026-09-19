<script lang="ts">
	import type { ReaderContext } from '$lib/reader-context';
	import { readerImpressions } from '$lib/impressions';
	let { context, heading = 'Reader impressions' }: { context?: ReaderContext; heading?: string } = $props();
	const view = $derived(readerImpressions(context));
</script>

{#if view}
	<section class="impressions" aria-label={heading}>
		<div class="impressions-head">
			<h3>{heading}</h3>
			<!-- substantiveVoices, never `voices`: only reviews with something to say were read. -->
			<span class="sampled">{view.sampled.toLocaleString()} sampled public review{view.sampled === 1 ? '' : 's'}{#if view.span} · {view.span}{/if}</span>
		</div>
		<!-- The finding leads. It is original prose grounded in the sample, never a quote and
		     never a publisher fact. -->
		{#if view.observation}<p class="observation">{view.observation}</p>{/if}
		<!-- One judgement about the whole sample. Repeating it per trait would invent
		     per-trait reader agreement the source does not measure. -->
		{#if view.consensus === 'mixed'}<p class="consensus mixed">Readers in this sample disagreed with each other.</p>
		{:else if view.consensus === 'insufficient'}<p class="consensus">Too few voices here to say whether readers agree.</p>{/if}
		<ul class="traits">
			{#each view.traits as trait (trait.trait)}
				<li>
					<div class="trait-top">
						<strong>{trait.label}</strong>
						<span class="value">{trait.value}</span>
					</div>
					{#if trait.summary}<p>{trait.summary}</p>{/if}
				</li>
			{/each}
		</ul>
		<p class="caveat">
			A bounded sample of public reviews, not a rating and not a tally of everyone.
			Some reviews cover this book in other formats, so they are readers rather than confirmed listeners.
		</p>
		{#if view.sources.length}
			<p class="sources">Sampled from {#each view.sources as source, i}<a href={source.url} target="_blank" rel="noreferrer">{source.name}</a>{#if i < view.sources.length - 1} · {/if}{/each}</p>
		{/if}
	</section>
{/if}

<style>
.impressions { border-top:1px solid var(--line); padding:16px 0; }
.impressions-head { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:4px 12px; }
h3 { font:600 14px var(--sans); margin:0; }
.sampled { font-size:10px; color:var(--muted); }
.observation { font-size:13px; line-height:1.6; margin-top:12px; }
.traits { list-style:none; margin:14px 0 0; padding:0; display:grid; gap:12px; }
.traits:empty { display:none; }
.trait-top { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 9px; font-size:12px; }
.trait-top strong { font-weight:600; }
.value { color:var(--green); }
.consensus { font-size:11px; color:var(--muted); line-height:1.6; margin-top:10px; }
.consensus.mixed { color:var(--gold); }
.traits p { font-size:11px; line-height:1.6; color:var(--muted); margin-top:5px; }
.caveat { font-size:10px; line-height:1.6; color:var(--muted); margin-top:14px; }
.sources { font-size:10px; color:var(--muted); margin-top:6px; }
</style>
