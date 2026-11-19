import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageRoot, observationContext } from '../plugins/agent-arbiter/hooks/context.js';
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

test('Arbiter declares itself inactive on Windows and where no POSIX config folder exists',async()=>{
 const {platformSupported}=await import('../plugins/agent-arbiter/hooks/context.js');
 const env=values=>({env:{get:async key=>values[key]}});
 assert.equal(await platformSupported(env({HOME:'/Users/a'})),true);
 assert.equal(await platformSupported(env({OS:'Windows_NT',HOME:'C:\\Users\\a'})),false);
 assert.equal(await platformSupported(env({USERPROFILE:'C:\\Users\\a'})),false);
 assert.equal(await platformSupported(env({CLAUDE_CONFIG_DIR:'D:/claude'})),false);
 assert.equal(await platformSupported(env({CLAUDE_CONFIG_DIR:'/opt/claude'})),true);
});
