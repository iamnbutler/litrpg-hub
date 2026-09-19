import Database from 'better-sqlite3';
import{readFileSync}from'node:fs';
import{describe,it,expect,vi}from'vitest';
import{resolveAudioLink}from'./audio-links.js';

describe('observed author audio links',()=>{
  const database=()=>{const db=new Database(':memory:');db.exec(readFileSync(new URL('../migrations/006_catalog_pipeline.sql',import.meta.url),'utf8'));return db;};
  it('retains the redirect and replays without fetching the shortener or retailer again',async()=>{
    const db=database();try{
      const request=vi.fn().mockResolvedValue(new Response(null,{status:301,headers:{location:'https://www.amazon.com/story/dp/B000000001?tag=author'}}));
      const first=await resolveAudioLink(db,'https://amzn.to/abc123',request);
      expect(first.asin).toBe('B000000001');
      expect(await resolveAudioLink(db,'https://amzn.to/abc123',request)).toEqual(first);
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0][1]).toMatchObject({method:'HEAD',redirect:'manual'});
      expect(first.document.body).not.toContain('?tag=');
    }finally{db.close();}
  });
  it.each(['https://evil.example/dp/B000000001','https://www.amazon.co.uk/dp/B000000001','http://127.0.0.1/dp/B000000001'])('refuses an unsupported destination %s without following it',async location=>{
    const db=database();try{
      const request=vi.fn().mockResolvedValue(new Response(null,{status:302,headers:{location}}));
      await expect(resolveAudioLink(db,'https://amzn.to/abc123',request)).rejects.toThrow(/US retailer/);
      expect(request).toHaveBeenCalledOnce();
      expect(db.prepare('SELECT COUNT(*) n FROM catalog_documents').get()).toEqual({n:0});
    }finally{db.close();}
  });
  it('rejects arbitrary input hosts before requesting anything',async()=>{
    const db=database();try{const request=vi.fn();await expect(resolveAudioLink(db,'https://amzn.to.evil.example/abc123',request)).rejects.toThrow();expect(request).not.toHaveBeenCalled();}finally{db.close();}
  });
});
