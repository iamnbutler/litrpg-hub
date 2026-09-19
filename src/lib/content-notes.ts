/** Reader-facing cleanup for the two prose fields the catalog ships inside each book: the
 * per-signal `note` and the `issues` list. Both were written for whoever runs the pipeline,
 * so they carry our tool names and our outstanding work. Neither is something a reader can
 * act on, and `Jev` means nothing outside this repo.
 *
 * This is a view-layer filter, not a rewrite of the data: the stored strings are the audit
 * trail and stay exactly as they are. The parse-time builders in `scripts/backend` no longer
 * bake tool names into new assessments, so this only has work to do for records exported
 * before that change. It can be deleted once the snapshot has been fully rebuilt.
 */

/** Our own tooling, which a reader has no use for. Matched as whole words so a book whose
 * description genuinely discusses AI is never caught by it. */
const TOOLING = /\b(?:jev|openai)\b/i;
/** Our outstanding work, phrased as a task. "Genre needs review" is on 2,540 books: it is a
 * queue entry, not a fact about the book. */
const OUR_TODO = /\b(?:needs review|needs confirmation|awaiting review|to be reviewed)\b/i;

/** Strip a leading provenance sentence naming our tooling, keeping whatever substance follows
 * it. Where a signal came from is already shown as a label beside the verdict, so the sentence
 * is duplicated as well as jargon — but the cover observations that follow it are real
 * description a reader wants. Returns null when nothing worth printing survives. */
export function readerNote(note: unknown): string | null {
	if (typeof note !== 'string') return null;
	let text = note.trim();
	// A semicolon counts as a clause boundary: the shipped cover note joins its provenance to a
	// real caveat with one ("…supplied book metadata; cover art does not establish story
	// content."), and splitting on sentence punctuation alone would discard both halves.
	const lead = /^[^.!?;]*[.!?;](?:\s+|$)/.exec(text);
	if (lead && TOOLING.test(lead[0])) {
		text = text.slice(lead[0].length).trim();
		// The surviving clause now starts the sentence, so it has to read like one.
		text = text.charAt(0).toUpperCase() + text.slice(1);
	}
	// Fail closed: if a tool name survives anywhere else in the note, drop the note rather than
	// ship a half-cleaned sentence. Losing a caveat is better than printing an internal name.
	if (!text || TOOLING.test(text)) return null;
	return text;
}

/** Keep the gaps that describe the listing ("Narrator not supplied") and drop the ones that
 * describe our queue ("Genre needs review"). */
export function readerIssues(issues: unknown): string[] {
	if (!Array.isArray(issues)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of issues) {
		if (typeof entry !== 'string') continue;
		const text = entry.trim();
		if (!text || OUR_TODO.test(text) || TOOLING.test(text) || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
	}
	return out;
}
