import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const COVER_ASSET_DIR = resolve(import.meta.dirname,'../../../',process.env.CATALOG_ASSET_DIR || 'data/covers');
const extensions: Record<string,string> = { 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp' };
export interface CoverImage { data: Buffer; mime: string; hash: string }

export function storeCoverAsset(image: CoverImage, directory = COVER_ASSET_DIR): void {
	const extension = extensions[image.mime];
	if (!extension || !/^[a-f0-9]{64}$/.test(image.hash) || createHash('sha256').update(image.data).digest('hex') !== image.hash) throw new Error('Invalid cover asset hash or type.');
	mkdirSync(directory,{ recursive:true });
	const path = join(directory,`${image.hash}.${extension}`);
	if (existsSync(path)) {
		if (createHash('sha256').update(readFileSync(path)).digest('hex') !== image.hash) throw new Error('Stored cover asset failed its checksum.');
		return;
	}
	writeFileSync(path,image.data,{ flag:'wx' });
}
export function readCoverAsset(hash: string, directory = COVER_ASSET_DIR): CoverImage | null {
	if (!/^[a-f0-9]{64}$/.test(hash)) return null;
	for (const [mime,extension] of Object.entries(extensions)) {
		const path = join(directory,`${hash}.${extension}`);
		if (!existsSync(path)) continue;
		const data = readFileSync(path);
		if (createHash('sha256').update(data).digest('hex') !== hash) throw new Error('Stored cover asset failed its checksum.');
		return { data,mime,hash };
	}
	return null;
}
