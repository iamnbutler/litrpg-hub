<script lang="ts">
	let { name, size = 20 }: { name: string; size?: number } = $props();
	const paths: Record<string, string> = {
		book: 'M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14',
		search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
		arrow: 'M4 12h16m-6-6 6 6-6 6', back: 'M20 12H4m6 6-6-6 6-6', plus: 'M12 5v14M5 12h14', check: 'm5 12 4 4L19 6',
		bookmark: 'M6 3h12v18l-6-4-6 4V3Z', calendar: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM7 2v6m10-6v6M3 11h18',
		sparkles: 'm12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3ZM21 2v4m-2-2h4',
		filter: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6M9 15v6',
		close: 'm6 6 12 12M6 18 18 6', chevron: 'm9 5 7 7-7 7', down: 'm6 9 6 6 6-6',
		grid: 'M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z',
		headphones: 'M3 14v-3a9 9 0 0 1 18 0v3M3 12h4v9H5a2 2 0 0 1-2-2v-7Zm18 0h-4v9h2a2 2 0 0 0 2-2v-7Z',
		sun: 'M12 3V1m0 22v-2M3 12H1m22 0h-2M5 5 3 3m18 18-2-2M5 19l-2 2M21 3l-2 2M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
		leaf: 'M20 3C7 2 2 8 5 15c6 6 15 0 15-12ZM3 21 16 8',
		castle: 'M4 21V9H2V3h3v3h3V3h3v6H9v12m6 0V9h-2V3h3v3h3V3h3v6h-2v12M9 13h6M9 21h6v-5H9v5Z',
		dice: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 4h.01M17 7h.01M12 12h.01M7 17h.01M17 17h.01',
		compass: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Zm-7-3-2 4-4 2 2-4 4-2Z',
		external: 'M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5',
		download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', upload: 'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5',
		info: 'M12 11v6m0-10h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
		clock: 'M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'
	};
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.book} /></svg>
