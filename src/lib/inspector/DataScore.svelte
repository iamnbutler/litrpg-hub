<script lang="ts">
	import type { HealthScore } from '$lib/catalog-health';
	import { percent } from './health-view';
	let { score, label, kind = 'completeness' }: { score: HealthScore; label: string; kind?: 'completeness' | 'evidence' } = $props();
	const value = $derived(percent(score));
</script>

<span class="data-score" class:evidence={kind === 'evidence'} title={`${label}: ${value}%. ${score.explanation}`}>
	<span class="score-number"><span class="visually-hidden">{label}: </span>{value}<span class="percent">%</span></span>
	<span class="score-track" aria-hidden="true"><span style:width={`${value}%`}></span></span>
</span>

<style>
	.data-score { display:inline-flex; flex-direction:column; gap:6px; min-width:58px; color:#dfe7f1; font-variant-numeric:tabular-nums; }
	.score-number { line-height:1; font-weight:600; font-size:12px; }
	.percent { margin-left:1px; font-size:10px; color:#8d9aaf; font-weight:400; }
	.score-track { height:3px; background:#303945; width:62px; overflow:hidden; border-radius:1px; }
	.score-track > span { display:block; height:100%; background:#62bdca; }
	.evidence .score-track > span { background:#a49bcf; }
</style>
