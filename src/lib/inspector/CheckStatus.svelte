<script lang="ts">
	import type { HealthStatus } from '$lib/catalog-health';
	import { statusLabels } from './health-view';
	let { status, label, explanation = '' }: { status: HealthStatus; label?: string; explanation?: string } = $props();
</script>

<span class="check-status" class:present={status === 'present'} class:missing={status === 'missing'} class:unknown={status === 'unknown'} class:stale={status === 'stale'} title={explanation || undefined}>
	<span class="status-symbol" aria-hidden="true">{status === 'present' ? '✓' : status === 'missing' ? '−' : status === 'stale' ? '↻' : '?'}</span>
	<span>{label ?? statusLabels[status]}</span>
</span>

<style>
	.check-status { display:inline-flex; align-items:center; gap:6px; white-space:nowrap; font-size:11px; font-weight:550; line-height:1.5; }
	.status-symbol { display:inline-grid; place-items:center; width:15px; height:15px; flex:none; border:1px solid currentColor; border-radius:50%; font-size:10px; font-weight:700; line-height:1; }
	.present { color:#7bd8ba; } .missing { color:#edbb72; } .unknown { color:#a4b0c3; } .stale { color:#c8adf3; }
</style>
