/** Upload a verified snapshot as a release asset in an explicitly private data repository. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { getDb, closeDb } from '../db.js';
import { runMigrations } from '../migrate.js';
import { backupCatalog } from './backup.js';
import { archiveCurrentSources } from './history.js';

const gh = (args: string[]) => execFileSync('gh',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:180_000});
export function requirePrivateRepository(repo: string, inspect = gh): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Use an owner/repository name for the archive destination.');
  const info=JSON.parse(inspect(['repo','view',repo,'--json','isPrivate']));
  if (info.isPrivate !== true) throw new Error('The catalog source archive can only be uploaded to a private repository.');
}

/** Archive the closed backup layout, never other files a reader or operator left beside it. */
export function packSnapshot(snapshot: string, files: {path:string}[], archive = `${snapshot}.tar.gz`): void {
  const tag=basename(snapshot);
  if(!/^catalog-[A-Za-z0-9_-]+$/.test(tag)||!files.some(file=>file.path==='books.db')||
    files.some(file=>! /^(?:books\.db|covers\/[a-f0-9]{64}\.(?:jpg|png|webp))$/.test(file.path))||
    new Set(files.map(file=>file.path)).size!==files.length)throw new Error('The archive manifest contains an unsupported file.');
  const paths=[`${tag}/manifest.json`,...files.map(file=>`${tag}/${file.path}`)];
  execFileSync('tar',['-czf',archive,'-C',dirname(snapshot),'-T','-'],{
    input:`${paths.join('\n')}\n`,stdio:['pipe','pipe','pipe'],timeout:120_000,
    // macOS tar otherwise adds resource-fork metadata outside the checksum manifest.
    env:{...process.env,COPYFILE_DISABLE:'1'}
  });
}

export async function archiveCatalog(repo: string): Promise<{url:string;sha256:string;bytes:number;snapshot:string}> {
  requirePrivateRepository(repo);
  runMigrations();
  const db=getDb();archiveCurrentSources(db);
  const snapshot=await backupCatalog(db,resolve(import.meta.dirname,'../../../data/backups'));
  const manifest=JSON.parse(readFileSync(join(snapshot,'manifest.json'),'utf8')) as {createdAt:string;books:number;files:{path:string;sha256:string}[]};
  // Only the known backup files enter the archive. Environment files and working directories never do.
  const secrets=Object.entries(process.env).filter(([name,value])=>/(?:API_KEY|API_TOKEN|TYPESAFE|HARDCOVER)/.test(name)&&value&&value.length>12).map(([,value])=>value!);
  for(const file of manifest.files){
    const bytes=readFileSync(join(snapshot,file.path));
    if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('Snapshot checksum changed before archival.');
    if(secrets.some(secret=>bytes.includes(Buffer.from(secret))))throw new Error('A credential was detected in the snapshot. Archive upload was stopped.');
  }
  const tag=basename(snapshot),archive=`${snapshot}.tar.gz`;
  packSnapshot(snapshot,manifest.files,archive);
  const bytes=readFileSync(archive),sha256=createHash('sha256').update(bytes).digest('hex');
  const checksum=`${archive}.sha256`;writeFileSync(checksum,`${sha256}  ${basename(archive)}\n`,{mode:0o600});
  const notes=join(snapshot,'release-notes.md');
  writeFileSync(notes,`Verified catalog snapshot from ${manifest.createdAt}.\n\nContains ${manifest.books} legacy/audio edition records plus canonical series, works, source evidence, inference caches, job progress, and ${manifest.files.length-1} cached cover assets. See the enclosed checksum manifest.\n\nSHA-256 of archive: ${sha256}\n\nSource text is private working evidence; use the application exporter for public data. Code and schema versions may include current uncommitted development work.\n`,{mode:0o600});
  // Check again immediately before the upload in case repository visibility was changed.
  requirePrivateRepository(repo);
  const url=gh(['release','create',tag,archive,checksum,'--repo',repo,'--title',`Catalog ${manifest.createdAt}`,'--notes-file',notes,'--latest']).trim();
  return {url,sha256,bytes:bytes.length,snapshot};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const {values}=parseArgs({options:{repo:{type:'string'},help:{type:'boolean'}}});
    if(values.help)console.log('npm run pipeline:archive -- --repo OWNER/PRIVATE_DATA_REPO\nCreates a verified SQLite/cover backup, checks repository privacy and credential exclusion, then uploads a private GitHub release with checksums. Requires authenticated gh.');
    else{
      const repo=values.repo??process.env.CATALOG_ARCHIVE_REPO;
      if(!repo)throw new Error('Specify --repo OWNER/PRIVATE_DATA_REPO or CATALOG_ARCHIVE_REPO.');
      console.log(JSON.stringify(await archiveCatalog(repo),null,2));
    }
  }catch(error){console.error(error instanceof Error&& !('stderr' in error)?error.message:'Private archive operation failed; the local verified snapshot is retained.');process.exitCode=1;}
  finally{closeDb();}
}
