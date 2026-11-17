import test from 'node:test';
import assert from 'node:assert/strict';
import {world} from './fixtures.mjs';
import {observationContext} from '../extension/hooks/context.js';
import {currentEnforcement} from '../extension/hooks/controls.js';
import {enforceTool} from '../extension/hooks/gate.js';

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
test('configured broken anchor never blocks default or observe reads',async t=>{
 const w=await fresh(t);w.$.settings.read=async()=>({env:{AGENT_ARBITER_ANCHOR:'a'.repeat(64)}});
 let ctx=await observationContext(w.$);assert.equal(ctx.authConfigured,false);
 assert.equal(await enforceTool(w.$,ctx,{tool:'Read',file_path:w.root+'/a'},{},'req'),null);
 await w.command('mode observe');ctx=await observationContext(w.$);
 assert.equal(await enforceTool(w.$,ctx,{tool:'Read',file_path:w.root+'/a'},{},'req'),null);
});

test('custom rules and builtin toggles change production decisions immediately',async t=>{
 const w=await fresh(t),ctx=await observationContext(w.$);let asks=0;w.$.ui.ask=async()=>{asks++;return 'Deny'};
 const {loadProjectSettings,saveProjectSettings}=await import('../extension/hooks/project-rules.js');
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
 const {readProject}=await import('../extension/hooks/events.js');assert.equal((await readProject(w.$,ctx)).events.some(e=>e.kind==='verdict.recorded'),false);
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
 const {loadProjectSettings,saveProjectSettings}=await import('../extension/hooks/project-rules.js');
 await saveProjectSettings(w.$,ctx,{...await loadProjectSettings(w.$,ctx),rules:[{id:'user:ask',action:'file.write',target:'**',effect:'ask'}]});
 assert.match((await enforceTool(w.$,ctx,{tool:'Write',file_path:w.root+'/link/a.js'},{},'one')).deny,/changed|retry/);
});
