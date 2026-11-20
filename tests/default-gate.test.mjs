import test from 'node:test';
import assert from 'node:assert/strict';
import {world} from './fixtures.mjs';
import {observationContext} from '../plugins/agent-arbiter/hooks/context.js';
import {currentEnforcement} from '../plugins/agent-arbiter/hooks/controls.js';
import {enforceTool} from '../plugins/agent-arbiter/hooks/gate.js';
import {register} from '../plugins/agent-arbiter/hooks/register.js';
import {readProject} from '../plugins/agent-arbiter/hooks/events.js';

async function fresh(t){const w=await world(t);w.$.plugin.root=w.root+'/extension';w.$.session.id=async()=>w.root;await w.command('mode enforce');return w;}
test('clean default enforcement needs no key, policy, settings or probe',async t=>{
 const w=await fresh(t);const ctx=await observationContext(w.$);
 assert.equal((await currentEnforcement(w.$,ctx)).mode,'enforce');assert.equal(ctx.signer,null);
});
test('mode is persisted by project across sessions',async t=>{
 const w=await fresh(t);await w.command('mode observe');w.$.session.id=async()=>w.root+'new';
 assert.equal((await currentEnforcement(w.$,await observationContext(w.$))).mode,'observe');
});
test('normal reads, project edits and Bash never prompt or penalize unknown subagents',async t=>{
 const w=await fresh(t);let asks=0;w.$.ui.ask=async()=>{asks++;return 'Deny'};
 const ctx=await observationContext(w.$);
 for(const e of [{tool:'Read',file_path:w.root+'/a'}, {tool:'Write',file_path:w.root+'/src/a.js',content:'x'},{tool:'Edit',file_path:w.root+'/src/a.js'},{tool:'Bash',command:'node --test'}, {tool:'Bash',command:'some-custom-script foo'}])
 assert.equal(await enforceTool(w.$,ctx,{...e,agentId:'unbound-child'},{},'request'),null);
 assert.equal(asks,0);
});
test('production Bash destructive operations ask; decline never executes',async t=>{
 const w=await fresh(t);let asks=0;w.$.ui.ask=async()=>{asks++;return 'Deny'};const ctx=await observationContext(w.$);
 for(const command of ['git push --force origin main','git reset --hard HEAD','rm -rf scratch','php artisan migrate:fresh','npm install new-package']){
  assert.match((await enforceTool(w.$,ctx,{tool:'Bash',command},{},'req')).deny,/declined|denied/i);
 }
 assert.equal(asks,5);
});
test('outside project and Claude settings ask, Arbiter data is denied, ordinary files allow',async t=>{
 const w=await fresh(t);let asks=0;w.$.ui.ask=async()=>{asks++;return 'Allow'};const ctx=await observationContext(w.$);
 assert.equal(await enforceTool(w.$,ctx,{tool:'Write',file_path:'/opt/court-test-outside/a'},{},'req'),null);
 assert.equal(await enforceTool(w.$,ctx,{tool:'Write',file_path:w.root+'/.claude/settings.json'},{},'req'),null);
 assert.equal(await enforceTool(w.$,ctx,{tool:'Edit',file_path:w.root+'/.claude/agents/dev.md'},{},'req'),null);
 assert.equal(asks,3);
 assert.match((await enforceTool(w.$,ctx,{tool:'Write',file_path:ctx.archiveRoot+'/projects/x/preferences.json'},{},'req')).deny,/denied by rule: file\.arbiter/);
 assert.equal(await enforceTool(w.$,ctx,{tool:'Write',file_path:w.root+'/src/a.js'},{},'req'),null);
 assert.equal(asks,3);
});

test('SDK approval uses the original tool call and cannot execute without a matching host check',async t=>{
 const {$,root}=await fresh(t);
 $.plugin.name='agent-arbiter';
 $.session.surfaces=async()=>[];
 let synthetic=0,runs=0;
 $.ui.ask=async()=>{synthetic++;return 'Allow';};
 const hooks=new Map(),origin={plugin:'engine',tier:'core'};
 register((name,handler)=>{
  if(typeof handler==='function')hooks.set(name,handler);
  return {catch(){}};
 },{language:'en'});
 const invoke=async (id,{approver='host',answer=true,verdict='allow',skipCheck=false,rewrite=false}={})=>{
  const event={tool:'Write',tool_use_id:id,file_path:root+'/.claude/settings.json',content:'{}'};
  return hooks.get('tool.call')($,event,Object.assign(async()=>{
   assert.equal(synthetic,0,'the SDK must not receive a nested approval tool call');
   if(!skipCheck){
    const check=await hooks.get('tool.check')($,{tool:event.tool,tool_use_id:id,approver:approver || undefined,
     input:{file_path:event.file_path,content:event.content}},Object.assign(async()=>({decision:verdict,reason:'Engine decision'}),{origin}));
    if(check.decision==='deny')return {deny:check.reason};
    assert.equal(check.decision,'ask');
    assert.match(check.reason,/Agent Arbiter/);
    if(!answer)return {deny:'Host declined'};
   }
   return hooks.get('tool.run')($,rewrite?{...event,content:'rewritten'}:event,Object.assign(async()=>{runs++;return {result:'written'};},{origin}));
  },{origin}));
 };
 assert.equal((await invoke('host-approved')).result,'written');
 for(const [id,options] of [['declined',{answer:false}],['absent',{approver:null}],['engine-deny',{verdict:'deny'}],['skip',{skipCheck:true}],['rewrite',{rewrite:true}]]){
  assert.ok((await invoke(id,options)).deny,id);
 }
 assert.equal(runs,1);
 assert.equal(synthetic,0);
 const {events}=await readProject($,await observationContext($));
 assert.deepEqual(events.filter(e=>e.kind==='rule.decision'&&e.data.allowed).map(e=>e.data.outcome),['approved']);
});
test('configured broken anchor never blocks default or observe reads',async t=>{
 const w=await fresh(t);w.$.settings.read=async()=>({env:{AGENT_ARBITER_ANCHOR:'a'.repeat(64)}});
 let ctx=await observationContext(w.$);assert.equal(ctx.authConfigured,false);
 assert.equal(await enforceTool(w.$,ctx,{tool:'Read',file_path:w.root+'/a'},{},'req'),null);
 await w.command('mode observe');ctx=await observationContext(w.$);
 assert.equal(await enforceTool(w.$,ctx,{tool:'Read',file_path:w.root+'/a'},{},'req'),null);
});

test('custom rules and builtin toggles change production decisions immediately',async t=>{
 const w=await fresh(t),ctx=await observationContext(w.$);let asks=0;w.$.ui.ask=async()=>{asks++;return 'Deny'};
 const {loadProjectSettings,saveProjectSettings}=await import('../plugins/agent-arbiter/hooks/project-rules.js');
 const settings=await loadProjectSettings(w.$,ctx);
 const edit={tool:'Edit',file_path:w.root+'/src/a.js'};
 assert.equal(await enforceTool(w.$,ctx,edit,{},'one'),null);
 await saveProjectSettings(w.$,ctx,{...settings,rules:[{id:'user:test',action:'file.write',target:'src/**',effect:'deny'}],disabledRules:['git.reset-hard']});
 assert.match((await enforceTool(w.$,ctx,edit,{},'two')).deny,/denied by rule/);
 assert.equal(await enforceTool(w.$,ctx,{tool:'Bash',command:'git reset --hard'},{},'three'),null);assert.equal(asks,0);
 await saveProjectSettings(w.$,ctx,settings);
 assert.equal(await enforceTool(w.$,ctx,edit,{},'four'),null);
 assert.match((await enforceTool(w.$,ctx,{tool:'Bash',command:'git reset --hard'},{},'five')).deny,/declined/);assert.equal(asks,1);
});
test('no answer blocks only sensitive call and never records a sentence',async t=>{
 const w=await fresh(t),ctx=await observationContext(w.$);w.$.ui.ask=async()=>{throw Error('dismissed')};
 assert.match((await enforceTool(w.$,ctx,{tool:'Bash',command:'rm -rf scratch'},{},'one')).deny,/unavailable/);
 const {readProject}=await import('../plugins/agent-arbiter/hooks/events.js');assert.equal((await readProject(w.$,ctx)).events.some(e=>e.kind==='verdict.recorded'),false);
});
test('global settings JSON and destructive ancestor paths are protected',async t=>{
 const w=await fresh(t);w.$.env.get=async k=>k==='HOME'?w.root+'/home':k==='CLAUDE_CONFIG_DIR'?w.root:undefined;
 const ctx=await observationContext(w.$);w.$.ui.ask=async()=> 'Deny';
 // Claude settings ask (declined here); Arbiter code is denied outright.
 for(const e of [{tool:'Write',file_path:w.root+'/home/.claude.json'},{tool:'Bash',command:'rm -rf .claude'}]){
  assert.match((await enforceTool(w.$,ctx,e,{},'one'))?.deny || '',/declined/);
 }
 assert.match((await enforceTool(w.$,ctx,{tool:'Bash',command:'rm -rf '+ctx.pluginRoot},{},'one'))?.deny || '',/denied by rule: .*file\.arbiter/);
});
test('approval never transfers to a symlink target changed while the dialog is open',async t=>{
 const w=await fresh(t),ctx=await observationContext(w.$);const fs=await import('node:fs/promises');
 await fs.mkdir(w.root+'/one');await fs.mkdir(w.root+'/two');await fs.symlink(w.root+'/one',w.root+'/link');
 w.$.ui.ask=async()=>{await fs.unlink(w.root+'/link');await fs.symlink(w.root+'/two',w.root+'/link');return 'Allow'};
 const {loadProjectSettings,saveProjectSettings}=await import('../plugins/agent-arbiter/hooks/project-rules.js');
 await saveProjectSettings(w.$,ctx,{...await loadProjectSettings(w.$,ctx),rules:[{id:'user:ask',action:'file.write',target:'**',effect:'ask'}]});
 assert.match((await enforceTool(w.$,ctx,{tool:'Write',file_path:w.root+'/link/a.js'},{},'one')).deny,/changed|retry/);
});

test('a git worktree of the same repository is inside the project; a forged worktree entry is not',async t=>{
 const fs=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
 const {saveProjectSettings}=await import('../plugins/agent-arbiter/hooks/project-rules.js');
 const w=await fresh(t);let asks=0;w.$.ui.ask=async()=>{asks++;return 'Allow'};
 const tree=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'arbiter-worktree-'))),forged=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'arbiter-forged-')));
 t.after(()=>Promise.all([tree,forged].map(path=>fs.rm(path,{recursive:true,force:true}))));
 const git=await fs.realpath(w.root)+'/.git';
 await fs.mkdir(git+'/worktrees/tree',{recursive:true});await fs.mkdir(git+'/worktrees/forged',{recursive:true});
 await fs.writeFile(git+'/worktrees/tree/gitdir',tree+'/.git\n');await fs.writeFile(tree+'/.git','gitdir: '+git+'/worktrees/tree\n');
 // The forged entry claims a folder whose .git does not point back at it.
 await fs.writeFile(git+'/worktrees/forged/gitdir',forged+'/.git\n');await fs.writeFile(forged+'/.git','gitdir: '+git+'/worktrees/tree\n');
 const ctx=await observationContext(w.$);
 await saveProjectSettings(w.$,ctx,{rules:[{id:'user:src',action:'file.write',target:'src/**',effect:'ask'}]});
 // The project's own rule reaches the worktree's src; the forged folder stays outside.
 assert.equal(await enforceTool(w.$,ctx,{tool:'Write',file_path:tree+'/src/a.js'},{},'one'),null);assert.equal(asks,1);
 assert.equal(await enforceTool(w.$,ctx,{tool:'Write',file_path:forged+'/src/a.js'},{},'two'),null);assert.equal(asks,1);
 // The worktree's own Claude settings stay protected.
 assert.equal(await enforceTool(w.$,ctx,{tool:'Write',file_path:tree+'/.claude/settings.json'},{},'three'),null);assert.equal(asks,2);
});
