import {test} from 'node:test';
import assert from 'node:assert/strict';
import {protectedWorld} from './protected-fixture.mjs';
import {probeRuntime,consumeRuntimeProbe} from '../extension/hooks/runtime.js';
import {register} from '../extension/hooks/register.js';
test('a failed native canary tool preserves its original error and never executes twice',async t=>{
 const w=await protectedWorld(t),plan=await probeRuntime(w.$,w.ctx);let handler,calls=0;
 register((name,match)=>{if(name==='tool.call')handler=match;return {catch(){}}});
 const error=new Error('actual sandbox tool failed'),next=Object.assign(async()=>{calls++;throw error},{origin:{plugin:'engine',tier:'core'}});
 await assert.rejects(handler(w.$,{tool:'Bash',command:plan.commands[0],timeout:5000},next),error);
 assert.equal(calls,1);
 assert.equal(consumeRuntimeProbe(w.ctx,{tool:'Bash',command:plan.commands[1]},{plugin:'engine',tier:'core'},'agent-arbiter'),null);
});
