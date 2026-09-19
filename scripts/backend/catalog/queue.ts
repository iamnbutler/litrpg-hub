import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
export const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export interface Job { id: string; kind: string; entity_id: string; input_hash: string; payload_json: string; attempts: number; lease_owner: string; max_attempts: number }
export function enqueue(db: Database.Database, kind: string, entity: string, input: string, payload: unknown, priority = 0, now = new Date()): boolean {
  const stamp = now.toISOString(), id = hash([kind,entity,input]);
  return db.prepare(`INSERT OR IGNORE INTO catalog_jobs(id,kind,entity_id,input_hash,payload_json,priority,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(id,kind,entity,input,JSON.stringify(payload),priority,stamp,stamp,stamp).changes > 0;
}
export function claim(db: Database.Database, kinds: string[], now = new Date(), seriesId?: string): Job | null {
  if (!kinds.length) return null;
  const stamp = now.toISOString(), owner = randomUUID(), lease = new Date(now.getTime() + 180_000).toISOString();
  return db.transaction(() => {
    db.prepare(`UPDATE catalog_jobs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'retry' END, lease_owner=NULL,lease_until=NULL,updated_at=? WHERE status='running' AND lease_until<?`).run(stamp,stamp);
    const scope = seriesId ? ` AND (json_extract(payload_json,'$.seriesId')=? OR entity_id=? OR entity_id IN (SELECT id FROM catalog_works WHERE series_id=?))` : '';
    // A changed input can create another job while the old one is running. Both workers
    // read current evidence, so running them together would pay for the same inference twice.
    const row = db.prepare(`SELECT id FROM catalog_jobs AS ready WHERE status IN ('pending','retry') AND available_at<=? AND kind IN (${kinds.map(() => '?').join(',')})${scope}
      AND NOT EXISTS (SELECT 1 FROM catalog_jobs AS active WHERE active.status='running' AND active.kind=ready.kind AND active.entity_id=ready.entity_id)
      ORDER BY priority DESC,created_at,id LIMIT 1`)
      .get(stamp,...kinds,...(seriesId ? [seriesId,seriesId,seriesId] : [])) as { id: string } | undefined;
    if (!row) return null;
    return db.prepare(`UPDATE catalog_jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE id=? RETURNING *`).get(owner,lease,stamp,row.id) as Job;
  }).immediate();
}
export function finish(db: Database.Database, job: Job, result: unknown) {
  const changed = db.prepare(`UPDATE catalog_jobs SET status='completed',result_json=?,lease_owner=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='running' AND lease_owner=?`)
    .run(JSON.stringify(result),new Date().toISOString(),job.id,job.lease_owner).changes;
  if (!changed) throw new Error('Job lease expired before completion; safe to resume.');
}
export function fail(db: Database.Database, job: Job, message: string, review = false, now = new Date()) {
  const status = review ? 'review' : job.attempts >= job.max_attempts ? 'failed' : 'retry';
  db.prepare(`UPDATE catalog_jobs SET status=?,available_at=?,lease_owner=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND lease_owner=?`)
    .run(status,new Date(now.getTime()+Math.min(3_600_000,30_000*2**(job.attempts-1))).toISOString(),message.slice(0,500),now.toISOString(),job.id,job.lease_owner);
}
/**
 * The source asked us to come back at a specific time. That is not a failed attempt, so the
 * attempt is handed back and the job simply becomes claimable again when the source said it
 * would be. `fail(..., review)` cannot express this: `review` is terminal for `claim`, so a
 * rate-limited job parked there would never resume.
 */
export function defer(db: Database.Database, job: Job, message: string, availableAt: Date, now = new Date()) {
  db.prepare(`UPDATE catalog_jobs SET status='retry',attempts=MAX(0,attempts-1),available_at=?,lease_owner=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND lease_owner=?`)
    .run(availableAt.toISOString(),message.slice(0,500),now.toISOString(),job.id,job.lease_owner);
}
