import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
export const DB_PATH = resolve(PROJECT_ROOT, process.env.CATALOG_DB_PATH || 'data/books.db');
const DB_DIR = dirname(DB_PATH);

let db: Database.Database | null = null;

export function getDb(): Database.Database {
	if (!db) {
		mkdirSync(DB_DIR, { recursive: true });
		db = new Database(DB_PATH);
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
	}
	return db;
}

export function closeDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}
