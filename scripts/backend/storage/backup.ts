import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { getDb, closeDb, DB_PATH } from '../db.js';
import { runMigrations } from '../migrate.js';
import { archiveCurrentSources } from './history.js';
import { COVER_ASSET_DIR } from '../covers/assets.js';

export async function backupCatalog(db: Database.Database, directory: string, assets = COVER_ASSET_DIR): Promise<string> {
	if (!(db.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number }).n) throw new Error('Refusing to back up an empty catalog.');
	mkdirSync(directory,{ recursive:true });
	const temporary = mkdtempSync(join(directory,'.partial-'));
	const snapshot = join(temporary,'books.db');
	// Includes committed WAL changes; copying the live .db file alone is unsafe.
	await db.backup(snapshot);
	const verification = new Database(snapshot,{ readonly:true });
	let books = 0;
	try {
		if (verification.pragma('quick_check',{ simple:true }) !== 'ok') throw new Error('Catalog backup failed the SQLite integrity check.');
		if ((verification.pragma('foreign_key_check') as unknown[]).length) throw new Error('Catalog backup has broken references; repair or quarantine the orphaned evidence before archiving.');
		books = (verification.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number }).n;
	} finally { verification.close(); }
	const files: { path: string; bytes: number; sha256: string }[] = [];
	const record = (path: string) => {
		const data = readFileSync(join(temporary,path));
		files.push({ path,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex') });
	};
	record('books.db');
	if (existsSync(assets)) {
		mkdirSync(join(temporary,'covers'));
		for (const file of readdirSync(assets).sort()) {
			if (!/^[a-f0-9]{64}\.(jpg|png|webp)$/.test(file)) continue;
			copyFileSync(join(assets,file),join(temporary,'covers',file));
			record(`covers/${file}`);
			if (files.at(-1)!.sha256 !== file.slice(0,64)) throw new Error('Cover asset checksum failed while backing up.');
		}
	}
	const createdAt = new Date().toISOString();
	writeFileSync(join(temporary,'manifest.json'),JSON.stringify({ version:1,createdAt,books,files },null,2));
	const destination = join(directory,`catalog-${createdAt.replace(/[:.]/g,'-')}-${basename(temporary).slice(-6)}`);
	renameSync(temporary,destination);
	return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const { values } = parseArgs({ options: { dir:{ type:'string' },help:{ type:'boolean' } } });
		if (values.help) console.log('npm run pipeline:backup -- [--dir data/backups]\nCreates a new verified SQLite snapshot, source history, inference cache, cover assets, and checksum manifest. Never overwrites an earlier backup. Copy the resulting folder to durable off-machine storage.');
		else {
			if (!existsSync(DB_PATH)) throw new Error('No local catalog database exists to back up.');
			runMigrations();
			const db = getDb();
			console.log(`Retained ${archiveCurrentSources(db)} previously unarchived source snapshots.`);
			const directory = resolve(import.meta.dirname,'../../../',values.dir || 'data/backups');
			console.log(`Verified catalog backup: ${await backupCatalog(db,directory)}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'Catalog backup failed.'); process.exitCode = 1;
	} finally { closeDb(); }
}
