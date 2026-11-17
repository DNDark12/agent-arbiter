import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as gate from '../extension/hooks/gate.js';
import {protectedWorld} from './protected-fixture.mjs';
import {world} from './fixtures.mjs';
import {emit,readProject} from '../extension/hooks/events.js';
import {digest} from '../extension/hooks/ledger.js';
async function active(t){
 const w=await protectedWorld(t);await w.command('runtime probe');
 await w.command('mode enforce '+JSON.stringify({finePoints:2,replacementModels:['claude-alternative-full-id'],grantsOnly:true,trustedHost:true,noOutsideWriters:true}));
 const citizenId=await digest('gate-citizen');await emit(w.$,w.ctx,null,'spawn.result','actor',{status:'started',childAgentId:'a',citizen:{id:citizenId}});
 return {...w,citizenId};
}
async function request(w,id='call'){
 const e={tool:'Write',tool_use_id:id,file_path:w.root+'/a.js',agentId:'a'},data={tool:'Write',toolCallId:id,file:{scope:'project',path:'a.js',pathResolution:'parent-realpath'},environment:'local'};
 return {e,data,id:await emit(w.$,w.ctx,'a','tool.request',id,data)};
}
test('gate preserves unconfigured observe and refuses protected execution before OS proof',async t=>{
 assert.equal(typeof gate.enforceTool,'function');const w=await world(t);
 assert.equal(await gate.enforceTool(w.$,await import('../extension/hooks/context.js').then(m=>m.observationContext(w.$)),{tool:'Write'},{},null),null);
 const protectedW=await protectedWorld(t);assert.ok((await gate.enforceTool(protectedW.$,protectedW.ctx,{tool:'Bash',command:'true'},{},null)).deny);
});
test('matching scoped signed grant runs without Arbiter asking again',async t=>{
 assert.equal(typeof gate.enforceTool,'function');const w=await active(t),r=await request(w);
 await w.command('grant '+JSON.stringify({action:'source.write',target:'a.js',environment:'local',agentId:'a'}));
 w.$.ui.ask=async()=>{throw new Error('Unexpected duplicated consent')};
 assert.equal(await gate.enforceTool(w.$,w.ctx,r.e,r.data,r.id),null);
 assert.equal((await readProject(w.$,w.ctx)).events.some(e=>e.kind==='verdict.recorded'),false);
});
test('first known unapproved action fines; repeat in the same turn detains and imprisons',async t=>{
 assert.equal(typeof gate.enforceTool,'function');const w=await active(t);
 let r=await request(w,'first');assert.ok((await gate.enforceTool(w.$,w.ctx,r.e,r.data,r.id)).deny);
 let record=JSON.parse((await w.command('record '+w.citizenId)).text);assert.equal(record.citizen.trustDelta,-2);
 r=await request(w,'second');assert.ok((await gate.enforceTool(w.$,w.ctx,r.e,r.data,r.id)).deny);
 record=JSON.parse((await w.command('record '+w.citizenId)).text);assert.ok(record.citizen.restrictions.includes('detain'));assert.ok(record.citizen.restrictions.includes('imprison'));
});
test('unknown command asks for exact call only; Deny and no answer never sentence',async t=>{
 assert.equal(typeof gate.enforceTool,'function');const w=await active(t),e={tool:'Bash',tool_use_id:'unknown',command:'some-script',agentId:'a'},data={tool:'Bash'};
 for(const answer of ['Deny','',null]){w.$.ui.ask=async()=>answer;assert.ok((await gate.enforceTool(w.$,w.ctx,e,data,null)).deny);}
 w.$.ui.ask=async()=> 'Allow';assert.equal(await gate.enforceTool(w.$,w.ctx,e,data,null),null);
 assert.equal((await readProject(w.$,w.ctx)).events.some(e=>e.kind==='verdict.recorded'),false);
});
test('production integration never guesses a Bash environment from workspace location',async t=>{
 const w=await active(t);let questions=0;w.$.ui.ask=async()=>{questions++;return 'Deny'};
 const e={tool:'Bash',tool_use_id:'git-push',command:'git push origin main',agentId:'a'};
 assert.ok((await gate.enforceTool(w.$,w.ctx,e,{tool:'Bash'},null)).deny);
 assert.equal(questions,1);assert.equal((await readProject(w.$,w.ctx)).events.some(e=>e.kind==='verdict.recorded'),false);
});
test('probation narrows rights by asking even when a reusable grant matches, without punishing Deny',async t=>{
 const w=await active(t),r=await request(w,'probation');
 const {compileRules}=await import('../extension/hooks/statutes.js');const law=(await compileRules()).rules.find(rule=>rule.action==='source.write');
 const result=JSON.parse((await w.command('verdict '+JSON.stringify({citizenId:w.citizenId,actor:{sessionId:w.ctx.sessionId,agentId:'a'},law:{id:law.id,version:law.version},evidenceIds:[r.id],outcome:'guilty',reason:'Human probation fixture',effects:{trustDelta:0,restrictions:['probation'],lessonIds:[]}}))).text);
 await w.command('grant '+JSON.stringify({action:'source.write',target:'a.js',environment:'local',agentId:'a'}));
 let asked=0;w.$.ui.ask=async()=>{asked++;return 'Deny'};
 assert.ok((await gate.enforceTool(w.$,w.ctx,r.e,r.data,r.id)).deny);assert.equal(asked,1);
 assert.equal((await readProject(w.$,w.ctx)).events.filter(e=>e.kind==='verdict.recorded').length,1);
 await w.command('pardon '+result.caseId+' cleared');assert.equal(await gate.enforceTool(w.$,w.ctx,r.e,r.data,r.id),null);
});
