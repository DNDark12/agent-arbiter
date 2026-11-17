import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {world} from './fixtures.mjs';
import {observationContext} from '../extension/hooks/context.js';
import {enforceTool} from '../extension/hooks/gate.js';
import {enforceSpawn} from '../extension/hooks/spawn.js';
import {loadProjectSettings,saveProjectSettings} from '../extension/hooks/project-rules.js';
import {emit,readProject} from '../extension/hooks/events.js';
import {refreshStatus} from '../extension/hooks/status.js';
import {setLanguage} from '../extension/hooks/i18n.js';
import * as discipline from '../extension/hooks/discipline.js';

const identity=(name='developer',model='claude-sonnet-5-5')=>({id:'c'.repeat(64),name,source:'userSettings',provider:null,
 definitionHash:'d'.repeat(64),resolvedModel:model,engineVersion:'2.1.325'});
async function fresh(t,rules=[{id:'user:secret',action:'file.write',target:'secrets/**',effect:'jail'}]){
 discipline.resetDiscipline();
 const w=await world(t);w.$.plugin.root=w.root+'/extension';w.$.session.id=async()=>w.root;await w.command('mode enforce');
 const ctx=await observationContext(w.$);
 await saveProjectSettings(w.$,ctx,{...await loadProjectSettings(w.$,ctx),rules});
 w.status=[];w.$.ui.status=text=>{w.status.push(text);};w.$.ui.ask=async()=> 'Deny';
 return {w,ctx};
}

test('the status line shows detained agents and clears when released',async t=>{
 const {w,ctx}=await fresh(t);
 assert.equal(await refreshStatus(w.$,ctx),null);assert.equal(w.status.at(-1),undefined);
 discipline.rememberCitizen(ctx,'dev-1',identity());
 await enforceTool(w.$,ctx,{tool:'Write',file_path:w.root+'/secrets/a',agentId:'dev-1',tool_use_id:'t1'},{},'r');
 assert.equal(await refreshStatus(w.$,ctx),'Arbiter: 1 detained · 0 to review');
 await w.command('release all');
 assert.equal(w.status.at(-1),undefined);
 await w.command('mode off');
 assert.equal(await refreshStatus(w.$,ctx),null,'nothing shows while the project is off');
 // A broken status call never breaks anything.
 w.$.ui.status=()=>{throw Error('no surface')};assert.equal(await refreshStatus(w.$,ctx),null);
});

test('purge asks first, deletes only this project, or every project with all; only a person can purge',async t=>{
 const {w,ctx}=await fresh(t);
 await enforceTool(w.$,ctx,{tool:'Write',file_path:w.root+'/secrets/a',tool_use_id:'t1'},{},'r');
 const other=w.root+'/other';await fs.mkdir(other);w.$.session.root=async()=>other;
 const otherCtx=await observationContext(w.$);await saveProjectSettings(w.$,otherCtx,{mode:'observe'});
 w.$.session.root=async()=>w.root;
 const exists=p=>fs.access(p).then(()=>true,()=>false);
 assert.match((await w.command('purge','sdk')).text,/Human composer/);
 w.$.ui.ask=async()=> 'Cancel';
 assert.match((await w.command('purge')).text,/Nothing was deleted/);
 assert.ok(await exists(`${ctx.archiveRoot}/events/${ctx.projectId}`));
 let asked;w.$.ui.ask=async(question,options)=>{asked=question;return options[1];};
 assert.match((await w.command('purge')).text,/^Deleted Agent Arbiter data for this project\./);
 assert.match(asked,/cannot be undone/);
 assert.equal(await exists(`${ctx.archiveRoot}/events/${ctx.projectId}`),false);
 assert.equal(await exists(`${ctx.archiveRoot}/projects/${ctx.projectId}`),false);
 assert.equal((await loadProjectSettings(w.$,otherCtx)).mode,'observe','another project is untouched');
 assert.equal((await readProject(w.$,ctx)).events.length,0);
 assert.match((await w.command('docket')).text,/No violations recorded/);
 assert.match((await w.command('purge everything')).text,/^Usage:/);
 assert.match((await w.command('purge all')).text,/every project/);
 assert.equal(await exists(`${ctx.configRoot}/plugins/data/agent-arbiter`),false);
});

test('the lesson experiment holds lessons back from about one run in five and reports both groups',async t=>{
 const {w,ctx}=await fresh(t,[{id:'user:secret',action:'file.write',target:'secrets/**',effect:'deny'}]);
 discipline.rememberCitizen(ctx,'dev-0',identity());
 await enforceTool(w.$,ctx,{tool:'Write',file_path:w.root+'/secrets/a',agentId:'dev-0',tool_use_id:'t0'},{},'r');
 assert.match((await w.command('lessons experiment on','sdk')).text,/Human composer/);
 assert.match((await w.command('lessons experiment on')).text,/Lesson experiment on/);
 let taught=0,held=0;
 for(let n=0;n<60;n++){
  const policy=await enforceSpawn(w.$,ctx,{subagentType:'developer',prompt:'Build it.',tool_use_id:'spawn-'+n},identity('developer',null));
  if(policy.lessonsHeldOut){held++;assert.equal(policy.input.prompt,'Build it.');}
  else{taught++;assert.match(policy.input.prompt,/Agent Arbiter lessons/);}
  await emit(w.$,ctx,null,'spawn.result','run-'+n,{status:'started',childAgentId:'child-'+n,citizen:identity(),
   ...(policy.lessonsHeldOut?{lessonsHeldOut:true}:{lessons:policy.lessons})});
 }
 assert.ok(held>=5 && held<=20,`held ${held} of 60`);
 discipline.rememberCitizen(ctx,'child-1',identity());
 await enforceTool(w.$,ctx,{tool:'Write',file_path:w.root+'/secrets/b',agentId:'child-1',tool_use_id:'t1'},{},'r');
 assert.match((await w.command('lessons')).text,new RegExp(`Experiment: runs taught ${taught} \\(violations [01], rate 0\\.0\\d\\) · runs held out ${held} \\(violations [01], rate`));
 await w.command('lessons experiment off');
 assert.equal((await enforceSpawn(w.$,ctx,{subagentType:'developer',prompt:'Build it.',tool_use_id:'spawn-0'},identity('developer',null))).lessonsHeldOut,undefined);
});

test('citizens all merges scores per agent type and model across projects',async t=>{
 const {w,ctx}=await fresh(t);
 await emit(w.$,ctx,null,'spawn.result','a1',{status:'started',childAgentId:'a1',citizen:identity()});
 const other=w.root+'/other';await fs.mkdir(other);w.$.session.root=async()=>other;w.$.session.id=async()=>'s2';
 const otherCtx=await observationContext(w.$);
 await saveProjectSettings(w.$,otherCtx,{rules:[{id:'user:secret',action:'file.write',target:'secrets/**',effect:'jail'}]});
 await emit(w.$,otherCtx,null,'spawn.result','b1',{status:'started',childAgentId:'b1',citizen:identity()});
 await emit(w.$,otherCtx,null,'spawn.result','b2',{status:'started',childAgentId:'b2',citizen:identity('tester')});
 discipline.rememberCitizen(otherCtx,'b1',identity());
 await enforceTool(w.$,otherCtx,{tool:'Write',file_path:other+'/secrets/x',agentId:'b1',tool_use_id:'tb'},{},'r');
 const text=(await w.command('citizens all')).text;
 assert.match(text,/^Agent Arbiter citizens across 2 project\(s\)/);
 assert.match(text,/developer@claude-sonnet-5-5 · role dev · trust 70 · runs 2 \(clean 1\) · fines 0 · detentions 1 · DETAINED/);
 assert.match(text,/tester@claude-sonnet-5-5 · role test-run · trust 100 · runs 1 \(clean 1\)/);
});

test('command replies follow the chosen language',async t=>{
 const {w}=await fresh(t);t.after(()=>setLanguage('en'));
 setLanguage('vi');
 assert.match((await w.command('docket')).text,/^Project này chưa có vi phạm nào\.$/);
 assert.match((await w.command('release all','sdk')).text,/^Cần người dùng gõ trực tiếp/);
 assert.match((await w.command('citizens')).text,/^Project này chưa có lần chạy agent nào\.$/);
 assert.match((await w.command('judge')).text,/^Thẩm phán: bật · model haiku/);
 setLanguage('en');
 assert.match((await w.command('docket')).text,/^No violations recorded/);
});
