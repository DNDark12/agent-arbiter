import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {world} from './fixtures.mjs';
import {canonical,digest,publish,readLedger} from '../extension/hooks/ledger.js';
import {createSigner} from '../extension/hooks/auth.js';
import {observationContext} from '../extension/hooks/context.js';
import {emit,readProject} from '../extension/hooks/events.js';
const secret='ae'.repeat(32);
const event=async()=>({schemaVersion:1,id:await digest('signed-event'),projectId:await digest('project'),sessionId:'s',agentId:null,kind:'case.pardoned',occurredAt:1,data:{source:{kind:'command',origin:'composer',id:'fake'}}});
test('signed ledger rejects unsigned and checksum-repaired forged evidence',async t=>{
 const w=await world(t),directory=w.root+'/signed',signer=await createSigner(secret,await digest(secret)),e=await event();
 await publish(w.$,directory,e,signer);
 const path=directory+'/'+e.id+'.json',envelope=JSON.parse(await fs.readFile(path,'utf8'));
 assert.equal(envelope.auth?.keyId,signer.keyId);
 assert.equal((await readLedger(w.$,directory,signer)).events.length,1);
 e.data.source.id='forged';envelope.body=canonical(e);envelope.sha256=await digest(envelope.body);
 await fs.writeFile(path,canonical(envelope));
 const bad=await readLedger(w.$,directory,signer);assert.equal(bad.events.length,0);assert.equal(bad.invalid.length,1);
 delete envelope.auth;await fs.writeFile(path,canonical(envelope));
 assert.equal((await readLedger(w.$,directory,signer)).events.length,0);
});
test('event emitter signs observations and never adopts a forged existing ID',async t=>{
 const w=await world(t),ctx={...await observationContext(w.$),signer:await createSigner(secret,await digest(secret))};
 const id=await emit(w.$,ctx,null,'tool.request','signed',{tool:'Read',toolCallId:'signed'});
 const dir=ctx.dataRoot+'/events/'+ctx.projectId+'/'+new Date().toISOString().slice(0,7),path=dir+'/'+id+'.json';
 const envelope=JSON.parse(await fs.readFile(path,'utf8'));assert.ok(envelope.auth);
 delete envelope.auth;await fs.writeFile(path,canonical(envelope));
 // A fresh event module cannot turn the unsigned body's claimed provenance into a signature.
 const fresh=await import('../extension/hooks/events.js?fresh='+crypto.randomUUID());
 await assert.rejects(fresh.emit(w.$,ctx,null,'tool.request','signed',{tool:'Read',toolCallId:'signed'}));
 assert.equal((await readProject(w.$,ctx)).events.some(e=>e.id===id),false);
});

test('signed publication invokes only absolute OS helpers, never agent-controlled PATH programs',async t=>{
 const w=await world(t),run=w.$.process.run,signer=await createSigner(secret,await digest(secret)),calls=[];
 w.$.process.run=async argv=>{calls.push(argv);return run(argv)};
 await publish(w.$,w.root+'/helper-test',await event(),signer);
 assert.ok(calls.length>=2);assert.ok(calls.every(argv=>['/bin/ln','/bin/rm'].includes(argv[0])));
});
