import { describe, expect, it, vi } from 'vitest';
import { evaluate, validateResponse, type Question } from './client.js';
const questions: Record<string, Question> = { harem: { type: 'choice', instructions: 'Is harem content disclosed?', criteria: { present: 'Disclosed', unknown: 'Not established' } } };
const payload = { model: 'jev-test', answers: { harem: { type: 'choice', choice: 'unknown', confidence: 0.9, probabilities: { present: 0.05, unknown: 0.95 } } }, usage: { input_tokens: 50, output_tokens: 5 } };

describe('Jev HTTP contract', () => {
	it('validates the shape and bounded values of every answer', () => {
		expect(validateResponse(payload, questions)).toEqual(payload);
		expect(() => validateResponse({ ...payload, answers: {} }, questions)).toThrow(/omitted/);
		expect(() => validateResponse({ ...payload, answers: { harem: { ...payload.answers.harem, confidence: 2 } } }, questions)).toThrow(/confidence/);
		expect(() => validateResponse({ ...payload, answers: { harem: { ...payload.answers.harem, choice: 'invented' } } }, questions)).toThrow(/choice/);
	});
	it('backs off on documented overload responses before retrying', async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 529 })).mockResolvedValueOnce(new Response(JSON.stringify(payload)));
		const sleep = vi.fn(async () => {});
		await expect(evaluate({ description: 'test' }, questions, { apiKey: 'test-only', fetch: request, sleep })).resolves.toEqual(payload);
		expect(sleep).toHaveBeenCalledWith(1000);
		expect(request).toHaveBeenCalledTimes(2);
	});
	it('stops on authentication errors and does not leak the response body', async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive echoed value', { status: 401 }));
		await expect(evaluate({}, questions, { apiKey: 'test-only', fetch: request })).rejects.toThrow('Jev returned HTTP 401. Check the API key.');
		expect(request).toHaveBeenCalledOnce();
	});
	it('refuses a malformed success response instead of caching it', async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...payload, answers: {} })));
		await expect(evaluate({}, questions, { apiKey: 'test-only', fetch: request })).rejects.toThrow(/omitted/);
	});
});
