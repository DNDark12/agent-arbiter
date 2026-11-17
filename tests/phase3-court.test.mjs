import {test} from 'node:test';
import assert from 'node:assert/strict';
import {world} from './fixtures.mjs';
import {digest} from '../extension/hooks/ledger.js';
import {emit,readProject} from '../extension/hooks/events.js';
import {observationContext} from '../extension/hooks/context.js';
import {compileRules} from '../extension/hooks/statutes.js';
async function fixture(t){
 const w=await world(t),ctx=await observationContext(w.$),citizenId=await digest('citizen');
 await emit(w.$,ctx,null,'spawn.result','spawn-a',{status:'started',childAgentId:'a',citizen:{id:citizenId}});
 const request=await emit(w.$,ctx,'a','tool.request','write-a',{toolCallId:'write-a',tool:'Write'});
 const result=await emit(w.$,ctx,'a','tool.result','write-a',{toolCallId:'write-a',tool:'Write',status:'completed'});
 const law=(await compileRules()).rules.find(r=>r.action==='source.write');
 const input={citizenId,actor:{sessionId:'s',agentId:'a'},law:{id:law.id,version:law.version},evidenceIds:[request,result],outcome:'guilty',reason:'Human reviewed actual tool evidence',effects:{trustDelta:-5,restrictions:['imprison'],lessonIds:[await digest('lesson')]}};
 return {...w,ctx,input};
}
test('manual evidence-backed verdict is durable/idempotent and pardon removes all case effects',async t=>{
 const {command,input}=await fixture(t);
 const made=JSON.parse((await command('verdict '+JSON.stringify(input))).text);
 assert.match(made.caseId,/^[a-f0-9]{64}$/);
 const again=JSON.parse((await command('verdict '+JSON.stringify(input))).text);
 assert.equal(again.caseId,made.caseId);assert.equal(again.duplicate,true);
 const before=JSON.parse((await command('record '+input.citizenId)).text);
 assert.equal(before.citizen.trustDelta,-5);assert.deepEqual(before.citizen.restrictions,['imprison']);
 await command('pardon '+made.caseId+' human clemency');
 const after=JSON.parse((await command('record '+input.citizenId)).text);
 assert.equal(after.citizen.trustDelta,0);assert.deepEqual(after.citizen.restrictions,[]);assert.deepEqual(after.citizen.lessonIds,[]);
 assert.equal(after.cases[0].status,'pardoned');
});
test('appeal request does not clear sentence; successful human appeal does',async t=>{
 const {command,input}=await fixture(t);
 const made=JSON.parse((await command('verdict '+JSON.stringify(input))).text);
 await command('appeal '+made.caseId,'plugin');
 assert.equal(JSON.parse((await command('record '+input.citizenId)).text).citizen.trustDelta,-5);
 assert.match((await command('appeal '+made.caseId+' {"decision":"overturn","reason":"reviewed"}','sdk')).text,/human/i);
 await command('appeal '+made.caseId+' {"decision":"overturn","reason":"reviewed"}');
 const record=JSON.parse((await command('record '+input.citizenId)).text);
 assert.equal(record.citizen.trustDelta,0);assert.equal(record.cases[0].currentOutcome,'not-guilty');
});
test('SDK cannot sentence/pardon; preview IDs and missing actor evidence cannot convict',async t=>{
 const {command,input}=await fixture(t);
 assert.match((await command('verdict '+JSON.stringify(input),'sdk')).text,/human/i);
 const preview=JSON.parse((await command('check {"action":"source.write","target":"a.js","environment":"local","requestedApproval":false}')).text);
 assert.match((await command('verdict '+JSON.stringify({...input,evidenceIds:[preview.evidenceId]}))).text,/evidence/i);
 assert.match((await command('verdict '+JSON.stringify({...input,actor:{sessionId:'s',agentId:'someone-else'}}))).text,/evidence|citizen/i);
 assert.match((await command('pardon '+'a'.repeat(64),'plugin')).text,/human/i);
 assert.deepEqual(JSON.parse((await command('docket')).text).cases,[]);
});
test('two concurrent judgments of same evidence publish one verdict event',async t=>{
 const {$,ctx,command,input}=await fixture(t);
 const {handleCourt}=await import('../extension/hooks/controls.js');
 const other={...$,session:{...$.session,id:async()=> 'second-adjudicator'}};
 const results=await Promise.all([command('verdict '+JSON.stringify(input)),handleCourt(other,{args:'verdict '+JSON.stringify(input),origin:{kind:'composer'}})]);
 assert.equal(JSON.parse(results[0].text).caseId,JSON.parse(results[1].text).caseId);
 const read=await readProject($,ctx);assert.equal(read.events.filter(e=>e.kind==='verdict.recorded').length,1);
});

test('missing cited evidence after recording never leaves projected punishment active',async t=>{
 const {$,root,command,input}=await fixture(t);
 await command('verdict '+JSON.stringify(input));
 const fs=await import('node:fs/promises');
 const files=(await fs.readdir(root,{recursive:true})).filter(p=>p.endsWith('/'+input.evidenceIds[0]+'.json'));
 for(const path of files)await fs.unlink(root+'/'+path);
 const record=JSON.parse((await command('record '+input.citizenId)).text);
 assert.equal(record.citizen.trustDelta,0);
 assert.deepEqual(record.citizen.restrictions,[]);
 assert.equal(record.cases[0].status,'disputed');
});

test('unknown resume identity must never inherit an older known citizen',async t=>{
 const {$,ctx,command,input}=await fixture(t);
 await emit($,ctx,null,'spawn.result','unknown-resume',{status:'started',childAgentId:'a',citizen:{id:null,identityStrength:'unknown'}});
 assert.match((await command('verdict '+JSON.stringify(input))).text,/rejected|identity|citizen/i);
 assert.deepEqual(JSON.parse((await command('docket')).text).cases,[]);
});
test('post-publication cleanup failure is unconfirmed, never a false rejection',async t=>{
 const {$,command,input}=await fixture(t),run=$.process.run;
 $.process.run=async argv=>argv[0]==='/bin/rm'?{exitCode:1}:run(argv);
 const response=JSON.parse((await command('verdict '+JSON.stringify(input))).text);
 assert.equal(response.recording,'unconfirmed');assert.match(response.caseId,/^[a-f0-9]{64}$/);
 const record=JSON.parse((await command('record '+input.citizenId)).text);
 assert.equal(record.cases[0].caseId,response.caseId);assert.equal(record.citizen.trustDelta,-5);
});
test('whitespace appeal reason is rejected before publication, not silently ignored',async t=>{
 const {$,ctx,command,input}=await fixture(t);
 const made=JSON.parse((await command('verdict '+JSON.stringify(input))).text);
 assert.match((await command('appeal '+made.caseId+' {"decision":"overturn","reason":"   "}')).text,/reason/i);
 const read=await readProject($,ctx);assert.equal(read.events.filter(e=>e.kind==='appeal.decided').length,0);
});
test('a disputed identity binding suspends all dependent case effects',async t=>{
 const {$,ctx,command,input}=await fixture(t);
 await command('verdict '+JSON.stringify(input));
 assert.equal(JSON.parse((await command('record '+input.citizenId)).text).citizen.trustDelta,-5);
 const read=await readProject($,ctx),binding=read.events.find(e=>e.kind==='spawn.result');
 await emit($,ctx,null,'ledger.conflict','binding-conflict',{targetId:binding.id,rejectedHash:'0'.repeat(64)});
 const record=JSON.parse((await command('record '+input.citizenId)).text);
 assert.equal(record.citizen.trustDelta,0);assert.equal(record.cases[0].status,'disputed');
});

test('a disputed historical law approval suspends dependent case effects',async t=>{
 const {$,root,ctx,command,input}=await fixture(t),fs=await import('node:fs/promises');
 await fs.writeFile(root+'/CLAUDE.md','Explicit source write approval policy');
 const approved=JSON.parse((await command('laws approve '+JSON.stringify({path:'CLAUDE.md',rules:[{action:'source.write',target:'a.js',environment:'local',effect:'approval',group:'ordinary'}]}))).text);
 const law={id:'project:CLAUDE.md:0',version:approved.version};
 const metadata={toolCallId:'after-law',tool:'Write',file:{path:'a.js',scope:'project'},environment:'local'};
 const request=await emit($,ctx,'a','tool.request','after-law',metadata);
 const result=await emit($,ctx,'a','tool.result','after-law',{...metadata,status:'completed'});
 await command('verdict '+JSON.stringify({...input,law,evidenceIds:[request,result]}));
 assert.equal(JSON.parse((await command('record '+input.citizenId)).text).citizen.trustDelta,-5);
 const read=await readProject($,ctx),approval=read.events.find(e=>e.kind==='laws.approved');
 await emit($,ctx,null,'ledger.conflict','law-conflict',{targetId:approval.id,rejectedHash:'1'.repeat(64)});
 const record=JSON.parse((await command('record '+input.citizenId)).text);
 assert.equal(record.citizen.trustDelta,0);assert.equal(record.cases[0].status,'disputed');
});

test('NUL reasons cannot report a successful appeal or pardon ignored by replay',async t=>{
 const {$,ctx,command,input}=await fixture(t);
 const made=JSON.parse((await command('verdict '+JSON.stringify(input))).text);
 assert.match((await command('appeal '+made.caseId+' '+JSON.stringify({decision:'overturn',reason:'\0'}))).text,/reason/i);
 assert.match((await command('pardon '+made.caseId+' \0')).text,/reason/i);
 const read=await readProject($,ctx);
 assert.equal(read.events.filter(e=>e.kind==='appeal.decided' || e.kind==='case.pardoned').length,0);
});
