import { describe,it,expect,vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packSnapshot,requirePrivateRepository } from './archive.js';
describe('private source archive boundary',()=>{
  it('refuses public or indeterminate destinations before creating or uploading a snapshot',()=>{
    expect(()=>requirePrivateRepository('owner/public',()=>'{"isPrivate":false}')).toThrow(/private repository/);
    expect(()=>requirePrivateRepository('owner/unknown',()=>'{}')).toThrow(/private repository/);
    const inspect=vi.fn();expect(()=>requirePrivateRepository('--repo public',inspect)).toThrow(/owner\/repository/);expect(inspect).not.toHaveBeenCalled();
    expect(()=>requirePrivateRepository('owner/private',()=>'{"isPrivate":true}')).not.toThrow();
  });
  it('includes only manifest files even when private notes, credentials, or SQLite sidecars sit beside them',()=>{
    const root=mkdtempSync(join(tmpdir(),'catalog-archive-'));
    try{
      const snapshot=join(root,'catalog-test');mkdirSync(snapshot);mkdirSync(join(snapshot,'covers'));
      const cover=`covers/${'a'.repeat(64)}.jpg`;
      for(const path of ['manifest.json','books.db',cover,'books.db-wal','books.db-shm','.env','private-notes.md'])writeFileSync(join(snapshot,path),'fixture');
      packSnapshot(snapshot,[{path:'books.db'},{path:cover}]);
      const entries=execFileSync('tar',['-tzf',`${snapshot}.tar.gz`],{encoding:'utf8'}).trim().split('\n');
      expect(entries.sort()).toEqual(['catalog-test/manifest.json','catalog-test/books.db',`catalog-test/${cover}`].sort());
      expect(()=>packSnapshot(snapshot,[{path:'books.db'},{path:'../.env'}])).toThrow(/unsupported file/);
      expect(()=>packSnapshot(snapshot,[{path:cover}])).toThrow(/unsupported file/);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
