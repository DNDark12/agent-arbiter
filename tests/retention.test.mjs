import test from 'node:test';
import assert from 'node:assert/strict';
import {world} from './fixtures.mjs';
import {observationContext} from '../extension/hooks/context.js';
import {readProject} from '../extension/hooks/events.js';
import {publish,digest} from '../extension/hooks/ledger.js';
import {prunable,pruneProject,maintain,RETENTION_DAYS} from '../extension/hooks/retention.js';
import * as judge from '../extension/hooks/judge.js';

const DAY=24*60*60*1000;
async function fresh(t){
 const w=await world(t);w.$.plugin.root=w.root+'/extension';w.$.session.id=async()=>w.root;
 return {w,ctx:await observationContext(w.$)};
}
// Writes one event dated in the past, the way the collector files it.
async function put(w,ctx,kind,ageDays,data={},key=kind+ageDays+JSON.stringify(data)){
 const occurredAt=Date.now()-ageDays*DAY,id=await digest(key);
 const event={schemaVersion:1,id,projectId:ctx.projectId,sessionId:'s',agentId:null,kind,occurredAt,data};
 assert.equal(await publish(w.$,`${ctx.dataRoot}/events/${ctx.projectId}/${new Date(occurredAt).toISOString().slice(0,7)}`,event),'published');
 return id;
}
const kinds=async(w,ctx)=>(await readProject(w.$,ctx)).events.map(event=>event.kind).sort();

test('only routine records older than the retention window are removed; decisions and cited evidence stay',async t=>{
 const {w,ctx}=await fresh(t);
 const cited=await put(w,ctx,'tool.request',90,{tool:'Write'},'cited');
 await put(w,ctx,'tool.request',90,{tool:'Read'});await put(w,ctx,'tool.result',90);await put(w,ctx,'turn.complete',45);
 await put(w,ctx,'rule.decision',31,{outcome:'approved'});await put(w,ctx,'session.start',40);
 await put(w,ctx,'tool.request',RETENTION_DAYS-1,{tool:'Bash'});
 await put(w,ctx,'discipline.violation',90,{sanction:'fine',ruleIds:['x'],requestId:cited});
 await put(w,ctx,'spawn.result',90,{status:'started',childAgentId:'a'});
 await put(w,ctx,'judge.review',90,{scores:{},findings:[]});await put(w,ctx,'judge.decision',90,{});
 await put(w,ctx,'some.future.kind',400);
 const before=(await readProject(w.$,ctx)).events;
 assert.equal(prunable(before).length,5);
 assert.equal(prunable(before,Date.now(),1000).length,0);
 const result=await pruneProject(w.$,ctx);
 assert.deepEqual([result.removed,result.kept],[5,7]);
 assert.deepEqual(await kinds(w,ctx),['discipline.violation','judge.decision','judge.review','some.future.kind','spawn.result','tool.request','tool.request']);
 assert.ok((await readProject(w.$,ctx)).events.some(event=>event.id===cited),'evidence a violation cites is kept');
 assert.deepEqual((await pruneProject(w.$,ctx)).removed,0,'nothing left to remove');
});

test('upkeep runs at most once a day, never touches a hardened ledger, and cleanup reports what it removed',async t=>{
 const {w,ctx}=await fresh(t);
 await put(w,ctx,'tool.request',60);await put(w,ctx,'tool.result',60);
 assert.equal((await pruneProject(w.$,{...ctx,authConfigured:true})).removed,0);
 assert.equal((await readProject(w.$,ctx)).events.length,2);
 assert.equal((await maintain(w.$,ctx)).removed,2);
 await put(w,ctx,'tool.request',61,{},'later');
 assert.equal(await maintain(w.$,ctx),null,'already ran today');
 assert.equal((await maintain(w.$,ctx,Date.now()+DAY+1)).removed,1);
 await put(w,ctx,'turn.complete',70);
 const {register}=await import('../extension/hooks/register.js');
 const hooks={};register((name,matcher,hook)=>{hooks[name]=hook ?? matcher;return {catch(){}}});
 w.$.command={register:async()=>{}};w.$.ui.log=async()=>{};w.$.ui.invalidate=()=>{};
 const text=(await hooks['command.run'](w.$,{args:'cleanup',origin:{kind:'composer'}})).text;
 assert.match(text,/Routine records older than 30 days removed: 1/);
 assert.equal(await maintain({...w.$,fs:{...w.$.fs,exists:async()=>{throw Error('disk')}}},ctx),null,'a failing disk never throws');
});

test('an undecided finding or exemplar candidate stops waiting after two weeks',async()=>{
 const projectId='p'.repeat(64),now=1_000_000_000_000;
 const review=(id,ageDays,data)=>({id:id.repeat(64),projectId,sessionId:'s',agentId:'a',kind:'judge.review',occurredAt:now-ageDays*DAY,
  data:{scores:{completeness:5,honesty:5},findings:[],exemplar:{worthy:false,why:''},...data}});
 const finding={severity:'medium',dimension:'scope',claim:'c',evidence:'e'};
 const events=[review('f',1,{findings:[{...finding,severity:'low'}]}),review('a',1,{findings:[finding]}),review('b',judge.PENDING_DAYS+1,{findings:[finding]}),
  review('c',1,{exemplar:{worthy:true,why:'good'}}),review('d',judge.PENDING_DAYS+1,{exemplar:{worthy:true,why:'good'}}),
  {id:'e'.repeat(64),projectId,sessionId:'s',agentId:null,kind:'judge.decision',occurredAt:now,data:{reviewId:'b'.repeat(64),finding:0,decision:'confirmed',source:{origin:'sdk'}}}];
 const reviews=judge.reduceReviews(events,projectId,now);
 assert.deepEqual(reviews.map(r=>[r.findings[0]?.state ?? null,r.exemplar.state]).sort(),[['expired','none'],['noted','none'],['open','none'],[null,'candidate'],[null,'expired']].sort());
});
