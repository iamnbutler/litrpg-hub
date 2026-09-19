import { parseArgs } from 'node:util';
import { getDb,closeDb } from '../db.js';
import { runMigrations } from '../migrate.js';
import { claim,fail,finish } from './queue.js';
import { seeds,seedCatalog,processSource } from './pipeline.js';
import { planInference,processAssessment,processExtraction } from './inference.js';
import { PaidResponseStorageError,ReviewError,type SourcePayload,type AudioPayload,type IdentifiedAudioPayload } from './types.js';
import { importCuratedEvidence } from './curation.js';
import { planAudio, processAudio } from './audio.js';
import { processIdentifiedAudio } from './identified-audio.js';
import { auditCatalog } from './audit.js';

try {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{stage:{type:'string',default:'sources'},limit:{type:'string',default:'25'},series:{type:'string'},review:{type:'boolean',default:false},help:{type:'boolean'}}});
  const command=positionals[0]??'status';
  if(values.help){console.log(`npm run catalog -- seed | curate | plan | plan-audio | status | audit
npm run catalog -- run --stage sources|audio|enrich|assess --limit 25 [--series SERIES_ID]
npm run catalog -- refresh [--series SERIES_ID]
npm run catalog -- retry --stage sources|audio|enrich|assess [--series SERIES_ID] [--review]

Saved source pages and model responses are reused. run resumes pending jobs.
curate imports attributed research notes. plan-audio verifies already observed retailer identifiers.
refresh schedules only due publisher and exact-product jobs.
retry resets failed/retry jobs in one stage; --review explicitly includes review jobs.
--series limits planning, execution, curation, refresh, and retry to a selected series.
Audiobook dates remain separate from print and ebook publication dates.`);}
  else {
    runMigrations();const db=getDb(),selected=values.series?seeds.filter(s=>s.id===values.series):seeds;
    if(!selected.length)throw new Error('Unknown selected series.');
    const kinds=values.stage==='sources'?['source']:values.stage==='audio'?['audio-edition','identified-audio']:values.stage==='enrich'?['describe-series','extract']:values.stage==='assess'?['assess']:[];
    if(!kinds.length)throw new Error('--stage must be sources, audio, enrich, or assess.');
    if(command==='seed')console.log(`Added ${seedCatalog(db,selected,{includeIndexes:!values.series})} source jobs.`);
    else if(command==='curate')console.log(`Imported ${importCuratedEvidence(db,selected)} attributed research records.`);
    else if(command==='plan')console.log(`Added ${planInference(db,selected)} enrichment jobs.`);
    else if(command==='plan-audio')console.log(`Added ${planAudio(db,selected)} exact audiobook verification jobs.`);
    else if(command==='audit'){
      const report=auditCatalog(db);
      console.log(JSON.stringify(values.series?report.series.find(s=>s.id===values.series):report,null,2));
    }
    else if(command==='refresh'){
      const {runCatalogGrind}=await import('./grind.js');
      const report=await runCatalogGrind(db,{seriesId:values.series,refresh:true,limits:{sources:0,audio:0,extract:0,assess:0}});
      console.log(`Scheduled ${report.planned.refresh} due source jobs; earlier attempts remain intact.`);
    }else if(command==='retry'){
      let count=0;const now=new Date().toISOString();
      const jobs=db.prepare(`SELECT id,kind,entity_id,payload_json,status FROM catalog_jobs WHERE status IN ('failed','retry'${values.review?",'review'":''})`).all() as {id:string;kind:string;entity_id:string;payload_json:string;status:string}[];
      for(const job of jobs){const payload=JSON.parse(job.payload_json);if(!kinds.includes(job.kind))continue;
        if(values.series&&payload.seriesId!==values.series&&job.entity_id!==values.series&&!(db.prepare('SELECT 1 FROM catalog_works WHERE id=? AND series_id=?').get(job.entity_id,values.series)))continue;
        count+=db.prepare("UPDATE catalog_jobs SET status='pending',attempts=0,available_at=?,last_error=NULL,updated_at=? WHERE id=?").run(now,now,job.id).changes;
      }console.log(`Scheduled ${count} retry jobs.`);
    }else if(command==='run'){
      const limit=Number(values.limit);if(!Number.isInteger(limit)||limit<1||limit>300)throw new Error('--limit must be between 1 and 300.');
      let stopped=false;process.on('SIGINT',()=>{stopped=true;console.log('Stopping after the active job; remaining jobs are saved.');});
      const usage={input_tokens:0,output_tokens:0};let completed=0,errors=0;
      for(let i=0;i<limit&&!stopped;i++){
        const job=claim(db,kinds,new Date(),values.series);if(!job)break;
        const payload=JSON.parse(job.payload_json);
        try {
          const workSeries=(db.prepare('SELECT series_id FROM catalog_works WHERE id=?').get(job.entity_id) as {series_id:string}|undefined)?.series_id;
          const seed=seeds.find(s=>s.id===workSeries);
          if(job.kind==='assess'&&!seed)throw new ReviewError('Assessment job has no selected canonical work.');
          const result=job.kind==='source'?await processSource(db,payload as SourcePayload):job.kind==='identified-audio'?await processIdentifiedAudio(db,payload as IdentifiedAudioPayload,selected):job.kind==='audio-edition'?await processAudio(db,payload as AudioPayload,seeds):job.kind==='assess'&&seed?await processAssessment(db,job.entity_id,seed):await processExtraction(db,job.entity_id,job.kind as 'extract'|'describe-series',payload);
          finish(db,job,result);completed++;
          const tokens=result as {input_tokens?:number;output_tokens?:number};usage.input_tokens+=tokens.input_tokens??0;usage.output_tokens+=tokens.output_tokens??0;
          console.log(`${job.kind} ${job.entity_id}: ${JSON.stringify(result)}`);
        }catch(error){const message=error instanceof Error?error.message:'Catalog job failed';fail(db,job,message,error instanceof ReviewError);errors++;console.error(`${job.kind} ${job.entity_id}: ${message}`);if(error instanceof PaidResponseStorageError||/HTTP (401|403|429)/.test(message)&&job.kind!=='source')break;}
      }console.log(JSON.stringify({completed,errors,tokens:usage}));
    }else if(command==='status'){
      console.log(JSON.stringify({jobs:db.prepare('SELECT kind,status,COUNT(*) AS count FROM catalog_jobs GROUP BY kind,status').all(),series:db.prepare(`SELECT s.title,COUNT(w.id) AS works,SUM(w.description!='') AS described,SUM(w.assessment_json IS NOT NULL) AS assessed FROM catalog_series s LEFT JOIN catalog_works w ON w.series_id=s.id GROUP BY s.id ORDER BY s.priority DESC`).all(),candidates:db.prepare('SELECT COUNT(*) AS count FROM catalog_candidates').get(),sources:db.prepare('SELECT COUNT(*) AS count FROM catalog_documents').get(),review:db.prepare("SELECT entity_id,last_error FROM catalog_jobs WHERE status IN ('review','failed')").all()},null,2));
    }else throw new Error('Unknown catalog command. Use --help.');
  }
}catch(error){console.error(error instanceof Error?error.message:'Catalog command failed.');process.exitCode=1;}finally{closeDb();}
