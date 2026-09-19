import Database from 'better-sqlite3';
import { mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CatalogHealth } from '../../../src/lib/catalog-health.js';
import { buildCatalogHealth, type CatalogHealthOptions } from '../catalog/health.js';

export interface HealthExportOptions extends CatalogHealthOptions {
  databasePath?: string;
  outputPath?: string;
  now?: Date;
}

/** Writes only the safe static report. The source database is always opened read-only. */
export function exportHealth(options: HealthExportOptions = {}): CatalogHealth {
  const root = resolve(import.meta.dirname, '../../..');
  const databasePath = resolve(root, options.databasePath ?? process.env.CATALOG_DB_PATH ?? 'data/books.db');
  const outputPath = resolve(root, options.outputPath ?? 'static/data/health.json');
  // Even a mistaken CLI --out must not overwrite a private cache with public JSON.
  if (outputPath === databasePath || /(?:\.db|\.sqlite|\.sqlite3)(?:-(?:wal|shm))?$/i.test(outputPath)) {
    throw new Error('The health report output must be separate from database files.');
  }
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  let report: CatalogHealth;
  try { report = buildCatalogHealth(db, options.now ?? new Date(), options); }
  finally { db.close(); }
  if (!report.totals.series || !report.totals.works) {
    throw new Error('Refusing to replace the health snapshot with an empty canonical catalog.');
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  let created = false;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    created = true;
    renameSync(temporaryPath, outputPath);
  } finally { if (created) rmSync(temporaryPath, { force: true }); }
  return report;
}

export function runHealthExport(args: string[] = process.argv.slice(2)): void {
  const options: HealthExportOptions = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help') {
      console.log('Health snapshot: --db <existing database> --out <public JSON> --assets <private cover cache>. Reads retained evidence only; no fetching, paid calls, or migrations.');
      return;
    }
    const key = ({ '--db': 'databasePath', '--out': 'outputPath', '--assets': 'assetDirectory' } as const)[argument as '--db' | '--out' | '--assets'];
    const value = args[++index];
    if (!key || !value || value.startsWith('--')) throw new Error('Invalid health export arguments. Use --help.');
    options[key] = resolve(value);
  }
  const report = exportHealth(options);
  console.log(JSON.stringify({ generatedAt: report.generatedAt, ...report.totals }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runHealthExport(); }
  catch {
    // Native filesystem/SQLite errors may contain private paths. The public-facing
    // command reports only the operation; detailed local investigation is separate.
    console.error('Health export failed. Check the existing database schema, retained evidence, cover cache, and output location. No database writes or network requests were attempted.');
    process.exitCode = 1;
  }
}
