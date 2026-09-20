const titleCollator = new Intl.Collator('en', { sensitivity: 'base' });

/** English catalog filing order; the original title remains the display name. */
export function titleSortKey(title: string): string {
	return title.trim().replace(/^(?:a|an|the)\s+(?=\S)/i, '');
}

export function compareTitles(left: string, right: string): number {
	return titleCollator.compare(titleSortKey(left), titleSortKey(right));
}
