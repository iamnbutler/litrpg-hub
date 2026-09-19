import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyBackupSnapshot } from './verify-backup.js';

const PRIVATE_TEXT = 'PRIVATE_SOURCE_BODY_AND_FAKE_CREDENTIAL_NOT_FOR_REPORTS';
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'catalog-verify-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

interface FixtureManifest { version: number; createdAt: string; books: number; files: { path: string; bytes: number; sha256: string }[] }
function fixture(orphan = false) {
  const snapshot = join(directory, 'snapshot');
  mkdirSync(join(snapshot, 'covers'), { recursive: true });
  const db = new Database(join(snapshot, 'books.db'));
  try {
    db.pragma('journal_mode = WAL');
    db.exec(readFileSync(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
    db.exec('CREATE TABLE catalog_documents (id TEXT PRIMARY KEY, body TEXT); CREATE TABLE migrations (id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO books(id,title,author,release_date,description) VALUES(?,?,?,?,?)').run('real-book', 'Fixture', 'Writer', '2025-01-01', PRIVATE_TEXT);
    db.prepare('INSERT INTO catalog_documents VALUES(?,?)').run('private-document', PRIVATE_TEXT);
    db.prepare('INSERT INTO migrations VALUES(?,?)').run(1, '001_initial.sql');
    db.prepare('INSERT INTO book_subgenres VALUES(?,?,?,?)').run('real-book', 'litrpg', 1, 'curated');
    if (orphan) {
      db.pragma('foreign_keys = OFF');
      db.prepare('INSERT INTO book_subgenres VALUES(?,?,?,?)').run('missing-private-book', 'litrpg', .7, PRIVATE_TEXT);
    }
  } finally { db.close(); }
  const coverBytes = Buffer.from([255, 216, 255, 217]);
  const cover = `covers/${createHash('sha256').update(coverBytes).digest('hex')}.jpg`;
  writeFileSync(join(snapshot, cover), coverBytes);
  const manifest: FixtureManifest = {
    version: 1, createdAt: '2026-09-19T03:40:00.381Z', books: 1,
    files: ['books.db', cover].map(path => {
      const bytes = readFileSync(join(snapshot, path));
      return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    })
  };
  const saveManifest = () => writeFileSync(join(snapshot, 'manifest.json'), JSON.stringify(manifest));
  saveManifest();
  return { snapshot, manifest, cover, saveManifest };
}

describe('offline catalog snapshot verification', () => {
  it('validates WAL-header snapshot bytes, covers, schema, and counts without writing sidecars or exposing bodies', () => {
    const { snapshot, manifest } = fixture();
    const before = readFileSync(join(snapshot, 'books.db'));
    expect([before[18], before[19]]).toEqual([2, 2]);
    const entries = readdirSync(snapshot);
    const report = verifyBackupSnapshot(snapshot);
    expect(report.ok).toBe(true);
    expect(report.files).toEqual({ checked: 2, verified: 2, verifiedBytes: manifest.files.reduce((n, f) => n + f.bytes, 0), missing: [] });
    expect(report.database?.quickCheck).toBe('ok');
    expect(report.database?.foreignKeyViolations).toBe(0);
    expect(report.database?.counts).toMatchObject({ books: 1, book_subgenres: 1, catalog_documents: 1, migrations: 1 });
    expect(report.database?.schema?.knownTables).toContain('books');
    expect(JSON.stringify(report)).not.toContain(PRIVATE_TEXT);
    expect(JSON.stringify(report)).not.toContain('private-document');
    expect(readFileSync(join(snapshot, 'books.db')).equals(before)).toBe(true);
    expect(readdirSync(snapshot)).toEqual(entries);
  });

  it('detects changed cover content even when its byte length is unchanged', () => {
    const { snapshot, cover } = fixture();
    writeFileSync(join(snapshot, cover), Buffer.from([255, 216, 255, 218]));
    const report = verifyBackupSnapshot(snapshot);
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'checksum-mismatch', path: cover }));
    expect(report.issues.some(issue => issue.code === 'size-mismatch')).toBe(false);
  });

  it('checks declared byte counts independently of hashes', () => {
    const { snapshot, manifest, saveManifest } = fixture();
    manifest.files[0].bytes++;
    saveManifest();
    const report = verifyBackupSnapshot(snapshot);
    expect(report.ok).toBe(false);
    expect(report.database).toBeNull();
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'size-mismatch', path: 'books.db' }));
  });

  it('reports a missing declared file while still inspecting a verified database', () => {
    const { snapshot, cover } = fixture();
    unlinkSync(join(snapshot, cover));
    const report = verifyBackupSnapshot(snapshot);
    expect(report.ok).toBe(false);
    expect(report.files.missing).toEqual([cover]);
    expect(report.database?.quickCheck).toBe('ok');
  });

  it.each(['../outside.db', '/tmp/outside.db', 'covers/../books.db', 'covers\\..\\books.db', 'C:\\outside.db', 'file:outside.db'])('rejects unsafe manifest path %s', path => {
    const { snapshot, manifest, saveManifest } = fixture();
    manifest.files[1].path = path;
    saveManifest();
    const report = verifyBackupSnapshot(snapshot);
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'unsafe-path', entry: 1 }));
    expect(JSON.stringify(report)).not.toContain(path);
  });

  it.each(['database', 'cover-directory', 'manifest', 'snapshot'])('rejects a symlink at the %s boundary', boundary => {
    const { snapshot } = fixture();
    const selected = boundary === 'database' ? join(snapshot, 'books.db') : boundary === 'cover-directory' ? join(snapshot, 'covers') : boundary === 'manifest' ? join(snapshot, 'manifest.json') : snapshot;
    const outside = join(directory, 'outside');
    renameSync(selected, outside);
    symlinkSync(outside, selected);
    const report = verifyBackupSnapshot(snapshot);
    expect(report.ok).toBe(false);
    expect(report.issues.some(issue => issue.code === 'unsafe-file' || issue.code === 'snapshot-unsafe')).toBe(true);
  });

  it('rejects a directory masquerading as a declared regular file', () => {
    const { snapshot, cover } = fixture();
    unlinkSync(join(snapshot, cover));
    mkdirSync(join(snapshot, cover));
    const report = verifyBackupSnapshot(snapshot);
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'unsafe-file', path: cover }));
  });

  it('fails orphaned foreign keys even with valid checksums and quick_check', () => {
    const { snapshot } = fixture(true);
    const report = verifyBackupSnapshot(snapshot);
    expect(report.ok).toBe(false);
    expect(report.files.verified).toBe(2);
    expect(report.database?.quickCheck).toBe('ok');
    expect(report.database?.foreignKeyViolations).toBe(1);
    expect(report.database?.foreignKeyViolationsByTable).toEqual({ book_subgenres: 1 });
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'foreign-key-violations' }));
    expect(JSON.stringify(report)).not.toContain('missing-private-book');
    expect(JSON.stringify(report)).not.toContain(PRIVATE_TEXT);
  });

  it('rejects unverified journal data and tolerates empty reader sidecars without modifying them', () => {
    const { snapshot } = fixture();
    writeFileSync(join(snapshot, 'books.db-wal'), '');
    writeFileSync(join(snapshot, 'books.db-shm'), Buffer.alloc(32768));
    expect(verifyBackupSnapshot(snapshot).ok).toBe(true);
    writeFileSync(join(snapshot, 'books.db-wal'), PRIVATE_TEXT);
    const report = verifyBackupSnapshot(snapshot);
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'unexpected-sidecar', path: 'books.db-wal' }));
    expect(JSON.stringify(report)).not.toContain(PRIVATE_TEXT);
    expect(readFileSync(join(snapshot, 'books.db-wal'), 'utf8')).toBe(PRIVATE_TEXT);
  });

  it('rejects duplicate entries and a mismatched book count', () => {
    const { snapshot, manifest, saveManifest } = fixture();
    manifest.files.push({ ...manifest.files[0] });
    manifest.books = 2;
    saveManifest();
    const report = verifyBackupSnapshot(snapshot);
    expect(report.ok).toBe(false);
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['duplicate-file', 'book-count-mismatch']));
  });

  it('does not expose malformed manifest text or corrupt database contents', () => {
    const { snapshot, manifest, saveManifest } = fixture();
    writeFileSync(join(snapshot, 'manifest.json'), PRIVATE_TEXT);
    const malformed = verifyBackupSnapshot(snapshot);
    expect(malformed.ok).toBe(false);
    expect(malformed.issues[0].code).toBe('manifest-invalid');
    expect(JSON.stringify(malformed)).not.toContain(PRIVATE_TEXT);
    writeFileSync(join(snapshot, 'books.db'), PRIVATE_TEXT);
    manifest.files[0].bytes = Buffer.byteLength(PRIVATE_TEXT);
    manifest.files[0].sha256 = createHash('sha256').update(PRIVATE_TEXT).digest('hex');
    saveManifest();
    const corrupt = verifyBackupSnapshot(snapshot);
    expect(corrupt.ok).toBe(false);
    expect(corrupt.issues).toContainEqual(expect.objectContaining({ code: 'database-unreadable' }));
    expect(JSON.stringify(corrupt)).not.toContain(PRIVATE_TEXT);
  });

  it('provides a JSON CLI report and fails the process for an invalid snapshot', () => {
    const { snapshot, cover } = fixture();
    const script = fileURLToPath(new URL('./verify-backup.ts', import.meta.url));
    const cli = () => spawnSync(process.execPath, ['--import', 'tsx', script, '--snapshot', snapshot], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' });
    const valid = cli();
    expect(valid.status).toBe(0);
    expect(valid.stderr).toBe('');
    expect(JSON.parse(valid.stdout).ok).toBe(true);
    expect(valid.stdout).not.toContain(PRIVATE_TEXT);
    unlinkSync(join(snapshot, cover));
    const invalid = cli();
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout).files.missing).toEqual([cover]);
  });
});
