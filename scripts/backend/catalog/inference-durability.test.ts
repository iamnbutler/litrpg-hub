import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { questions, assessmentHash, RUBRIC_VERSION } from '../jev/assessment.js';
import { processAssessment, processExtraction, profileInput, extractionInput, extractionHash, saveInference } from './inference.js';
import { PaidResponseStorageError, ReviewError, type SeedSeries, type WorkRow } from './types.js';
import { runCatalogGrind } from './grind.js';
import { enqueue } from './queue.js';

let db: Database.Database;
const seed: SeedSeries = { id:'sample',title:'Sample',author:'A. Writer',authorAliases:['A. Writer'],aliases:[],genres:['litrpg'],sources:[],priority:1 };
const id='work-sample-1';
const description='An apprentice healer and a veteran ranger travel into an abandoned underground city to recover a missing caravan before their supplies run out.';
const synopsis='An apprentice healer joins a veteran ranger to search an abandoned city below ground. Their supplies are limited, and a missing caravan gives the expedition an urgent purpose.';
const extraction={status:'completed',model:'actual-extractor',usage:{input_tokens:31,output_tokens:9},output:[{content:[{type:'output_text',text:JSON.stringify({synopsis,features:[]})}]}]};
function jev() {
  return {model:'actual-jev',usage:{input_tokens:43,output_tokens:13},answers:Object.fromEntries(Object.entries(questions).map(([key,q])=>{
    if(q.type==='choice'){
      const choices=Object.keys(q.criteria),choice=choices.includes('unknown')?'unknown':choices[0];
      return [key,{type:'choice',choice,confidence:0.8,probabilities:Object.fromEntries(choices.map(c=>[c,c===choice?1:0]))}];
    }
    return [key,q.type==='score'?{type:'score',score:2,confidence:0.8}:{type:'noul',noul:0.5}];
  }))};
}
const work=()=>db.prepare('SELECT * FROM catalog_works WHERE id=?').get(id) as WorkRow;
const receipts=(kind:string)=>db.prepare('SELECT * FROM catalog_inferences WHERE kind=?').all(kind) as {result_json:string;usage_json:string;requested_model:string}[];

beforeEach(()=>{
  db=new Database(':memory:');db.pragma('foreign_keys = ON');
  for(const name of ['001_initial.sql','006_catalog_pipeline.sql'])db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  db.prepare('INSERT INTO catalog_series(id,title,author,updated_at) VALUES(?,?,?,?)').run(seed.id,seed.title,seed.author,'2026-09-19T00:00:00Z');
  db.prepare('INSERT INTO catalog_works(id,series_id,number,title,author,source_description,source_url,updated_at) VALUES(?,?,1,?,?,?,?,?)')
    .run(id,seed.id,'Sample One',seed.author,description,'https://aethonbooks.com/book/sample/','2026-09-19T00:00:00Z');
  vi.stubEnv('OPENAI_API_KEY','private-openai-test');vi.stubEnv('TYPESAFE_API_KEY','private-jev-test');
  vi.stubEnv('JEV_MODEL','requested-jev');vi.stubEnv('CATALOG_OPENAI_MODEL','requested-extractor');
});
afterEach(()=>{if(db.inTransaction)db.exec('ROLLBACK');db.close();vi.unstubAllEnvs();vi.unstubAllGlobals();});

describe('catalog paid response durability',()=>{
  it('retains even malformed OpenAI HTTP JSON once, with unknown usage rather than invented zero',async()=>{
    const raw=' { broken private response';const fetch=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',fetch);
    await expect(processExtraction(db,id,'extract',{})).rejects.toThrow(ReviewError);
    await expect(processExtraction(db,id,'extract',{})).rejects.toThrow(ReviewError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(receipts('extract-wire-response')).toHaveLength(1);
    expect(JSON.parse(receipts('extract-wire-response')[0].result_json)).toBe(raw);
    expect(JSON.parse(receipts('extract-wire-response')[0].usage_json)).toEqual({});
    expect(work().description).toBe('');
  });
  it('still replays the previously retained parsed OpenAI wire format without another call',async()=>{
    const inputHash=extractionHash(extractionInput(work()));
    saveInference(db,'work',id,'extract-wire-response',inputHash,'requested-extractor','actual-extractor','prior',extraction,extraction.usage);
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    expect(await processExtraction(db,id,'extract',{})).toMatchObject({cached:true,promoted:true,input_tokens:0,output_tokens:0});
    expect(fetch).not.toHaveBeenCalled();expect(work().description).toBe(synopsis);
  });
  it.each(['malformed-json','missing-answer','invalid-usage'])('retains a paid Jev %s answer and parks unchanged retries for review',async(kind)=>{
    const response=jev();
    const raw=kind==='malformed-json'?'unparseable private response':JSON.stringify(kind==='missing-answer'?{...response,answers:{}}:{...response,usage:{input_tokens:1.5,output_tokens:2}});
    const fetch=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',fetch);
    await expect(processAssessment(db,id,seed)).rejects.toThrow(ReviewError);
    await expect(processAssessment(db,id,seed)).rejects.toThrow(ReviewError);
    expect(fetch).toHaveBeenCalledOnce();expect(receipts('jev-wire-response')).toHaveLength(1);
    expect(JSON.parse(receipts('jev-wire-response')[0].result_json)).toBe(raw);
    expect(receipts('jev')).toHaveLength(0);expect(work().assessment_json).toBeNull();
  });
  it('replays a committed Jev response after promotion fails, counting usage exactly once',async()=>{
    const raw=` ${JSON.stringify(jev())}\n`;const fetch=vi.fn(async()=>new Response(raw));vi.stubGlobal('fetch',fetch);
    db.exec("CREATE TRIGGER fail_promotion BEFORE UPDATE OF assessment_json ON catalog_works BEGIN SELECT RAISE(ABORT,'simulated interruption'); END");
    await expect(processAssessment(db,id,seed)).rejects.toThrow('simulated interruption');
    expect(receipts('jev-wire-response')).toHaveLength(1);expect(receipts('jev')).toHaveLength(0);
    db.exec('DROP TRIGGER fail_promotion');
    expect(await processAssessment(db,id,seed)).toMatchObject({cached:true,promoted:true,input_tokens:0,output_tokens:0});
    expect(fetch).toHaveBeenCalledOnce();expect(JSON.parse(work().assessment_json!).model).toBe('actual-jev');
    expect(db.prepare("SELECT sum(json_extract(usage_json,'$.input_tokens')) n FROM catalog_inferences").get()).toEqual({n:43});
    expect(JSON.parse(receipts('jev-wire-response')[0].result_json)).toBe(raw);
  });
  it('does not promote a Jev response after source evidence changes during the request',async()=>{
    const fetch=vi.fn(async()=>{db.prepare('UPDATE catalog_works SET source_description=? WHERE id=?').run(description+' Their destination has changed.',id);return new Response(JSON.stringify(jev()));});
    vi.stubGlobal('fetch',fetch);
    expect(await processAssessment(db,id,seed)).toMatchObject({cached:false,promoted:false,input_tokens:43});
    expect(work().assessment_json).toBeNull();expect(receipts('jev-wire-response')).toHaveLength(1);expect(receipts('jev')).toHaveLength(1);
  });
  it('pins the requested Jev model and input, even when runtime settings change before the response',async()=>{
    const inputHash=assessmentHash(profileInput(work(),seed));
    vi.stubGlobal('fetch',vi.fn(async()=>{vi.stubEnv('JEV_MODEL','next-model');return new Response(JSON.stringify(jev()));}));
    expect(await processAssessment(db,id,seed)).toMatchObject({promoted:false});
    expect(receipts('jev-wire-response')[0].requested_model).toBe('requested-jev');
    expect(JSON.parse(receipts('jev')[0].result_json).inputHash).toBe(inputHash);expect(work().assessment_json).toBeNull();
  });
  it('pins extraction receipt metadata and leaves old settings unpromoted after an in-flight model change',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>{vi.stubEnv('CATALOG_OPENAI_MODEL','next-extractor');return new Response(JSON.stringify(extraction));}));
    expect(await processExtraction(db,id,'extract',{})).toMatchObject({promoted:false});
    expect(receipts('extract-wire-response')[0].requested_model).toBe('requested-extractor');
    expect(receipts('extract')[0].requested_model).toBe('requested-extractor');expect(work().description).toBe('');
  });
  it.each(['extract','assess'])('refuses a paid %s miss inside a caller transaction',async(kind)=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);db.exec('BEGIN');
    await expect(kind==='extract'?processExtraction(db,id,'extract',{}):processAssessment(db,id,seed)).rejects.toThrow('outside a caller transaction');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['extract','assess'])('does not claim a %s response was saved when a caller opens a transaction during HTTP',async(kind)=>{
    const request=vi.fn(async()=>{db.exec('BEGIN');return new Response(JSON.stringify(kind==='extract'?extraction:jev()));});
    vi.stubGlobal('fetch',request);
    await expect(kind==='extract'?processExtraction(db,id,'extract',{}):processAssessment(db,id,seed)).rejects.toThrow(PaidResponseStorageError);
    expect(request).toHaveBeenCalledOnce();
    expect(receipts(kind==='extract'?'extract-wire-response':'jev-wire-response')).toHaveLength(0);
    expect(work().description).toBe('');expect(work().assessment_json).toBeNull();
  });
  it.each(['extract','assess'] as const)('parks a %s receipt-storage failure and stops the paid worker without an automatic repurchase',async(kind)=>{
    const wireKind=kind==='extract'?'extract-wire-response':'jev-wire-response';
    db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON catalog_inferences WHEN NEW.kind='${wireKind}' BEGIN SELECT RAISE(ABORT,'storage unavailable'); END`);
    const request=vi.fn(async()=>new Response(JSON.stringify(kind==='extract'?extraction:jev())));vi.stubGlobal('fetch',request);
    enqueue(db,kind,id,'retained-input',{workId:id});
    const options={enrich:true,limits:{sources:0,audio:0,extract:kind==='extract'?2:0,assess:kind==='assess'?2:0}};
    const hooks={registry:[seed],planAudio:()=>0,planInference:()=>0};
    const report=await runCatalogGrind(db,options,hooks);
    expect(report).toMatchObject({paidStopped:true,review:1,errors:1});
    expect(report.stages[kind]).toMatchObject({attempted:1,stopReason:'storage',remaining:{review:1,retry:0}});
    expect(db.prepare('SELECT status,last_error FROM catalog_jobs').get()).toEqual({status:'review',last_error:'The paid response could not be saved; review database storage before any manual retry.'});
    db.exec('DROP TRIGGER fail_receipt');
    expect(await runCatalogGrind(db,options,hooks)).toMatchObject({completed:0,errors:0});
    expect(request).toHaveBeenCalledOnce();expect(receipts(wireKind)).toHaveLength(0);
  });
  it('reuses a legacy normalized Jev assessment with its existing usage unchanged',async()=>{
    const inputHash=assessmentHash(profileInput(work(),seed));
    const value={inputHash,model:'old-actual',taste:{},genre:{value:'unknown',confidence:0.3}};
    saveInference(db,'work',id,'jev',inputHash,'old-requested','old-actual',RUBRIC_VERSION,value,{input_tokens:90,output_tokens:20});
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    expect(await processAssessment(db,id,seed)).toMatchObject({cached:true,input_tokens:0,output_tokens:0});
    expect(fetch).not.toHaveBeenCalled();expect(receipts('jev-wire-response')).toHaveLength(0);
    expect(JSON.parse(receipts('jev')[0].usage_json)).toEqual({input_tokens:90,output_tokens:20});
  });
});
