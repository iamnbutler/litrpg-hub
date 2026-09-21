<script lang="ts">
	let { shown, total, label = 'results', onload }: {
		shown: number; total: number; label?: string; onload: () => void;
	} = $props();

	function observe(node: HTMLDivElement) {
		let active = true;
		const observer = new IntersectionObserver((entries) => {
			if (active && entries.some((entry) => entry.isIntersecting)) onload();
		}, { rootMargin: '300px 0px' });
		observer.observe(node);
		return () => { active = false; observer.disconnect(); };
	}
</script>

{#if shown < total}
	<!-- Reobserve after each batch so a tall viewport keeps filling until the next
	     batch is below the buffer, even if the sentinel never left the viewport. -->
	{#key shown}<div class="scroll-sentinel" aria-hidden="true" {@attach observe}></div>{/key}
{/if}
<p class="visually-hidden" role="status">Showing {Math.min(shown, total)} of {total} {label}</p>

<style>
	.scroll-sentinel { height:1px; }
</style>
