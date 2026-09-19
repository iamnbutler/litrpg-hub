import { afterEach, describe, expect, it, vi } from 'vitest';

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const mocks = ['./queue.js', '../db.js', '../migrate.js', './authors.js', './reader-evidence.js', './hardcover-reader.js', './reader-corrections.js'];
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  for (const path of mocks) vi.doUnmock(path);
  vi.resetModules();
});

describe.each(['author', 'reader'] as const)('%s command purchase accounting', command => {
  it.each(['result-returned', 'paid-storage-error'] as const)('prints usage despite an unwritable queue after %s', async phase => {
    vi.resetModules();
    process.argv = ['node', 'test-cli', 'run', '--limit', '2'];
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(value => output.push(String(value)));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'on').mockReturnValue(process);
    const { JevPaidStorageError } = await import('./paid-jev.js');
    const { ReaderPaidStorageError, ObservationReviewError, ReaderTransactionError } = await import('./reader-evidence.js');
    const processJob = vi.fn(async () => {
      if (phase === 'paid-storage-error') throw new JevPaidStorageError({ input_tokens: 0, output_tokens: 0 }, 'disk full', 1);
      return { input_tokens: 0, output_tokens: 0, unknownUsageResponses: 1 };
    });
    const claim = vi.fn(() => ({ entity_id: 'work-1', kind: 'reader-observation-work', payload_json: JSON.stringify({ entityType: 'work', entityId: 'work-1' }) }));
    vi.doMock('../db.js', () => ({ getDb: () => ({}), closeDb: () => {} }));
    vi.doMock('../migrate.js', () => ({ runMigrations: () => {} }));
    vi.doMock('./queue.js', () => ({ claim, hash: () => 'test',
      finish: () => { throw new Error('queue is unwritable'); },
      fail: () => { throw new Error('queue is still unwritable'); }, defer: () => {} }));
    vi.doMock('./authors.js', () => ({ authorFields: [], collectAuthorEvidence: () => new Map(),
      planAuthorJobs: () => 0, summarizeAuthor: () => ({}), processAuthorProfile: processJob }));
    vi.doMock('./reader-evidence.js', () => ({
      ReaderPaidStorageError, ObservationReviewError, ReaderTransactionError,
      readerJobKinds: () => ['reader-work-observation'], LEGACY_READER_JOB_KINDS: [],
      processReaderObservation: processJob, processReaderTraits: processJob
    }));
    vi.doMock('./hardcover-reader.js', () => ({ MAX_REVIEWS: 50, RetryableError: class extends Error {} }));
    vi.doMock('./reader-corrections.js', () => ({}));
    if (command === 'author') await import('./author-cli.js'); else await import('./reader-cli.js');
    const summary = output.map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.tokens);
    expect(summary?.tokens).toEqual({ input_tokens: 0, output_tokens: 0, unknownUsageResponses: 1 });
    expect(summary).toMatchObject({ completed: 0, errors: 1 });
    expect(processJob).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });
});
