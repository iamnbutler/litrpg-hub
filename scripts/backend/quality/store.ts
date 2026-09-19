import type Database from 'better-sqlite3';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hash } from '../catalog/queue.js';

export interface SnapshotScore {
  id: string;
  craft: { score: number | null; confidence: number };
  index: { score: number | null };
}
export interface QualitySnapshot {
  version: string;
  generatedAt: string;
  books: SnapshotScore[];
  series: SnapshotScore[];
  authors: SnapshotScore[];
}

/** Content-addressed: recomputing an unchanged report does not create another snapshot. */
export function persistQualityIndex(db: Database.Database, report: QualitySnapshot): string {
  const timestamp = new Date(report.generatedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('Quality snapshot needs a valid generation timestamp.');
  const generatedAt = timestamp.toISOString();
  const inputHash = hash({ ...report, generatedAt: undefined });
  const id = hash(['quality-index', report.version, inputHash]);
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO quality_index_runs(id,policy_version,input_hash,generated_at,report_json) VALUES(?,?,?,?,?)')
      .run(id, report.version, inputHash, report.generatedAt, JSON.stringify(report));
    const insert = db.prepare(`INSERT OR IGNORE INTO quality_index_scores(run_id,entity_type,entity_id,craft_score,index_score,confidence,result_json) VALUES(?,?,?,?,?,?,?)`);
    for (const [kind, rows] of [['book', report.books], ['series', report.series], ['author', report.authors]] as const) {
      for (const row of rows) insert.run(id, kind, row.id, row.craft.score, row.index.score, row.craft.confidence, JSON.stringify(row));
    }
    // A reversion can reuse an older content-addressed row. Advance a separate
    // head even when the inserts above did nothing; stale imports cannot rewind it.
    db.prepare(`INSERT INTO quality_index_head(singleton,run_id,generated_at) VALUES(1,?,?)
      ON CONFLICT(singleton) DO UPDATE SET run_id=excluded.run_id,generated_at=excluded.generated_at
      WHERE julianday(quality_index_head.generated_at) < julianday(excluded.generated_at)
        OR (julianday(quality_index_head.generated_at) = julianday(excluded.generated_at)
          AND quality_index_head.run_id <> excluded.run_id)`).run(id, generatedAt);
  })();
  return id;
}

/** Atomic output, with a guard against replacing SQLite or one of its sidecars. */
export function writeQualityReport(path: string, report: unknown, databasePath?: string): void {
  const output = resolve(path);
  if (databasePath && output === resolve(databasePath) || /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i.test(output)) {
    throw new Error('Quality report output must be separate from database files.');
  }
  mkdirSync(dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`;
  let created = false;
  try {
    writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    created = true;
    renameSync(temp, output);
  } finally { if (created) rmSync(temp, { force: true }); }
}
