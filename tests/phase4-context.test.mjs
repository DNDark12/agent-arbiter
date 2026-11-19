import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {world} from './fixtures.mjs';
import {observationContext} from '../plugins/agent-arbiter/hooks/context.js';
import {protectedPaths,strictProfile} from '../plugins/agent-arbiter/hooks/runtime-policy.js';
import {digest} from '../plugins/agent-arbiter/hooks/ledger.js';
test('anchored epoch never adopts unsigned v1 authority and broken anchor cannot fall back',async t=>{
 const w=await world(t);const root=await fs.realpath(w.root),secret='fa'.repeat(32),anchor=await digest(secret),key=root+'/plugins/data/agent-arbiter/security/key-'+crypto.randomUUID()+'.hex';
 await w.$.fs.write(key,secret);await fs.chmod(key,0o600);
 w.$.plugin={root};w.$.env.get=async name=>name==='HOME'?root+'/home':name==='CLAUDE_CONFIG_DIR'?root:undefined;
 const settings=strictProfile(protectedPaths({configRoot:root,pluginRoot:root,projectRoot:root,home:root+'/home',hostRoots:[root+'/host-runtime']}),anchor,key);settings.permissions.disableAutoMode='disable';settings.env.AGENT_ARBITER_HOST_ROOTS=JSON.stringify([root+'/host-runtime']);
 w.$.settings={read:async()=>settings};w.$.tool={list:async()=>[{name:'Bash',mcp:false}],check:async e=>({decision:e.tool==='Bash'?'ask':'deny',rule:e.tool==='Bash'?'*':settings.permissions.deny.find(rule=>rule.startsWith(e.tool==='Read'?'Read(':'Edit('))})};w.$.session.version=async()=>({version:'2.1.325'});
 const ctx=await observationContext(w.$,{authentication:true});assert.ok(ctx.signer);assert.equal(ctx.dataRoot,root+'/plugins/data/agent-arbiter/v2/'+anchor);assert.ok(ctx.archiveRoot.endsWith('/v1'));
 await fs.writeFile(key,'01'.repeat(32));const bad=await observationContext(w.$,{authentication:true});assert.ok(bad.authError);assert.equal(bad.dataRoot,ctx.dataRoot);assert.equal(bad.signer,null);
});
