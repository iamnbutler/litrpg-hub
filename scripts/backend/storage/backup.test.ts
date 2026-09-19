import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { backupCatalog } from './backup.js';
import { readCoverAsset, storeCoverAsset } from '../covers/assets.js';

describe('persistent catalog evidence', () => {
	it('opens a backup containing committed WAL data and matching cover bytes', async () => {
		const directory = mkdtempSync(join(tmpdir(),'litrpg-backup-test-'));
		const db = new Database(join(directory,'live.db'));
		try {
			db.pragma('journal_mode=WAL');
			db.exec("CREATE TABLE books (id TEXT PRIMARY KEY); INSERT INTO books VALUES ('book-one')");
			const data = Buffer.from([255,216,255,217]), hash = createHash('sha256').update(data).digest('hex');
			const assets = join(directory,'assets');
			storeCoverAsset({ data,hash,mime:'image/jpeg' },assets);
			const backup = await backupCatalog(db,join(directory,'backups'),assets);
			const restored = new Database(join(backup,'books.db'),{ readonly:true });
			try { expect(restored.prepare('SELECT id FROM books').get()).toEqual({ id:'book-one' }); } finally { restored.close(); }
			const manifest = JSON.parse(readFileSync(join(backup,'manifest.json'),'utf8'));
			expect(manifest.books).toBe(1);
			expect(manifest.files).toHaveLength(2);
			expect(readCoverAsset(hash,join(backup,'covers'))?.data).toEqual(data);
			writeFileSync(join(backup,'covers',`${hash}.jpg`),'corrupted');
			expect(() => readCoverAsset(hash,join(backup,'covers'))).toThrow(/checksum/);
		} finally { db.close(); rmSync(directory,{ recursive:true,force:true }); }
	});
});
