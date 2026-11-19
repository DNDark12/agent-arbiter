import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {world} from './fixtures.mjs';
import {emit,readProject} from '../plugins/agent-arbiter/hooks/events.js';
import {digest} from '../plugins/agent-arbiter/hooks/ledger.js';
import {observationContext} from '../plugins/agent-arbiter/hooks/context.js';
import {caseId,reduceCases} from '../plugins/agent-arbiter/hooks/cases.js';
import {compileRules} from '../plugins/agent-arbiter/hooks/statutes.js';
async function fixture(t){
 const w=await world(t),ctx=await observationContext(w.$),citizenId=await digest('review-citizen');
 await emit(w.$,ctx,null,'spawn.result','spawn-review',{status:'started',childAgentId:'a',citizen:{id:citizenId}});
 const request=await emit(w.$,ctx,'a','tool.request','write-review',{toolCallId:'write-review',tool:'Write',environment:'local',file:{path:'a.js',scope:'project'}});
 const result=await emit(w.$,ctx,'a','tool.result','write-review',{toolCallId:'write-review',tool:'Write',status:'completed',file:{path:'a.js',scope:'project'}});
 const law=(await compileRules()).rules.find(r=>r.action==='source.write');
 const input={citizenId,actor:{sessionId:'s',agentId:'a'},law:{id:law.id,version:law.version},evidenceIds:[request,result],outcome:'guilty',reason:'Reviewed actual Write',effects:{trustDelta:-5,restrictions:['imprison'],lessonIds:[]}};
 return {...w,ctx,input};
}
test('a changed verdict proposal cannot erase the first accepted sentence',async t=>{
 const {command,input,$,ctx}=await fixture(t);
 const first=JSON.parse((await command('verdict '+JSON.stringify(input))).text);
 const next=JSON.parse((await command('verdict '+JSON.stringify({...input,reason:'corrected typo'}))).text);
 assert.equal(next.recording,'rejected');
 await command('appeal '+first.caseId+' {"decision":"uphold","reason":"keep original"}');
 const record=JSON.parse((await command('record '+input.citizenId)).text);
 assert.equal(record.cases[0].status,'active');assert.equal(record.citizen.trustDelta,-5);
 assert.equal((await readProject($,ctx)).events.filter(e=>e.kind==='case.conflicted').length,0);
});
test('source change cannot downgrade an always-deny law to approval',async t=>{
 const {command,root,$,ctx}=await fixture(t);
 await fs.writeFile(root+'/CLAUDE.md','Never push main to production');
 await command('laws approve '+JSON.stringify({path:'CLAUDE.md',rules:[{action:'git.push',target:'main',environment:'production',effect:'deny',group:'always-deny'}]}));
 const request='check '+JSON.stringify({action:'git.push',target:'main',environment:'production',requestedApproval:true});
 assert.equal(JSON.parse((await command(request)).text).decision.outcome,'deny');
 await fs.appendFile(root+'/CLAUDE.md',' ');
 const after=JSON.parse((await command(request)).text).decision;
 assert.ok(['deny','unknown'].includes(after.outcome));assert.notEqual(after.reason,'approval-requested');
 assert.equal((await readProject($,ctx)).events.filter(e=>e.kind==='laws.withdrawn').length,0);
});
test('a law approved after action start cannot be used to convict that action',async t=>{
 const {root,command,input}=await fixture(t);
 await fs.writeFile(root+'/LAWS.md','New rule');
 const approved=JSON.parse((await command('laws approve '+JSON.stringify({path:'LAWS.md',rules:[{action:'source.write',target:'a.js',environment:'local',effect:'deny',group:'always-deny'}]}))).text);
 const result=await command('verdict '+JSON.stringify({...input,law:{id:'project:LAWS.md:0',version:approved.version}}));
 assert.match(result.text,/rejected/i);
});

test('a law for another action cannot convict a Write incident',async t=>{
 const {command,input}=await fixture(t);
 const law=(await compileRules()).rules.find(r=>r.action==='git.push');
 assert.match((await command('verdict '+JSON.stringify({...input,law:{id:law.id,version:law.version}}))).text,/rejected/i);
});

test('custom verdict requires a prior approval and matching target and environment',async t=>{
 const {command,root,$,ctx,input}=await fixture(t);
 await fs.writeFile(root+'/SCOPE.md','Scoped rule');
 const approved=JSON.parse((await command('laws approve '+JSON.stringify({path:'SCOPE.md',rules:[{action:'source.write',target:'a.js',environment:'local',effect:'deny',group:'always-deny'}]}))).text);
 const law={id:'project:SCOPE.md:0',version:approved.version};
 for(const [name,path,environment,accepted] of [['target','b.js','local',false],['environment','a.js','production',false],['matching','a.js','local',true]]){
  const metadata={toolCallId:name,tool:'Write',environment,file:{path,scope:'project'}};
  const request=await emit($,ctx,'a','tool.request',name,metadata);
  const result=await command('verdict '+JSON.stringify({...input,law,evidenceIds:[request]}));
  if(accepted)assert.equal(JSON.parse(result.text).evidenceId,JSON.parse(result.text).caseId);
  else assert.match(result.text,/rejected/i);
 }
});
test('a frozen Phase 2 builtin version still resolves when recording a historical case',async t=>{
 const {command,input}=await fixture(t);
 const version='c888dab741ee5f6551e14f0b2fdcf4e9a90828b0a4843fdd1fa350b4dc8db1d5';
 const result=JSON.parse((await command('verdict '+JSON.stringify({...input,law:{id:'builtin.source.write',version}}))).text);
 assert.equal(result.caseId,result.evidenceId);assert.notEqual(result.recording,'rejected');
});
test('two concurrent different proposals keep one accepted sentence without a conflict marker',async t=>{
 const {command,input,$,ctx}=await fixture(t);
 const attempts=await Promise.all(['first proposal','second proposal'].map(reason=>command('verdict '+JSON.stringify({...input,reason}))));
 const results=attempts.map(result=>JSON.parse(result.text));
 assert.equal(results.filter(result=>result.recording==='rejected').length,1);
 assert.equal((await readProject($,ctx)).events.filter(event=>event.kind==='case.conflicted').length,0);
 const record=JSON.parse((await command('record '+input.citizenId)).text);
 assert.equal(record.citizen.trustDelta,-5);assert.equal(record.cases[0].status,'active');
});

test('an observed source change stays on hold after module restart until human reapproval',async t=>{
 const {command,root,$}=await fixture(t);
 const path=root+'/PERSIST.md',original='Protected source';
 const payload={path:'PERSIST.md',rules:[{action:'git.push',target:'main',environment:'production',effect:'approval',group:'ordinary'}]};
 await fs.writeFile(path,original);await command('laws approve '+JSON.stringify(payload));
 await fs.appendFile(path,' ');
 await command('laws');
 await fs.writeFile(path,original);
 const {handleCourt}=await import('../plugins/agent-arbiter/hooks/controls.js?restart='+crypto.randomUUID());
 const args='check '+JSON.stringify({action:'git.push',target:'main',environment:'production',requestedApproval:true});
 const result=JSON.parse((await handleCourt($,{args,origin:{kind:'composer'}})).text);
 assert.equal(result.decision.reason,'law-source-pending-review');
 await command('laws approve '+JSON.stringify(payload));
 const restored=JSON.parse((await handleCourt($,{args,origin:{kind:'composer'}})).text);
 assert.equal(restored.decision.reason,'approval-requested');
});

test('replay suspends historical guilty records whose law was approved after the request',async t=>{
 const {command,root,$,ctx,input}=await fixture(t);
 await fs.writeFile(root+'/LATE.md','Late rule');
 const approved=JSON.parse((await command('laws approve '+JSON.stringify({path:'LATE.md',rules:[{action:'source.write',target:'a.js',environment:'local',effect:'deny',group:'always-deny'}]}))).text);
 const events=(await readProject($,ctx)).events,approval=events.find(e=>e.kind==='laws.approved'),binding=events.find(e=>e.kind==='spawn.result');
 const law={id:'project:LATE.md:0',version:approved.version},id=await caseId(law.id,law.version,input.evidenceIds);
 const judgment={...input,law,caseId:id,anchorAt:Date.now(),dependencyIds:[approval.id,binding.id]};
 const event={schemaVersion:1,id,projectId:ctx.projectId,sessionId:ctx.sessionId,agentId:null,kind:'verdict.recorded',occurredAt:Date.now(),data:{judgment,source:{kind:'command',origin:'composer',id:'legacy-human'}}};
 const record=reduceCases([...events,event],ctx.projectId).cases[0];
 assert.equal(record.status,'disputed');assert.equal(record.effects.trustDelta,0);
 const prior=structuredClone(events);prior.find(e=>e.id===approval.id).occurredAt=0;
 assert.equal(reduceCases([...prior,event],ctx.projectId).cases[0].status,'active');
 for(const wrong of [{action:'git.push'},{target:'b.js'},{environment:'production'}]){
  const mismatched=structuredClone(prior);
  Object.assign(mismatched.find(e=>e.id===approval.id).data.rules[0],wrong);
  const projected=reduceCases([...mismatched,event],ctx.projectId).cases[0];
  assert.equal(projected.status,'disputed');assert.equal(projected.effects.trustDelta,0);
 }
});
