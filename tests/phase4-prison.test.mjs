import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as prison from '../extension/hooks/prison.js';
import {reduceCases} from '../extension/hooks/cases.js';

const id=n=>n.toString(16).padStart(64,'0');
const ctx={projectId:id(1),sessionId:'current'};
const source={kind:'command',origin:'composer',id:'human'};
const event=(n,kind,data,agentId=null,sessionId='current')=>({schemaVersion:1,id:id(n),
 projectId:ctx.projectId,sessionId,agentId,kind,occurredAt:n,data});
const binding=(n=3,citizenId=id(2),sessionId='current',childAgentId='a',parent=null)=>
 event(n,'spawn.result',{status:'started',childAgentId,citizen:{id:citizenId}},parent,sessionId);
const request=(n,tool,agentId='a',sessionId='current')=>event(n,'tool.request',
 {tool,toolCallId:'call-'+n,file:{path:'src/a.js'},environment:'local'},agentId,sessionId);
function sentenceFixture(restrictions=['imprison']) {
 const law={id:'approval',version:id(4),action:'source.write',target:'src/a.js',environment:'local',
  effect:'approval',group:'ordinary',source:{kind:'project',id:'rules'},priority:30};
 const events=[binding(),event(5,'laws.approved',{source,rules:[law]}),request(6,'Write')];
 const judgment={caseId:id(10),citizenId:id(2),actor:{sessionId:'current',agentId:'a'},
  law:{id:law.id,version:law.version},evidenceIds:[id(6)],dependencyIds:[id(3),id(5)],
  outcome:'guilty',reason:'Reviewed the real direct write.',anchorAt:6,
  effects:{trustDelta:0,restrictions,lessonIds:[]}};
 events.push(event(11,'verdict.recorded',{source,judgment}));
 assert.equal(reduceCases(events,ctx.projectId).cases[0].status,'active');
 return events;
}
const agents=[{id:'a',status:'killed'},{id:'b',status:'completed',parentId:'a'},
 {id:'c',status:'failed',parentId:'b'}];
const unknown={known:false,citizenId:null,restrictions:[],caseIds:[]};

test('sentence uses a unique current session binding and active projected cases',()=>{
 const events=sentenceFixture(['probation','imprison']);
 assert.deepEqual(prison.actorSentence(events,ctx,'a'),{known:true,citizenId:id(2),
  restrictions:['imprison','probation'],caseIds:[id(10)],held:true});
 assert.deepEqual(prison.actorSentence(events,{...ctx,sessionId:'later'},'a'),unknown);
 assert.deepEqual(prison.actorSentence(events,{...ctx,projectId:id(99)},'a'),unknown);
 assert.deepEqual(prison.actorSentence(events,ctx,null),unknown);
});

test('unknown and ambiguous bindings never inherit a historical citizen sentence',()=>{
 const events=sentenceFixture();
 assert.deepEqual(prison.actorSentence([binding(12,null)],ctx,'a'),unknown);
 assert.deepEqual(prison.actorSentence([...events,binding(12,null)],ctx,'a'),{...unknown,held:true});
 assert.deepEqual(prison.actorSentence([...events,binding(12,id(22))],ctx,'a'),{...unknown,held:true});
 const old=events.map(e=>({...e,sessionId:'old',data:e.kind==='verdict.recorded'?
  {...e.data,judgment:{...e.data.judgment,actor:{sessionId:'old',agentId:'a'}}}:e.data}));
 assert.deepEqual(prison.actorSentence([...old,binding(12,null)],ctx,'a'),unknown);
});

test('pardon permanently removes detention even if a later appeal upholds the verdict',()=>{
 const events=sentenceFixture();
 events.push(event(12,'case.pardoned',{caseId:id(10),reason:'Human pardon',source}),
  event(13,'appeal.decided',{caseId:id(10),decision:'uphold',reason:'Reviewed',source}));
 assert.deepEqual(prison.actorSentence(events,ctx,'a'),{known:true,citizenId:id(2),
  restrictions:[],caseIds:[],held:false});
});

test('stopped tree requires target and every recursively listed descendant terminal',()=>{
 assert.equal(prison.stoppedTree(agents,'a').stopped,true);
 for(const rows of [undefined,[],[{id:'other',status:'killed'}],agents.map(a=>a.id==='c'?{...a,status:'idle'}:a),
  [...agents,{id:'a',status:'running'}],[{id:'a',status:'killed',parentId:'b'},{id:'b',status:'killed',parentId:'a'}]]) {
  assert.equal(prison.stoppedTree(rows,'a').stopped,false);
 }
});

test('clean file only terminal actors can hand over and unrelated session history stays separate',()=>{
 const events=[binding(),request(6,'Write'),request(7,'Read'),request(8,'Bash','a','old')];
 assert.equal(prison.handoverProof(events,ctx,'a',agents).safe,true);
 assert.equal(prison.handoverProof(events,ctx,'a',[]).safe,false);
 assert.equal(prison.handoverProof(events,ctx,'a',agents.map(a=>a.id==='c'?{...a,status:'running'}:a)).safe,false);
});

test('any shell, MCP or unknown tool history prevents same writer handover despite stopped status',()=>{
 for(const tool of ['Bash','mcp__shell__exec','WebFetch','UnknownTool',null]) {
  assert.equal(prison.handoverProof([binding(),request(6,tool)],ctx,'a',agents).safe,false,tool);
 }
});

test('spawned descendants must be present, stopped and free of external capability history',()=>{
 const events=[binding(),binding(12,id(20),'current','b','a'),binding(13,id(21),'current','c','b'),request(14,'Write','b')];
 assert.equal(prison.handoverProof(events,ctx,'a',agents).safe,true);
 assert.equal(prison.handoverProof(events,ctx,'a',agents.filter(a=>a.id!=='c')).safe,false);
 assert.equal(prison.handoverProof([...events,request(15,'Bash','c')],ctx,'a',agents).safe,false);
 // A missing Agent result cannot establish whether a child continues writing.
 assert.equal(prison.handoverProof([...events,request(16,'Agent')],ctx,'a',agents).safe,false);
 assert.equal(prison.handoverProof([...events,event(16,'spawn.request',{spawnAttemptId:'pending'},'b')],ctx,'a',agents).safe,false);
});

test('linked native Agent requests with completed spawn results require the child stop proof',()=>{
 const call=request(6,'Agent');
 const events=[binding(),call,event(7,'spawn.request',{spawnAttemptId:'spawn',toolCallId:'call-6'},'a'),
  {...binding(8,id(20),'current','b','a'),data:{...binding().data,spawnAttemptId:'spawn',childAgentId:'b'}}];
 assert.equal(prison.handoverProof(events,ctx,'a',agents).safe,true);
 assert.equal(prison.handoverProof(events,ctx,'a',agents.filter(a=>a.id!=='b')).safe,false);
});

test('Arbiter stop uses the actual TaskStop call then native agent list shape',async()=>{
 const calls=[];
 const $={tool:{call:async input=>{calls.push(input);return {text:'was stopped by Claude'};}},
  agent:{list:async()=>{calls.push('list');return agents;}}};
 assert.deepEqual(await prison.stopForHandover($,ctx,'a',[binding(),request(6,'Write')]),
  {safe:true,reason:'stopped-file-only-tree',stopReported:true});
 assert.deepEqual(calls,[{tool:'TaskStop',task_id:'a'},'list']);
 assert.equal((await prison.stopForHandover($,ctx,'a',[binding(),request(6,'Bash')])).safe,false);
});

test('stop errors, refusals and list errors retain unsafe handover',async()=>{
 for(const stop of [async()=>{throw Error('stop failed')},async()=>({deny:'no'}),async()=>({isError:true}),async()=>null]) {
  let listed=false;
  const $={tool:{call:stop},agent:{list:async()=>{listed=true;return agents;}}};
  const proof=await prison.stopForHandover($,ctx,'a',[binding()]);
  assert.equal(proof.safe,false);assert.equal(proof.stopReported,false);assert.equal(listed,true);
 }
 const $={tool:{call:async()=>({text:'stopped'})},agent:{list:async()=>{throw Error('unavailable')}}};
 assert.deepEqual(await prison.stopForHandover($,ctx,'a',[binding()]),
  {safe:false,reason:'agent-list-unavailable',stopReported:true});
});

const identity={name:'worker',source:'projectSettings',provider:null,definitionHash:id(30),
 engineVersion:'2.1.325',resolvedModel:'claude-sonnet-4-6'};
test('replacement chooses exact configured model IDs and excludes same definition banned models',()=>{
 const banned=[{...identity,resolvedModel:'claude-opus-4-6'}];
 const models=['sonnet','opus','haiku','inherit','default','claude-sonnet-4-6','claude-opus-4-6','claude-haiku-4-5-20251001'];
 assert.equal(prison.replacementModel(identity,banned,models),'claude-haiku-4-5-20251001');
 assert.equal(prison.replacementModel(identity,[{...banned[0],definitionHash:id(31)}],models),'claude-opus-4-6');
 assert.equal(prison.replacementModel(identity,[{...banned[0],provider:{plugin:'other',tier:'local'}}],models),'claude-opus-4-6');
 assert.equal(prison.replacementModel(identity,[],['claude-sonnet-4-6']),null);
 assert.equal(prison.replacementModel(identity,[],['provider/custom-model']),'provider/custom-model');
});

test('replacement fails closed for unknown identity or actual model and builtin engine matching is exact',()=>{
 for(const value of [null,{}, {...identity,resolvedModel:null},{...identity,resolvedModel:'sonnet'},
  {...identity,resolvedModel:'unknown'},{...identity,resolvedModel:'default'},
  {...identity,definitionHash:null},{...identity,source:'unknown'}]) {
  assert.equal(prison.replacementModel(value,[],['claude-opus-4-6']),null);
 }
 assert.equal(prison.replacementModel(identity,[],undefined),null);
 assert.equal(prison.replacementModel(identity,[],['opus','inherit','default']),null);
 assert.equal(prison.replacementModel(identity,[],['latest','auto','unknown']),null);
 const builtin={...identity,source:'built-in',definitionHash:null};
 assert.equal(prison.replacementModel(builtin,[{...builtin,resolvedModel:'claude-opus-4-6'}],['claude-opus-4-6']),null);
 assert.equal(prison.replacementModel(builtin,[{...builtin,engineVersion:'older',resolvedModel:'claude-opus-4-6'}],['claude-opus-4-6']),'claude-opus-4-6');
});

test('an incomplete spawn outcome and an empty actor history never prove handover safe',()=>{
 assert.equal(prison.handoverProof([],ctx,'a',agents).safe,false);
 const events=[binding(),event(7,'spawn.request',{spawnAttemptId:'spawn'},'a'),
  event(8,'spawn.result',{spawnAttemptId:'spawn',childAgentId:null},'a')];
 assert.deepEqual(prison.handoverProof(events,ctx,'a',agents),{safe:false,reason:'spawn-outcome-unavailable'});
});
