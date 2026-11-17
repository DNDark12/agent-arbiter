import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageRoot, observationContext } from '../extension/hooks/context.js';
test('stable data path respects custom config and does not depend on install version', async () => {
 const $={env:{get:async k=>k==='CLAUDE_CONFIG_DIR'?'/custom':null},plugin:{root:'/cache/v1'}};
 assert.equal(await storageRoot($),'/custom/plugins/data/agent-arbiter/v1');
 $.plugin.root='/cache/v2'; assert.equal(await storageRoot($),'/custom/plugins/data/agent-arbiter/v1');
});
test('worktrees share repository identity while checkout roots stay separate', async()=>{
 const make=root=>({session:{root:async()=>root,id:async()=>'s',repo:async()=>({root:'/repo'})},env:{get:async k=>k==='HOME'?'/home/u':null},fs:{exists:async()=>false,stat:async p=>({realPath:p})}});
 const a=await observationContext(make('/worktree/a')),b=await observationContext(make('/worktree/b'));
 assert.equal(a.projectId,b.projectId);assert.notEqual(a.checkoutId,b.checkoutId);assert.equal(a.root,'/worktree/a');
});
