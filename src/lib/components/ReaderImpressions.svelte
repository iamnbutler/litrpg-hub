<script lang="ts">
	import type { ReaderContext } from '$lib/reader-context';
	import { readerImpressions, reduceDisclosure, isOpen, CLOSED, type DisclosureAction } from '$lib/impressions';
	let { context, heading = 'Reader impressions' }: { context?: ReaderContext; heading?: string } = $props();
	const view = $derived(readerImpressions(context));
	const panelId = $props.id();

	// One state for hover, focus, pointer and keyboard, so `aria-expanded` can never disagree
	// with what is on screen and Escape can dismiss a panel opened by any of them.
	let disclosure = $state(CLOSED);
	const open = $derived(isOpen(disclosure));
	// Held only so Escape can move focus off a link inside a panel that is about to be hidden.
	let trigger: HTMLButtonElement | undefined = $state();
	const act = (action: DisclosureAction) => { disclosure = reduceDisclosure(disclosure, action); };

	// Hover is a mouse affordance. A touch tap also emits pointerenter, and letting it open the
	// panel here would leave the press with nothing left to do.
	const hover = (action: DisclosureAction) => (event: PointerEvent) => {
		if (event.pointerType === 'mouse') act(action);
	};
	// focusout fires while moving between the trigger and the links inside the panel, so only a
	// move that actually leaves the control counts as losing focus.
	const blur = (event: FocusEvent) => {
		const host = event.currentTarget;
		const next = event.relatedTarget;
		if (!(host instanceof HTMLElement) || !(next instanceof Node) || !host.contains(next)) act('focus-out');
	};
	const dismiss = (event: KeyboardEvent) => {
		if (event.key !== 'Escape' || !open) return;
		act('escape');
		// Focus must not be left inside a panel that is about to be display:none. Returning it
		// here is safe because the dismissed flag keeps the panel shut through the focus event.
		trigger?.focus();
		// This component often renders inside a <dialog>, which closes itself on Escape. Escape
		// belongs to the innermost open thing: dismiss the panel and leave the dialog standing.
		event.preventDefault();
		event.stopPropagation();
	};
</script>

<svelte:window onkeydown={dismiss} />

{#if view}
	<section class="impressions" aria-label={heading}>
		<div class="impressions-head">
			<h3>{heading}</h3>
			<div class="head-meta">
				<!-- substantiveVoices, never `voices`: only reviews with something to say were read.
				     This stays out of the panel so the sample size is visible without interaction. -->
				<span class="sampled">{view.sampled.toLocaleString()} sampled public review{view.sampled === 1 ? '' : 's'}{#if view.span} · {view.span}{/if}</span>
				<!-- role=group: the wrapper carries the pointer handlers that keep the panel open while the
				     cursor travels from the trigger down into it. -->
				<span
					class="info"
					role="group"
					onpointerenter={hover('hover-in')}
					onpointerleave={hover('hover-out')}
					onfocusin={() => act('focus-in')}
					onfocusout={blur}
				>
					<button
						type="button"
						class="info-trigger"
						bind:this={trigger}
						aria-expanded={open}
						aria-controls={panelId}
						onpointerdown={() => act('press')}
						onclick={() => act('click')}
					>
						<span aria-hidden="true">i</span><span class="sr-only">About this sample</span>
					</button>
					<!-- Collapsed with CSS rather than removed from the tree: the methodology is part
					     of the record even when closed, and server-rendered output must carry it.
					     `display:none` still keeps it out of the accessibility tree while closed. -->
					<div class="info-panel" class:open id={panelId}>
						<p class="info-title">About this sample</p>
						<p>
							A bounded sample of public reviews, not a rating and not a tally of everyone.
							Some reviews cover this book in other formats, so they are readers rather than confirmed listeners.
						</p>
						<p>Gathered in bounded batches rather than read exhaustively. Individual review text is not shown.</p>
						{#if view.sources.length}
							<!-- rel=external marks these as real outbound URLs, not app routes to resolve. -->
							<p class="sources">Sampled from {#each view.sources as source, i (source.url)}<a href={source.url} target="_blank" rel="external noreferrer">{source.name}</a>{#if i < view.sources.length - 1} · {/if}{/each}</p>
						{/if}
					</div>
				</span>
			</div>
		</div>
		<!-- The finding leads. It is original prose grounded in the sample, never a quote and
		     never a publisher fact. -->
		{#if view.observation}<p class="observation">{view.observation}</p>{/if}
		<!-- One judgement about the whole sample. Repeating it per trait would invent
		     per-trait reader agreement the source does not measure. -->
		{#if view.consensus === 'mixed'}<p class="consensus mixed">Readers in this sample disagreed with each other.</p>
		{:else if view.consensus === 'insufficient'}<p class="consensus">Too few voices here to say whether readers agree.</p>{/if}
		<!-- Each column renders only if the approved split actually carries it. A sample with no
		     recorded critiques shows one column rather than an empty or invented second. -->
		{#if view.impressions.length || view.critiques.length}
			<div class="split">
				{#if view.impressions.length}
					<div class="column">
						<h4>Impressions</h4>
						<ul>{#each view.impressions as line (line)}<li>{line}</li>{/each}</ul>
					</div>
				{/if}
				{#if view.critiques.length}
					<div class="column">
						<h4>Critiques</h4>
						<ul>{#each view.critiques as line (line)}<li>{line}</li>{/each}</ul>
					</div>
				{/if}
			</div>
		{/if}
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
	</section>
{/if}

<style>
.impressions { border-top:1px solid var(--line); padding:16px 0; }
.impressions-head { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:4px 12px; }
h3 { font:600 14px var(--sans); margin:0; }
.head-meta { display:flex; align-items:center; gap:6px; }
.sampled { font-size:10px; color:var(--muted); }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }

.info { position:relative; display:inline-flex; }
.info-trigger {
	position:relative;
	display:inline-flex; align-items:center; justify-content:center;
	width:15px; height:15px; padding:0; border-radius:50%;
	border:1px solid var(--line); background:none; color:var(--muted);
	font:italic 600 9px/1 var(--sans); cursor:pointer;
}
.info-trigger:hover, .info-trigger[aria-expanded='true'] { color:var(--ink); border-color:var(--muted); }
.info-trigger:focus-visible { outline:2px solid var(--green); outline-offset:2px; }
/* The glyph stays a 15px circle. On touch, where the finger is the pointer, an invisible
   44px target is laid over it; on a mouse this would swallow clicks on neighbouring text. */
@media (pointer: coarse) {
	.info-trigger::after {
		content:''; position:absolute; top:50%; left:50%;
		width:44px; height:44px; transform:translate(-50%, -50%);
	}
}
.info-panel {
	position:absolute; top:calc(100% + 6px); right:0; z-index:20;
	width:max-content; max-width:min(19rem, calc(100vw - 32px));
	padding:10px 12px; border:1px solid var(--line); border-radius:6px;
	background:var(--paper); box-shadow:0 6px 20px rgb(0 0 0 / 0.11);
	font-size:10px; line-height:1.6; color:var(--muted); text-align:left;
}
/* Visibility follows the single open state; hover reaches it through pointer events rather
   than :hover, so Escape can close what a cursor opened. The ::before bridges the gap under
   the trigger so the pointer can travel into the panel without leaving the control. */
.info-panel { display:none; }
.info-panel.open { display:block; }
.info-panel::before { content:''; position:absolute; left:0; right:0; top:-7px; height:7px; }
.info-panel p + p { margin-top:7px; }
.info-title { font-weight:600; color:var(--ink); }
.sources a { color:inherit; }

.observation { font-size:13px; line-height:1.6; margin-top:12px; }
.consensus { font-size:11px; color:var(--muted); line-height:1.6; margin-top:10px; }
.consensus.mixed { color:var(--gold); }

/* auto-fit gives two columns where there is room and one where there is not, so a single
   approved column fills the width instead of leaving a gap beside it. */
.split { display:grid; grid-template-columns:repeat(auto-fit, minmax(15rem, 1fr)); gap:14px 24px; margin-top:14px; }
.column h4 { font:600 11px var(--sans); margin:0 0 6px; letter-spacing:0.02em; }
.column ul { list-style:none; margin:0; padding:0; display:grid; gap:6px; }
/* These bullets are the finding, standing where the observation paragraph used to. They carry
   its weight rather than the smaller, greyer treatment used for methodology and traits. */
.column li { font-size:13px; line-height:1.6; color:var(--ink); padding-left:12px; position:relative; }
.column li::before { content:'·'; position:absolute; left:2px; color:var(--green); }

.traits { list-style:none; margin:14px 0 0; padding:0; display:grid; gap:12px; }
.traits:empty { display:none; }
.trait-top { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 9px; font-size:12px; }
.trait-top strong { font-weight:600; }
.value { color:var(--green); }
.traits p { font-size:11px; line-height:1.6; color:var(--muted); margin-top:5px; }
</style>
