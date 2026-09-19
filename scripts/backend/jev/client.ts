/** TypeSafe's documented HTTP API. This module is only used by offline backend jobs. */
export type Question = { type: 'noul'; instructions: string } |
	{ type: 'choice'; instructions: string; criteria: Record<string, string> } |
	{ type: 'score'; instructions: string; criteria: string[] };
export type Answer = { type: 'noul'; noul: number } |
	{ type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> } |
	{ type: 'score'; score: number; confidence: number; probabilities?: Record<string, number> };
export interface JevResponse { model: string; answers: Record<string, Answer>; usage: { input_tokens: number; output_tokens: number } }
const bounded = (value: unknown, max = 1): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;

export function validateResponse(data: unknown, questions: Record<string, Question>): JevResponse {
	if (!data || typeof data !== 'object') throw new Error('Jev returned an invalid response.');
	const response = data as JevResponse;
	if (typeof response.model !== 'string' || !response.answers || !response.usage ||
		!bounded(response.usage.input_tokens, Number.MAX_SAFE_INTEGER) || !bounded(response.usage.output_tokens, Number.MAX_SAFE_INTEGER)) throw new Error('Jev returned incomplete response metadata.');
	for (const [id, question] of Object.entries(questions)) {
		const answer = response.answers[id];
		if (!answer || answer.type !== question.type) throw new Error(`Jev omitted or changed answer ${id}.`);
		if (answer.type === 'noul' && !bounded(answer.noul)) throw new Error(`Invalid probability for ${id}.`);
		if (answer.type !== 'noul' && !bounded(answer.confidence)) throw new Error(`Invalid confidence for ${id}.`);
		if (answer.type === 'choice' && question.type === 'choice') {
			if (!Object.hasOwn(question.criteria, answer.choice) || !answer.probabilities || Object.keys(answer.probabilities).length !== Object.keys(question.criteria).length ||
				!Object.keys(question.criteria).every(key => bounded(answer.probabilities[key])) ||
				Math.abs(Object.values(answer.probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.02) throw new Error(`Invalid choice for ${id}.`);
		}
		if (answer.type === 'score' && question.type === 'score' && !bounded(answer.score, question.criteria.length - 1)) throw new Error(`Invalid score for ${id}.`);
	}
	return response;
}

export async function evaluate(state: unknown, questions: Record<string, Question>, options: {
	apiKey?: string; model?: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>
} = {}): Promise<JevResponse> {
	const key = options.apiKey ?? process.env.TYPESAFE_API_KEY;
	if (!key) throw new Error('Set TYPESAFE_API_KEY in the ignored .env file to run Jev enrichment.');
	const request = options.fetch ?? fetch;
	const sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
	for (let attempt = 0; attempt < 3; attempt++) {
		let response: Response;
		try {
			response = await request('https://api.typesafe.ai/v1/systemone', {
				method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: options.model ?? process.env.JEV_MODEL ?? 'jev-latest', state, questions }),
				signal: AbortSignal.timeout(30_000)
			});
		} catch {
			if (attempt === 2) throw new Error('Jev could not be reached after three attempts.');
			await sleep(1000 * 2 ** attempt);
			continue;
		}
		if (response.ok) {
			let data: unknown;
			try { data = await response.json(); } catch { throw new Error('Jev returned invalid JSON. No assessment was stored.'); }
			return validateResponse(data, questions);
		}
		if ([429, 500, 502, 503, 504, 529].includes(response.status) && attempt < 2) {
			const header = response.headers.get('retry-after');
			const retrySeconds = header ? Number(header) : NaN;
			await sleep(Math.min(30_000, Number.isFinite(retrySeconds) ? Math.max(0, retrySeconds * 1000) : 1000 * 2 ** attempt));
			continue;
		}
		// Error bodies can contain echoed state/credentials; never log them.
		throw new Error(`Jev returned HTTP ${response.status}. ${response.status === 401 ? 'Check the API key.' : 'The last successful assessment has been preserved.'}`);
	}
	throw new Error('Jev retries exhausted.');
}
