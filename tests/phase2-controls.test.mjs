import { world } from './fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { observing } from '../extension/hooks/controls.js';

const grant={action:'git.commit',target:'main',environment:'local',scope:{kind:'session',id:'s'}};
const request={action:'git.commit',target:'main',environment:'local',requestedApproval:true};
test('human grant persists, is reused, and revocation removes authority',async t=>{
 const {command}=await world(t);
 const made=JSON.parse((await command('grant '+JSON.stringify(grant))).text);
 assert.ok(made.grantId);
 for(let i=0;i<2;i++)assert.equal(JSON.parse((await command('check '+JSON.stringify(request))).text).decision.outcome,'allow');
 await command('revoke '+made.grantId);
 assert.notEqual(JSON.parse((await command('check '+JSON.stringify(request))).text).decision.outcome,'allow');
});
test('plugin/SDK cannot forge grants, modes or law approvals',async t=>{
 const {command}=await world(t);
 for(const origin of ['plugin','sdk','scheduled-trigger','unclassified']){
  assert.match((await command('grant '+JSON.stringify(grant),origin)).text,/human/i);
  assert.match((await command('off',origin)).text,/human/i);
 }
});
test('UI Deny/dismiss/no answer never creates a grant',async t=>{
 const {$,command}=await world(t);
 for(const response of ['Deny','',null]){
  $.ui.ask=async()=>response;
  assert.equal(JSON.parse((await command('request '+JSON.stringify(grant))).text).granted,false);
 }
 $.ui.ask=async()=>{throw new Error('dismissed')};
 assert.equal(JSON.parse((await command('request '+JSON.stringify(grant))).text).granted,false);
 assert.deepEqual(JSON.parse((await command('grants')).text).grants,[]);
});
test('off stops collection even if mode persistence fails; failed enable does not claim success',async t=>{
 const {$,command}=await world(t);
 $.fs.write=async()=>{throw new Error('disk unavailable')};
 assert.match((await command('off')).text,/off/i);
 assert.equal(await observing($),false);
 assert.match((await command('mode enforce')).text,/failed|storage/i);
 assert.equal(await observing($),false);
});

test('approved project law wins over grants and source changes withdraw it until reapproved',async t=>{
 const {root,command}=await world(t);
 await fs.writeFile(join(root,'CLAUDE.md'),'Never push main');
 const input={path:'CLAUDE.md',rules:[{action:'git.push',target:'main',environment:'local',effect:'deny',group:'always-deny'}]};
 const approved=JSON.parse((await command('laws approve '+JSON.stringify(input))).text);
 assert.equal(approved.approved,true);
 const req={action:'git.push',target:'main',environment:'local',requestedApproval:true};
 await command('grant '+JSON.stringify(req));
 assert.equal(JSON.parse((await command('check '+JSON.stringify(req))).text).decision.reason,'always-denied');
 await fs.writeFile(join(root,'CLAUDE.md'),'Changed policy');
 const laws=JSON.parse((await command('laws')).text);
 assert.equal(laws.inactive.length,1);
 await fs.writeFile(join(root,'CLAUDE.md'),'Never push main');
 assert.equal(JSON.parse((await command('laws')).text).inactive.length,1);
 await command('laws approve '+JSON.stringify(input));
 assert.equal(JSON.parse((await command('laws')).text).inactive.length,0);
});
test('UI Allow persists a scoped ui grant; check previews link back to evidence',async t=>{
 const {command}=await world(t);
 assert.equal(JSON.parse((await command('request '+JSON.stringify(grant))).text).granted,true);
 const preview=JSON.parse((await command('check '+JSON.stringify(request))).text);
 assert.equal(preview.decision.outcome,'allow');
 assert.match(preview.evidenceId,/^[a-f0-9]{64}$/);
 const evidence=JSON.parse((await command('evidence '+preview.evidenceId)).text);
 assert.equal(evidence.kind,'policy.preview');
 assert.equal(evidence.data.evaluationOnly,true);
 assert.match(evidence.data.basis.lawVersion,/^[a-f0-9]{64}$/);
});

test('disputed authority ledger never produces allow',async t=>{
 const {$,root,command}=await world(t);
 await command('grant '+JSON.stringify(grant));
 const files=(await fs.readdir(root,{recursive:true})).filter(p=>p.endsWith('.json') && p.includes('/events/'));
 const events=await Promise.all(files.map(async p=>JSON.parse(JSON.parse(await fs.readFile(join(root,p),'utf8')).body)));
 const created=events.find(e=>e.kind==='grant.created');
 const {emit}=await import('../extension/hooks/events.js');
 const {observationContext}=await import('../extension/hooks/context.js');
 await emit($,await observationContext($),null,'ledger.conflict','fixture-conflict',{targetId:created.id,rejectedHash:'0'.repeat(64)});
 assert.match((await command('check '+JSON.stringify(request))).text,/integrity unavailable/i);
 const evidence=JSON.parse((await command('evidence '+created.id)).text);
 assert.equal(evidence.integrity.disputed,true);
 assert.equal(evidence.kind,'grant.created');
 assert.equal(await command('verify'),null);
});

test('consent arriving after grant expiry cannot create or report an active grant',async t=>{
 const {$,command}=await world(t);
 const originalNow=Date.now;
 $.ui.ask=async()=>{Date.now=()=>originalNow()+172800000;return 'Allow'};
 try {
  const answer=JSON.parse((await command('request '+JSON.stringify(grant))).text);
  assert.equal(answer.granted,false);
  assert.deepEqual(JSON.parse((await command('grants')).text).grants,[]);
 } finally {Date.now=originalNow;}
});
