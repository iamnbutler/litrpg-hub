import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// Only these public schema names may appear in a report. Never print source rows,
// arbitrary identifiers from an untrusted database, or SQLite error messages.
const CATALOG_TABLES = [
  'books', 'series', 'book_subgenres', 'book_sources', 'fetch_runs', 'search_cursors',
  'book_assessments', 'cover_observations', 'cover_sources', 'book_content_assessments',
  'source_snapshots', 'catalog_series', 'catalog_works', 'catalog_editions',
  'catalog_documents', 'catalog_urls', 'catalog_candidates', 'catalog_claims',
  'catalog_inferences', 'catalog_jobs', 'catalog_reader_evidence', 'catalog_reader_traits',
  'catalog_authors', 'catalog_author_profiles', 'cover_content_inference_heads',
  'cover_content_inference_responses', 'cover_vision_attempts', 'cover_vision_heads',
  'cover_image_sources', 'catalog_orphaned_tags', 'migrations'
] as const;
type CatalogTable = typeof CATALOG_TABLES[number];

interface ManifestFile { path: string; bytes: number; sha256: string }
interface Manifest { version: 1; createdAt: string; books: number; files: unknown[] }
export interface BackupVerificationIssue {
  code: string;
  message: string;
  /** Only fixed manifest names or validated content-addressed cover paths. */
  path?: string;
  /** Zero-based manifest entry index; unsafe path text is never echoed. */
  entry?: number;
}
export interface BackupDatabaseVerification {
  quickCheck: 'not-run' | 'ok' | 'failed';
  foreignKeyViolations: number | null;
  foreignKeyViolationsByTable: Partial<Record<CatalogTable | 'other_tables', number>>;
  schema: {
    schemaVersion: number;
    userVersion: number;
    tableCount: number;
    knownTables: CatalogTable[];
    otherTableCount: number;
  } | null;
  counts: Partial<Record<CatalogTable, number>>;
}
export interface BackupVerificationReport {
  ok: boolean;
  manifest: { version: 1; createdAt: string; books: number; declaredFiles: number } | null;
  files: { checked: number; verified: number; verifiedBytes: number; missing: string[] };
  database: BackupDatabaseVerification | null;
  issues: BackupVerificationIssue[];
}

type FileRead = { data: Buffer } | { code: 'missing-file' | 'unsafe-file' | 'unreadable-file' };
function readRegularFile(root: string, relative: string): FileRead {
  try {
    const parts = relative.split('/');
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
        return { code: 'unsafe-file' };
      }
    }
    // O_NOFOLLOW also rejects a leaf replaced by a symlink between lstat/open.
    const descriptor = openSync(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!fstatSync(descriptor).isFile()) return { code: 'unsafe-file' };
      return { data: readFileSync(descriptor) };
    } finally { closeSync(descriptor); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { code: code === 'ENOENT' ? 'missing-file' : code === 'ELOOP' ? 'unsafe-file' : 'unreadable-file' };
  }
}

function manifestShape(value: unknown): value is Manifest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<Manifest>;
  return v.version === 1 && typeof v.createdAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.createdAt) &&
    Number.isFinite(Date.parse(v.createdAt)) && new Date(v.createdAt).toISOString() === v.createdAt &&
    Number.isSafeInteger(v.books) && Number(v.books) > 0 && Array.isArray(v.files) && v.files.length > 0;
}

function inspectDatabase(bytes: Buffer, report: BackupVerificationReport): void {
  const result: BackupDatabaseVerification = {
    quickCheck: 'not-run', foreignKeyViolations: null, foreignKeyViolationsByTable: {}, schema: null, counts: {}
  };
  report.database = result;
  let db: Database.Database | undefined;
  try {
    if (bytes.length < 100 || bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') {
      report.issues.push({ code: 'database-unreadable', message: 'The verified database file is not a readable SQLite database.', path: 'books.db' });
      return;
    }
    // Deserialize only the checksum-verified bytes, never the on-disk database.
    // SQLite requires rollback-mode header bytes for a deserialized WAL snapshot:
    // https://www.sqlite.org/c3ref/deserialize.html . Only this memory copy changes.
    const image = Buffer.from(bytes);
    if (image[18] === 2 && image[19] === 2) { image[18] = 1; image[19] = 1; }
    db = new Database(image, { readonly: true });
    db.pragma('trusted_schema = OFF');
    db.pragma('query_only = ON');

    try {
      const checks = db.pragma('quick_check') as Record<string, unknown>[];
      result.quickCheck = checks.length === 1 && Object.values(checks[0])[0] === 'ok' ? 'ok' : 'failed';
      if (result.quickCheck === 'failed') report.issues.push({ code: 'quick-check-failed', message: 'SQLite quick_check failed.', path: 'books.db' });
    } catch {
      result.quickCheck = 'failed';
      report.issues.push({ code: 'quick-check-failed', message: 'SQLite quick_check could not complete.', path: 'books.db' });
    }

    try {
      let count = 0;
      for (const row of db.prepare('PRAGMA foreign_key_check').iterate() as Iterable<{ table: string }>) {
        count++;
        const table = CATALOG_TABLES.find(name => name === row.table) ?? 'other_tables';
        result.foreignKeyViolationsByTable[table] = (result.foreignKeyViolationsByTable[table] ?? 0) + 1;
      }
      result.foreignKeyViolations = count;
      if (count) report.issues.push({ code: 'foreign-key-violations', message: `SQLite foreign_key_check found ${count} broken references.`, path: 'books.db' });
    } catch {
      report.issues.push({ code: 'foreign-key-check-failed', message: 'SQLite foreign_key_check could not complete.', path: 'books.db' });
    }

    try {
      const tables = (db.pragma('table_list') as { schema: string; name: string; type: string }[])
        .filter(table => table.schema === 'main' && table.type !== 'view' && !table.name.startsWith('sqlite_'));
      const ordinary = new Set(tables.filter(table => table.type === 'table').map(table => table.name));
      const knownTables = CATALOG_TABLES.filter(name => ordinary.has(name));
      result.schema = {
        schemaVersion: db.pragma('schema_version', { simple: true }) as number,
        userVersion: db.pragma('user_version', { simple: true }) as number,
        tableCount: tables.length, knownTables, otherTableCount: tables.length - knownTables.length
      };
      for (const table of knownTables) {
        result.counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
      }
      if (!ordinary.has('books')) report.issues.push({ code: 'missing-books-table', message: 'The snapshot has no ordinary books table.', path: 'books.db' });
      else if (result.counts.books !== report.manifest!.books) {
        report.issues.push({ code: 'book-count-mismatch', message: 'The books count does not match the manifest.', path: 'books.db' });
      }
    } catch {
      report.issues.push({ code: 'schema-check-failed', message: 'The database schema or catalog counts could not be inspected.', path: 'books.db' });
    }
  } catch {
    report.issues.push({ code: 'database-unreadable', message: 'The verified database file could not be opened read-only.', path: 'books.db' });
  } finally { db?.close(); }
}

/** Verify an offline extracted backup. No writes, migrations, restores, or network requests. */
export function verifyBackupSnapshot(snapshot: string): BackupVerificationReport {
  const report: BackupVerificationReport = {
    ok: false, manifest: null, files: { checked: 0, verified: 0, verifiedBytes: 0, missing: [] }, database: null, issues: []
  };
  let root: string;
  try {
    const candidate = resolve(snapshot);
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      report.issues.push({ code: 'snapshot-unsafe', message: 'The snapshot must be a directory, not a symlink.' });
      return report;
    }
    root = realpathSync(candidate);
  } catch {
    report.issues.push({ code: 'snapshot-unavailable', message: 'The snapshot directory is unavailable.' });
    return report;
  }

  const manifestFile = readRegularFile(root, 'manifest.json');
  if (!('data' in manifestFile)) {
    if (manifestFile.code === 'missing-file') report.files.missing.push('manifest.json');
    report.issues.push({ code: manifestFile.code, message: 'The manifest must be a readable regular file without symlinks.', path: 'manifest.json' });
    return report;
  }
  let manifest: Manifest;
  try {
    const value: unknown = JSON.parse(manifestFile.data.toString('utf8'));
    if (!manifestShape(value)) throw new Error();
    manifest = value;
  } catch {
    report.issues.push({ code: 'manifest-invalid', message: 'The manifest is not a valid version 1 catalog backup manifest.', path: 'manifest.json' });
    return report;
  }
  report.manifest = { version: 1, createdAt: manifest.createdAt, books: manifest.books, declaredFiles: manifest.files.length };

  // A backup made by sqlite3_backup is standalone. Empty WAL/SHM files can be
  // leftovers from a previous reader, but unverified journal data is not a backup.
  for (const path of ['books.db-wal', 'books.db-journal', 'books.db-shm']) {
    try {
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink() || !stat.isFile()) report.issues.push({ code: 'unsafe-file', message: 'A database sidecar is not a regular file.', path });
      else if (path !== 'books.db-shm' && stat.size > 0) report.issues.push({ code: 'unexpected-sidecar', message: 'The snapshot contains unverified database journal data.', path });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report.issues.push({ code: 'unreadable-file', message: 'A database sidecar could not be inspected.', path });
    }
  }

  const seen = new Set<string>();
  let databaseBytes: Buffer | undefined;
  for (const [entry, value] of manifest.files.entries()) {
    if (!value || typeof value !== 'object') {
      report.issues.push({ code: 'manifest-invalid', message: 'A manifest file entry is invalid.', entry });
      continue;
    }
    const file = value as Partial<ManifestFile>;
    // This is the complete version-1 layout; it excludes absolute paths,
    // backslashes, traversal components, URI paths, and unknown files.
    if (typeof file.path !== 'string' || !/^(?:books\.db|covers\/[a-f0-9]{64}\.(?:jpg|png|webp))$/.test(file.path)) {
      report.issues.push({ code: 'unsafe-path', message: 'A manifest path is outside the permitted snapshot layout.', entry });
      continue;
    }
    if (seen.has(file.path)) {
      report.issues.push({ code: 'duplicate-file', message: 'The manifest declares the same file more than once.', path: file.path, entry });
      continue;
    }
    seen.add(file.path);
    if (!Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      report.issues.push({ code: 'manifest-invalid', message: 'A file entry needs a nonnegative byte count and SHA256 checksum.', path: file.path, entry });
      continue;
    }
    if (file.path.startsWith('covers/') && file.path.slice(7, 71) !== file.sha256) {
      report.issues.push({ code: 'cover-hash-mismatch', message: 'A cover filename does not match its declared content hash.', path: file.path, entry });
    }
    const read = readRegularFile(root, file.path);
    report.files.checked++;
    if (!('data' in read)) {
      if (read.code === 'missing-file') report.files.missing.push(file.path);
      report.issues.push({ code: read.code, message: 'A declared file is missing, unreadable, or not a regular file without symlinks.', path: file.path });
      continue;
    }
    const sameSize = read.data.length === file.bytes;
    const sameHash = createHash('sha256').update(read.data).digest('hex') === file.sha256;
    if (!sameSize) report.issues.push({ code: 'size-mismatch', message: 'A file byte count does not match the manifest.', path: file.path });
    if (!sameHash) report.issues.push({ code: 'checksum-mismatch', message: 'A file SHA256 checksum does not match the manifest.', path: file.path });
    if (sameSize && sameHash) {
      report.files.verified++;
      report.files.verifiedBytes += read.data.length;
      if (file.path === 'books.db') databaseBytes = read.data;
    }
  }
  if (!seen.has('books.db')) report.issues.push({ code: 'manifest-invalid', message: 'The manifest must declare books.db.', path: 'books.db' });
  if (databaseBytes) inspectDatabase(databaseBytes, report);
  report.ok = report.issues.length === 0;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { snapshot: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('Usage: verify-backup --snapshot PATH\nVerify an extracted catalog snapshot offline without changing any files. Reports only integrity results and catalog counts.');
    else if (!values.snapshot) {
      console.error('A snapshot directory is required. Use --snapshot PATH.');
      process.exitCode = 1;
    } else {
      const report = verifyBackupSnapshot(values.snapshot);
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
    }
  } catch {
    console.error('Snapshot verification could not run. Use --snapshot PATH to select an extracted backup directory.');
    process.exitCode = 1;
  }
}
