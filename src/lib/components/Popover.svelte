<script lang="ts">
	import type { Snippet } from 'svelte';
	let { label, title = label, trigger, children, width = 280, active = false, className = '' }: {
		label: string; title?: string; trigger: Snippet; children: Snippet<[() => void]>;
		width?: number; active?: boolean; className?: string;
	} = $props();
	const id = $props.id();
	let expanded = $state(false);
	let left = $state(12), top = $state(0);
	let button: HTMLButtonElement;
	let panel: HTMLDivElement;

	function position() {
		if (!expanded) return;
		const rect = button.getBoundingClientRect();
		if (rect.bottom < 0 || rect.top > window.innerHeight) { close(); return; }
		const panelWidth = Math.min(width, window.innerWidth - 24);
		left = Math.max(12, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 12));
		top = rect.bottom + 8;
	}
	function beforeToggle(event: ToggleEvent) {
		expanded = event.newState === 'open';
		position();
	}
	function focusContent(event: ToggleEvent) {
		if (event.newState !== 'open') return;
		const target = panel.querySelector<HTMLElement>('[data-popover-focus]')
			?? panel.querySelector<HTMLElement>('button[aria-pressed="true"]')
			?? panel.querySelector<HTMLElement>('input, select, button:not(:disabled), a[href]');
		target?.focus({ preventScroll: true });
	}
	function close() { panel?.hidePopover(); }
</script>

<svelte:window onresize={position} onscroll={position} onpopstate={close}/>
<button {@attach (node) => { button = node; }} type="button" class={`icon-button popover-trigger ${className}`}
	class:active={active || expanded} aria-label={label} {title} aria-haspopup="dialog"
	aria-expanded={expanded} aria-controls={id} popovertarget={id}>
	{@render trigger()}
</button>
<div {@attach (node) => { panel = node; }} {id} popover="auto" role="dialog" aria-label={label}
	class="popover-panel" style:width={`${width}px`} style:left={`${left}px`} style:--popover-top={`${top}px`}
	onbeforetoggle={beforeToggle} ontoggle={focusContent}>
	{@render children(close)}
</div>

<style>
	.popover-trigger { display:inline-flex; align-items:center; justify-content:center; gap:5px; min-width:30px; min-height:30px; flex-shrink:0; border-radius:3px; color:var(--muted); }
	.popover-trigger:hover { background:var(--surface-hover); color:var(--ink); }
	.popover-trigger.active { background:var(--accent-soft); color:var(--accent); }
	.popover-panel { position:fixed; inset:auto; top:var(--popover-top); margin:0; max-width:calc(100vw - 24px); max-height:calc(100dvh - var(--popover-top) - 12px); overflow:auto; padding:16px; border:1px solid var(--line-strong); border-radius:4px; background:var(--surface-raised); color:var(--ink); box-shadow:var(--shadow); }
</style>
