import {test} from 'node:test';
import assert from 'node:assert/strict';
import {world} from './fixtures.mjs';
import {protectedWorld} from './protected-fixture.mjs';
import * as controls from '../extension/hooks/controls.js';
test('runtime profile is public and never applies settings; SDK cannot bootstrap or probe',async t=>{
 const w=await world(t);const result=JSON.parse((await w.command('runtime profile','sdk')).text);assert.equal(result.applied,false);assert.ok(result.settings.sandbox.enabled);
 assert.match((await w.command('runtime bootstrap','sdk')).text,/Human/);assert.match((await w.command('runtime probe','sdk')).text,/Human/);
});
test('activation needs anchored same-session OS proof and explicit human protocol/host attestation',async t=>{
 assert.equal(typeof controls.currentEnforcement,'function');
 const w=await protectedWorld(t),policy={finePoints:1,replacementModels:['claude-model-two'],grantsOnly:true,trustedHost:true,noOutsideWriters:true};
 assert.match((await w.command('mode enforce '+JSON.stringify(policy))).text,/proof|protected|ready/i);
 assert.equal(JSON.parse((await w.command('runtime probe')).text).ready,true);
 assert.match((await w.command('mode enforce {}')).text,/policy|attestation/i);
 const activated=JSON.parse((await w.command('mode enforce '+JSON.stringify(policy))).text);assert.equal(activated.mode,'enforce');
 const state=await controls.currentEnforcement(w.$,w.ctx);assert.equal(state.mode,'enforce');assert.equal(state.policy.finePoints,1);
 // Changing project identity must not turn the session back into observe.
 assert.equal((await controls.currentEnforcement(w.$,{...w.ctx,projectId:'0'.repeat(64)})).bindingMismatch,true);
 await w.command('off');assert.equal((await controls.currentEnforcement(w.$,w.ctx)).mode,'off');
});
test('selected deny laws require a matching engine deny backup before activation or new approval',async t=>{
 const w=await protectedWorld(t),policy={finePoints:1,replacementModels:['claude-alternative-full-id'],grantsOnly:true,trustedHost:true,noOutsideWriters:true};
 await w.$.fs.write(w.root+'/LAWS.md','Hard law');
 const rule={action:'source.write',target:'a.js',environment:'local',effect:'deny',group:'always-deny'};
 await w.command('laws approve '+JSON.stringify({path:'LAWS.md',rules:[rule]}));await w.command('runtime probe');
 assert.match((await w.command('mode enforce '+JSON.stringify(policy))).text,/backup/i);
 w.settings.permissions.deny.push('Edit(/'+w.root+'/a.js)');await w.command('runtime probe');
 assert.equal(JSON.parse((await w.command('mode enforce '+JSON.stringify(policy))).text).mode,'enforce');
 const changed=await w.command('laws approve '+JSON.stringify({path:'LAWS.md',rules:[{...rule,target:'b.js'}]}));
 assert.match(changed.text,/backup/i);
});
test('temporary startup auth failure never caches observe over persisted signed enforce',async t=>{
 const w=await protectedWorld(t),policy={finePoints:1,replacementModels:['claude-alternative-full-id'],grantsOnly:true,trustedHost:true,noOutsideWriters:true};
 await w.command('runtime probe');await w.command('mode enforce '+JSON.stringify(policy));
 const fresh=await import('../extension/hooks/controls.js?restore='+crypto.randomUUID());
 const {observationContext}=await import('../extension/hooks/context.js');
 w.settings.sandbox.enabled=false;
 const broken=await observationContext(w.$);assert.ok(broken.authError);
 assert.equal((await fresh.currentEnforcement(w.$,broken)).bindingMismatch,true);
 w.settings.sandbox.enabled=true;await w.command('runtime probe');
 assert.equal((await fresh.currentEnforcement(w.$,await observationContext(w.$))).mode,'enforce');
});
test('preview reports actual enforce mode while remaining explicitly evaluation-only',async t=>{
 const w=await protectedWorld(t);await w.command('runtime probe');await w.command('mode enforce '+JSON.stringify({finePoints:1,replacementModels:['claude-model-two'],grantsOnly:true,trustedHost:true,noOutsideWriters:true}));
 const preview=JSON.parse((await w.command('check '+JSON.stringify({action:'source.write',target:'a.js',environment:'local',requestedApproval:false}))).text);
 assert.equal(preview.mode,'enforce');assert.equal(preview.executed,false);assert.equal(preview.evaluationOnly,true);
});
