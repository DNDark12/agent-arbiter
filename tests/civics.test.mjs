import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {world} from './fixtures.mjs';
import {observationContext} from '../extension/hooks/context.js';
import {enforceTool} from '../extension/hooks/gate.js';
import {enforceSpawn} from '../extension/hooks/spawn.js';
import {loadProjectSettings,saveProjectSettings} from '../extension/hooks/project-rules.js';
import {emit,readProject} from '../extension/hooks/events.js';
import * as discipline from '../extension/hooks/discipline.js';
import {classifyRole,roleOf,ROLES} from '../extension/hooks/roles.js';
import {reduceScores,scoreTable} from '../extension/hooks/scoring.js';
import {reduceLessons,lessonsFor,lessonBlock,lessonEffects} from '../extension/hooks/lessons.js';

const identity=(name='developer',model='claude-sonnet-5-5')=>({id:'c'.repeat(64),name,source:'userSettings',provider:null,
 definitionHash:'d'.repeat(64),resolvedModel:model,engineVersion:'2.1.325'});
const secret={id:'user:secret',action:'file.write',target:'secrets/**',effect:'deny'};
async function fresh(t,rules=[secret]){
 discipline.resetDiscipline();
 const w=await world(t);w.$.plugin.root=w.root+'/extension';w.$.session.id=async()=>w.root;await w.command('mode enforce');
 const ctx=await observationContext(w.$);
 await saveProjectSettings(w.$,ctx,{...await loadProjectSettings(w.$,ctx),rules});
 w.$.ui.ask=async()=> 'Deny';
 return {w,ctx};
}
const breakRule=(w,ctx,agentId)=>enforceTool(w.$,ctx,{tool:'Write',file_path:w.root+'/secrets/key',agentId},{},'req');
const spawn=(w,ctx,name='developer',extra={})=>enforceSpawn(w.$,ctx,{subagentType:name,prompt:'Build it.',...extra},identity(name,null));

test('roles: the agent types in use classify as the plan lists them, and the person can override',()=>{
 const expected={ba:'ba',Plan:'ba','test-designer':'test-design',developer:'dev','codex:codex-rescue':'dev',tester:'test-run',
  reviewer:'review','security-integrity-reviewer':'security','db-migration-reviewer':'db','docs-researcher':'research',
  'claude-code-guide':'research',Explore:'explore',orchestrator:'orchestrate','general-purpose':'other',claude:'other'};
 for(const [name,role] of Object.entries(expected))assert.equal(classifyRole(name),role,name);
 assert.ok(Object.values(expected).every(role=>ROLES.includes(role)));
 assert.equal(roleOf('developer',{developer:'review'}),'review');
 assert.equal(roleOf('developer',{developer:'invented'}),'dev');
 assert.equal(classifyRole(undefined),'other');
});

test('scores: runs, clean runs, sanctions and trust per agent type and model; released violations do not count',()=>{
 const projectId='p'.repeat(64);let n=0;
 const event=(kind,data,agentId=null)=>({id:'e'+(++n),projectId,sessionId:'s',agentId,kind,occurredAt:n,data});
 const citizen=model=>({name:'developer',source:'userSettings',provider:null,definitionHash:'d'.repeat(64),resolvedModel:model});
 const started=(child,model)=>event('spawn.result',{status:'started',childAgentId:child,citizen:citizen(model)});
 const events=[started('a1','claude-sonnet-5-5'),started('a2','claude-sonnet-5-5'),started('a2','claude-sonnet-5-5'),started('a3','claude-opus-5-5'),
  event('turn.complete',{durationMs:500,usage:{output_tokens:40}},'a1'),event('turn.complete',{durationMs:100,usage:{output_tokens:2}},'unknown')];
 const summary=discipline.citizenSummary(citizen('claude-sonnet-5-5'));
 const violation=(id,agentId,sanction,status='active')=>({id,at:1,sessionId:'s',agentId,sanction,ruleIds:['x'],citizen:summary,
  points:sanction==='detain'?30:10,status});
 const rows=reduceScores(events,projectId,{violations:[violation('v1','a1','fine'),violation('v2','a1','detain'),violation('v3','a2','fine','released')]});
 assert.deepEqual(rows.map(row=>[row.model,row.role,row.runs,row.cleanRuns,row.fines,row.detentions,row.points,row.trust,row.detained,row.outputTokens]),
  [['claude-opus-5-5','dev',1,1,0,0,0,100,false,0],['claude-sonnet-5-5','dev',2,1,1,1,40,60,true,40]]);
 assert.match(scoreTable(rows),/developer@claude-sonnet-5-5 · role dev · trust 60 · runs 2 \(clean 1\) · fines 1 · detentions 1 · DETAINED/);
 assert.match(scoreTable([]),/No agent runs/);
 assert.equal(reduceScores(events,'other',{violations:[]}).length,0);
});

test('lessons: pure selection prefers the same agent type, then the same role, then shared ones',()=>{
 const record=(name,ruleIds,at,detail,status='active')=>({id:name+at,at,sessionId:'s',agentId:'a',sanction:'fine',ruleIds,detail,status,
  citizen:name?{name}:null});
 const lessons=reduceLessons({violations:[record('developer',['fs.remove'],1,'fs.remove on storage'),record('developer',['fs.remove'],5,'fs.remove on logs'),
  record('engineer',['git.push'],2,'run git push'),record('tester',['db.reset'],3,'db.reset'),record('developer',['x'],4,'gone','released'),
  {...record(null,['file.arbiter'],6,'main did it'),agentId:null}]},new Map([['fs.remove','Remove files or directories']]));
 assert.deepEqual(lessons.map(lesson=>[lesson.agentName,lesson.role,lesson.count]),[['developer','dev',2],['main','orchestrate',1],['tester','test-run',1],['engineer','dev',1]]);
 assert.equal(lessons[0].text,'Remove files or directories — stopped for: fs.remove on logs');
 const library=[{id:'a'.repeat(12),agentName:'developer',role:'dev',ruleIds:['x'],text:'Shared lesson'},{id:'b'.repeat(12),agentName:'tester',role:'test-run',ruleIds:['y'],text:'Tester only'}];
 const picked=lessonsFor(lessons,library,'developer','dev');
 assert.deepEqual(picked.map(lesson=>[lesson.origin,lesson.agentName]),[['own','developer'],['role','engineer'],['library','developer']]);
 assert.equal(lessonsFor(lessons,library,'developer','dev',1).length,1);
 // An unclassified agent type learns only from its own type.
 assert.deepEqual(lessonsFor(lessons,library,'helper','other'),[]);
 assert.equal(lessonBlock([]),'');
 assert.match(lessonBlock(picked),/^\n\n\[Agent Arbiter lessons\..*not a task.*\n- Remove files or directories — stopped for: fs\.remove on logs \(2 times\)\n- git\.push — stopped for: run git push\n- Shared lesson \(from another project\)\]$/s);
 const effects=lessonEffects([{projectId:'p',kind:'spawn.result',occurredAt:3,data:{lessons:['L1']}},{projectId:'p',kind:'spawn.result',occurredAt:9,data:{lessons:['L1']}}],'p',
  [{...lessons[0],id:'L1'}],{violations:[record('developer',['fs.remove'],1,''),record('developer',['fs.remove'],5,'')]});
 assert.deepEqual(effects.get('L1'),{taught:2,firstTaughtAt:3,repeatsAfter:1});
});

test('a new agent of the same type or role is told what earlier ones were stopped for; release and the switch withdraw it',async t=>{
 const {w,ctx}=await fresh(t);
 discipline.rememberCitizen(ctx,'dev-1',identity());
 assert.deepEqual(await spawn(w,ctx),{input:{subagentType:'developer',prompt:'Build it.'}},'no violations: brief untouched');
 await breakRule(w,ctx,'dev-1');
 const taught=await spawn(w,ctx);
 assert.match(taught.input.prompt,/^Build it\.\n\n\[Agent Arbiter lessons\..*\n- file\.write secrets\/\*\* — stopped for: file\.write on secrets\/key\]$/s);
 assert.equal(taught.lessons.length,1);assert.match(taught.lessons[0],/^[a-f0-9]{12}$/);
 assert.equal(taught.input.model,undefined,'a fine teaches; only detention changes the model');
 assert.match((await spawn(w,ctx,'engineer')).input.prompt,/Agent Arbiter lessons/,'same role');
 assert.equal((await spawn(w,ctx,'tester')).input.prompt,'Build it.','other role');
 assert.equal((await spawn(w,ctx,'developer',{resume:{agentId:'dev-2'}})).input.prompt,'Build it.','a resume is not re-briefed');
 await w.command('role engineer review');
 assert.equal((await spawn(w,ctx,'engineer')).input.prompt,'Build it.','the person moved engineer to another role');
 assert.match((await w.command('lessons off','sdk')).text,/Human composer/);
 await w.command('lessons off');
 assert.equal((await spawn(w,ctx)).input.prompt,'Build it.');
 await w.command('lessons on');
 assert.match((await spawn(w,ctx)).input.prompt,/Agent Arbiter lessons/);
 await w.command('release all');
 assert.equal((await spawn(w,ctx)).input.prompt,'Build it.','a released violation teaches nothing');
});

test('commands: citizens, role, lessons and sharing a lesson with another project',async t=>{
 const {w,ctx}=await fresh(t);
 await emit(w.$,ctx,null,'spawn.result','run-1',{status:'started',childAgentId:'dev-1',citizen:identity()});
 await emit(w.$,ctx,null,'spawn.result','run-2',{status:'started',childAgentId:'dev-2',citizen:identity()});
 discipline.rememberCitizen(ctx,'dev-1',identity());
 await breakRule(w,ctx,'dev-1');
 assert.match((await w.command('citizens')).text,/developer@claude-sonnet-5-5 · role dev · trust 90 · runs 2 \(clean 1\) · fines 1 · detentions 0/);
 assert.match((await w.command('role developer nonsense')).text,/Usage: \/arbiter role/);
 assert.match((await w.command('role developer review','sdk')).text,/Human composer/);
 assert.match((await w.command('role developer review')).text,/Role of developer: review\./);
 assert.match((await w.command('citizens')).text,/role review/);
 assert.match((await w.command('role developer auto')).text,/Role of developer: dev \(automatic\)\./);
 const taught=await spawn(w,ctx);
 await emit(w.$,ctx,null,'spawn.result','run-3',{status:'started',childAgentId:'dev-3',citizen:identity(),lessons:taught.lessons});
 const listed=(await w.command('lessons')).text;
 assert.match(listed,/lessons for this project: on/);
 assert.match(listed,new RegExp(taught.lessons[0]+' · developer \\(dev\\) · file\\.write secrets/\\*\\* — stopped for: file\\.write on secrets/key · broken 1× · taught 1× · broken again after teaching 0×'));
 assert.match((await w.command('lessons share all','sdk')).text,/Human composer/);
 assert.match((await w.command('lessons share zzzz')).text,/No lesson matches/);
 assert.deepEqual(JSON.parse((await w.command('lessons share '+taught.lessons[0].slice(0,6))).text).shared,taught.lessons);
 assert.deepEqual(JSON.parse((await w.command('lessons share all')).text).shared,[],'sharing twice adds nothing');
 assert.equal(JSON.parse((await w.command('lessons library')).text).library[0].sourceProjectId,ctx.projectId);
 // Another project under the same Claude config: the shared lesson reaches the same agent type.
 const other=w.root+'/other-project';await fs.mkdir(other);
 w.$.session.root=async()=>other;w.$.session.id=async()=>'other-session';
 const otherCtx=await observationContext(w.$);
 assert.notEqual(otherCtx.projectId,ctx.projectId);
 const abroad=await spawn(w,otherCtx);
 assert.match(abroad.input.prompt,/- file\.write secrets\/\*\* — stopped for: file\.write on secrets\/key \(from another project\)\]$/);
 assert.equal((await spawn(w,otherCtx,'tester')).input.prompt,'Build it.');
 assert.deepEqual(JSON.parse((await w.command('lessons unshare all')).text).removed,taught.lessons);
 assert.equal((await spawn(w,otherCtx)).input.prompt,'Build it.');
 assert.match((await w.command('lessons unshare all')).text,/No shared lesson/);
});

test('the ledger keeps a command only for a violation or a refusal, never for an allowed call',async t=>{
 const {w,ctx}=await fresh(t,[{id:'user:deploy',action:'bash.command',target:'*deploy*',effect:'ask'}]);
 const decisions=async()=>(await readProject(w.$,ctx)).events.filter(event=>event.kind==='rule.decision').map(event=>[event.data.outcome,event.data.detail]);
 w.$.ui.ask=async()=> 'Allow';
 assert.equal(await enforceTool(w.$,ctx,{tool:'Bash',command:'npm run deploy -- --token=abc',tool_use_id:'t1'},{},'r1'),null);
 w.$.ui.ask=async()=>{throw Error('dismissed')};
 await enforceTool(w.$,ctx,{tool:'Bash',command:'npm run deploy:two',tool_use_id:'t2'},{},'r2');
 w.$.ui.ask=async()=> 'Deny';
 await enforceTool(w.$,ctx,{tool:'Bash',command:'npm run deploy:three',tool_use_id:'t3'},{},'r3');
 assert.deepEqual((await decisions()).sort(),[['approved','run a command matching the rule'],['refused','run npm run deploy:three'],['unanswered','run a command matching the rule']]);
});
