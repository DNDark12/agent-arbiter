import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as runtime from '../extension/hooks/runtime.js';
import {driveProbe} from './protected-fixture.mjs';
import {world} from './fixtures.mjs';
import {protectedPaths,strictProfile} from '../extension/hooks/runtime-policy.js';
import {digest} from '../extension/hooks/ledger.js';
async function fixture(t){
 const w=await world(t);w.root=await fs.realpath(w.root);const ctx={configRoot:w.root,pluginRoot:w.root+'/extension',projectRoot:w.root+'/project',sessionId:'s'};
 await fs.mkdir(ctx.pluginRoot);await fs.mkdir(ctx.projectRoot);
 const paths=protectedPaths({...ctx,home:w.root+'/home',hostRoots:[w.root+'/host-runtime']}),settings=strictProfile(paths);settings.permissions.disableAutoMode='disable';settings.env.AGENT_ARBITER_HOST_ROOTS=JSON.stringify([w.root+'/host-runtime']);
 w.$.plugin={root:ctx.pluginRoot};w.$.settings={read:async()=>settings};w.$.session.version=async()=>({version:'2.1.325'});
 w.$.env.get=async k=>k==='HOME'?w.root+'/home':k==='CLAUDE_CONFIG_DIR'?w.root:undefined;
 w.$.tool={call:async e=>({result:{stdout:e.command.includes('COURT_BASELINE')?'COURT_BASELINE':e.command.includes('ALIAS_BLOCKED')?'ALIAS_BLOCKED':e.command.includes('READ_BLOCKED')?'READ_BLOCKED':'WRITE_BLOCKED',exitCode:0}}),list:async()=>[{name:'Bash',mcp:false},{name:'Read',mcp:false},{name:'Write',mcp:false}],check:async q=>({decision:q.tool==='Bash'?'ask':'deny',rule:q.tool==='Bash'?'*':settings.permissions.deny.find(rule=>rule.startsWith(q.tool==='Read'?'Read(':'Edit('))})};
 return {...w,ctx,settings,paths};
}
test('runtime never bootstraps secrets without the protected floor or true human ingress',async t=>{
 assert.equal(typeof runtime.bootstrapRuntime,'function');const w=await fixture(t);
 await assert.rejects(runtime.bootstrapRuntime(w.$,w.ctx,{kind:'sdk'}),/Human/);
 w.settings.sandbox.enabled=false;
 await assert.rejects(runtime.bootstrapRuntime(w.$,w.ctx,{kind:'composer'}),/protection|strict|floor/i);
 assert.equal(await w.$.fs.exists(w.root+'/plugins/data/agent-arbiter/security'),false);
});
test('anchored load refuses wrong key, bad floor, untrusted external tools and symlinked keys',async t=>{
 assert.equal(typeof runtime.loadAuthentication,'function');const w=await fixture(t),secret='dc'.repeat(32),anchor=await digest(secret);
 const key=w.root+'/plugins/data/agent-arbiter/security/key-'+crypto.randomUUID()+'.hex';await w.$.fs.write(key,secret);await fs.chmod(key,0o600);
 Object.assign(w.settings.env,{AGENT_ARBITER_ANCHOR:anchor,AGENT_ARBITER_KEY_FILE:key});
 const loaded=await runtime.loadAuthentication(w.$,w.ctx);assert.ok(loaded.signer);assert.equal(loaded.anchor,anchor);
 await fs.writeFile(key,'ed'.repeat(32));assert.ok((await runtime.loadAuthentication(w.$,w.ctx)).authError);
 await fs.writeFile(key,secret);w.settings.sandbox.allowAppleEvents=true;assert.ok((await runtime.loadAuthentication(w.$,w.ctx)).authError);
 w.settings.sandbox.allowAppleEvents=false;w.$.tool.list=async()=>[{name:'mcp__shell__exec',mcp:true}];assert.ok((await runtime.loadAuthentication(w.$,w.ctx)).authError);
 w.$.tool.list=async()=>[{name:'Bash',mcp:false}];const link=key+'.link';await fs.symlink(key,link);w.settings.env.AGENT_ARBITER_KEY_FILE=link;assert.ok((await runtime.loadAuthentication(w.$,w.ctx)).authError);
});
test('fresh bootstrap returns only public anchor and unique 0600 key path; never adopts preseeded keys',async t=>{
 assert.equal(typeof runtime.bootstrapRuntime,'function');const w=await fixture(t);
 await w.$.fs.write(w.root+'/plugins/data/agent-arbiter/security/key.hex','aa'.repeat(32));
 w.settings.permissions.deny.push('Skill');
 await driveProbe(w.$,w.ctx,await runtime.probeRuntime(w.$,w.ctx));
 const result=await runtime.bootstrapRuntime(w.$,w.ctx,{kind:'composer'});
 assert.ok(result.settings.permissions.deny.includes('Skill'));
 const key=await fs.readFile(result.keyFile,'utf8');assert.equal(key.length,64);assert.equal(result.anchor,await digest(key));
 assert.equal((await fs.stat(result.keyFile)).mode & 0o777,0o600);assert.equal(JSON.stringify(result).includes(key),false);
 assert.notEqual(result.keyFile,w.root+'/plugins/data/agent-arbiter/security/key.hex');
});
test('sandbox proof requires a successful baseline and explicit blocked read/write markers',async t=>{
 assert.equal(typeof runtime.probeRuntime,'function');const w=await fixture(t);let calls=0;
 w.$.tool.call=async e=>{calls++;return {result:{stdout:e.command.includes('COURT_BASELINE')?'COURT_BASELINE':e.command.includes('ALIAS_BLOCKED')?'ALIAS_BLOCKED':e.command.includes('READ_BLOCKED')?'READ_BLOCKED':'WRITE_BLOCKED',exitCode:0}}};
 const plan=await runtime.probeRuntime(w.$,w.ctx);assert.equal(plan.pending,true);assert.equal(calls,0);
 const proof=await driveProbe(w.$,w.ctx,plan);assert.equal(proof.ready,true);assert.ok(calls>=3);
 w.$.tool.call=async()=>({deny:'headless ask unanswered'});
 const restarted={...w.ctx,sessionId:'new-'+crypto.randomUUID()};
 assert.equal((await driveProbe(w.$,restarted,await runtime.probeRuntime(w.$,restarted))).ready,false);
});
test('direct read/write denial cannot prove readiness if a hard-link alias remains readable',async t=>{
 const w=await fixture(t);
 w.$.tool.call=async e=>({result:{stdout:e.command.includes('COURT_BASELINE')?'COURT_BASELINE':e.command.includes('/bin/ln')?'ALIAS_OPEN':e.command.includes('READ_BLOCKED')?'READ_BLOCKED':'WRITE_BLOCKED',exitCode:0}});
 assert.equal((await driveProbe(w.$,w.ctx,await runtime.probeRuntime(w.$,w.ctx))).ready,false);
});
test('only a pending exact engine-origin canary gets a one-use probe receipt',async t=>{
 const w=await fixture(t),plan=await runtime.probeRuntime(w.$,w.ctx);assert.equal(plan.pending,true);
 const e={tool:'Bash',command:plan.commands[0],timeout:5000};
 assert.equal(runtime.consumeRuntimeProbe(w.ctx,e,{plugin:'agent-arbiter',tier:'user'},'agent-arbiter'),null);
 assert.equal(runtime.consumeRuntimeProbe(w.ctx,{...e,command:e.command+'; malicious'},{plugin:'engine',tier:'core'},'agent-arbiter'),null);
 const receipt=runtime.consumeRuntimeProbe(w.ctx,e,{plugin:'engine',tier:'core'},'agent-arbiter');assert.ok(receipt);
 assert.equal(runtime.consumeRuntimeProbe(w.ctx,e,{plugin:'engine',tier:'core'},'agent-arbiter'),null);
 assert.equal((await runtime.completeRuntimeProbe(w.$,w.ctx,receipt,{result:{stdout:'COURT_BASELINE',exitCode:0}})).pending,true);
 assert.equal((await runtime.completeRuntimeProbe(w.$,w.ctx,receipt,{result:{stdout:'COURT_BASELINE',exitCode:0}})).ready,false);
});

test('agent-created alias collisions never count as sandbox denial',async t=>{
 const w=await fixture(t),plan=await runtime.probeRuntime(w.$,w.ctx);
 const nonce=plan.commands[1].match(/probe-([a-f0-9-]+)\.txt/)[1];
 await fs.writeFile(w.ctx.projectRoot+'/.court-sandbox-alias-'+nonce,'collision');
 const result=await driveProbe(w.$,w.ctx,plan);assert.equal(result.ready,false);
});
test('cross-device alias failures alone are not isolation proof',async t=>{
 const w=await fixture(t);w.$.tool.call=async e=>({result:{stdout:e.command.includes('COURT_BASELINE')?'COURT_BASELINE':e.command.includes('ALIAS_BLOCKED')?'ALIAS_CROSS_DEVICE':e.command.includes('READ_BLOCKED')?'READ_BLOCKED':'WRITE_BLOCKED',exitCode:0}});
 assert.equal((await driveProbe(w.$,w.ctx,await runtime.probeRuntime(w.$,w.ctx))).ready,false);
});
test('unconfined negative control returns OPEN, while EEXIST is UNPROVEN rather than blocked',async t=>{
 const w=await fixture(t),plan=await runtime.probeRuntime(w.$,w.ctx),run=command=>w.$.process.run(['/bin/sh','-c',command]);
 assert.equal((await run(plan.commands[1])).stdout,'READ_OPEN');
 assert.equal((await run(plan.commands[2])).stdout,'WRITE_OPEN');
 const nonce=plan.commands[1].match(/probe-([a-f0-9-]+)\.txt/)[1],alias=w.ctx.projectRoot+'/.court-sandbox-alias-'+nonce;
 await fs.writeFile(alias,'collision');assert.equal((await run(plan.commands[3])).stdout,'ALIAS_UNPROVEN');
 await fs.unlink(alias);assert.equal((await run(plan.commands[3])).stdout,'ALIAS_OPEN');
});
test('one cross-device alias may be inapplicable only when another has a real denial',async t=>{
 const w=await fixture(t);
 w.$.tool.call=async e=>({result:{stdout:e.command.includes('COURT_BASELINE')?'COURT_BASELINE':e.command.includes('ALIAS_BLOCKED')?(e.command.includes(w.ctx.projectRoot)?'ALIAS_CROSS_DEVICE':'ALIAS_BLOCKED'):e.command.includes('READ_BLOCKED')?'READ_BLOCKED':'WRITE_BLOCKED',exitCode:0}});
 assert.equal((await driveProbe(w.$,w.ctx,await runtime.probeRuntime(w.$,w.ctx))).ready,true);
});
