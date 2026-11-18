import test from 'node:test';
import assert from 'node:assert/strict';
import {world} from './fixtures.mjs';
import {observationContext} from '../extension/hooks/context.js';
import {enforceTool} from '../extension/hooks/gate.js';
import {enforceSpawn} from '../extension/hooks/spawn.js';
import {loadProjectSettings,saveProjectSettings} from '../extension/hooks/project-rules.js';
import {readProject} from '../extension/hooks/events.js';
import * as discipline from '../extension/hooks/discipline.js';

const REMOVE='r'+'m -rf';
const identity=(model='claude-sonnet-5-5')=>({id:'c'.repeat(64),name:'developer',source:'userSettings',provider:null,
 definitionHash:'d'.repeat(64),resolvedModel:model,engineVersion:'2.1.325'});
async function fresh(t,rules=[]){
 discipline.resetDiscipline();
 const w=await world(t);w.$.plugin.root=w.root+'/extension';w.$.session.id=async()=>w.root;await w.command('mode enforce');
 const ctx=await observationContext(w.$);
 if(rules.length)await saveProjectSettings(w.$,ctx,{...await loadProjectSettings(w.$,ctx),rules});
 w.asks=0;w.answer='Deny';w.$.ui.ask=async()=>{w.asks++;return w.answer};
 return {w,ctx};
}
const secret={id:'user:secret',action:'file.write',target:'secrets/**',effect:'deny'};
const write=(w,agentId,path='secrets/key')=>({tool:'Write',file_path:w.root+'/'+path,...(agentId?{agentId}:{})});

test('main agent breaking a deny rule gets a warning and is never detained',async t=>{
 const {w,ctx}=await fresh(t,[secret]);
 for(let i=0;i<3;i++)assert.match((await enforceTool(w.$,ctx,write(w,null),{},'req')).deny,/denied by rule: user:secret\. Warning recorded/);
 assert.equal(await enforceTool(w.$,ctx,{tool:'Read',file_path:w.root+'/a'},{},'req'),null);
 const state=await discipline.disciplineState(w.$,ctx,true);
 assert.deepEqual(state.violations.map(record=>record.sanction),['warning','warning','warning']);
 assert.equal(w.asks,0);
});

test('subagent is fined first, detained on the second violation, then only one report passes',async t=>{
 const {w,ctx}=await fresh(t,[secret]);
 discipline.rememberCitizen(ctx,'dev-1',identity());
 assert.match((await enforceTool(w.$,ctx,write(w,'dev-1'),{},'one')).deny,/fine, -10 points.*second violation detains/);
 assert.equal(await enforceTool(w.$,ctx,write(w,'dev-1','src/a.js'),{},'ok'),null,'a fined agent keeps working');
 assert.match((await enforceTool(w.$,ctx,write(w,'dev-1'),{},'two')).deny,/now detained/);
 for(const event of [{tool:'Read',file_path:w.root+'/a'},{tool:'Bash',command:'ls'},write(w,'dev-1','src/a.js')]){
  assert.match((await enforceTool(w.$,ctx,{...event,agentId:'dev-1'},{},'held')).deny,/is detained/);
 }
 assert.match((await enforceTool(w.$,ctx,{tool:'SubagentHandback',agentId:'dev-1',message:'x'.repeat(discipline.REPORT_LIMIT+1)},{},'big')).deny,/is detained/);
 assert.equal(await enforceTool(w.$,ctx,{tool:'SubagentHandback',agentId:'dev-1',message:'final report'},{},'report'),null);
 assert.match((await enforceTool(w.$,ctx,{tool:'SubagentHandback',agentId:'dev-1',message:'again'},{},'report2')).deny,/is detained/);
 // Another agent in the same session is unaffected.
 assert.equal(await enforceTool(w.$,ctx,{tool:'Bash',command:'ls',agentId:'dev-2'},{},'other'),null);
 const state=await discipline.disciplineState(w.$,ctx,true);
 assert.deepEqual(state.violations.map(record=>[record.sanction,record.points,record.citizen.name,record.citizen.model]),
  [['fine',10,'developer','claude-sonnet-5-5'],['detain',30,'developer','claude-sonnet-5-5']]);
 assert.match(discipline.handbackNote(state,ctx,'dev-1'),/broke project rules \(user:secret\).*detained.*different model/);
 assert.equal(discipline.handbackNote(state,ctx,'dev-2'),null);
});

test('a jail rule detains a subagent at once',async t=>{
 const {w,ctx}=await fresh(t,[{...secret,effect:'jail'}]);
 assert.match((await enforceTool(w.$,ctx,write(w,'dev-1'),{},'one')).deny,/now detained/);
 assert.match((await enforceTool(w.$,ctx,{tool:'Read',file_path:w.root+'/a',agentId:'dev-1'},{},'two')).deny,/is detained/);
});

test('retrying an action the person refused is a violation; no answer never is',async t=>{
 const {w,ctx}=await fresh(t);
 const remove=command=>({tool:'Bash',command,agentId:'dev-1'});
 assert.match((await enforceTool(w.$,ctx,remove(REMOVE+' scratch'),{},'one')).deny,/declined/);
 assert.equal(w.asks,1);
 // Same target reached another way: not asked again, fined instead.
 assert.match((await enforceTool(w.$,ctx,remove('find scratch -delete'),{},'two')).deny,/denied by rule: fs\.remove.*fine/);
 assert.equal(w.asks,1);
 // A different target is a new question.
 assert.match((await enforceTool(w.$,ctx,remove(REMOVE+' other'),{},'three')).deny,/declined/);
 assert.equal(w.asks,2);
 // The main agent may ask again: the person is there to answer.
 assert.match((await enforceTool(w.$,ctx,{tool:'Bash',command:REMOVE+' scratch'},{},'main1')).deny,/declined/);
 assert.match((await enforceTool(w.$,ctx,{tool:'Bash',command:REMOVE+' scratch'},{},'main2')).deny,/declined/);
 assert.equal(w.asks,4);
 w.$.ui.ask=async()=>{throw Error('dismissed')};
 for(let i=0;i<2;i++)assert.match((await enforceTool(w.$,ctx,{tool:'Bash',command:REMOVE+' unanswered',agentId:'dev-9'},{},'u'+i)).deny,/unavailable/);
 assert.equal((await discipline.disciplineState(w.$,ctx,true)).violations.length,1);
});

test('allowing a rule for the session stops further questions for that rule only',async t=>{
 const {w,ctx}=await fresh(t);w.answer='Allow this rule for the session';
 assert.equal(await enforceTool(w.$,ctx,{tool:'Bash',command:REMOVE+' scratch'},{},'one'),null);
 assert.equal(await enforceTool(w.$,ctx,{tool:'Bash',command:REMOVE+' other',agentId:'dev-1'},{},'two'),null);
 assert.equal(w.asks,1);
 w.answer='Deny';
 assert.match((await enforceTool(w.$,ctx,{tool:'Bash',command:'git reset --hard'},{},'three')).deny,/declined/);
 assert.equal(w.asks,2);
});

test('scratch files and rebuildable folders are routine; Docker-wrapped and optional rules reach the gate',async t=>{
 const {w,ctx}=await fresh(t);
 for(const event of [{tool:'Bash',command:REMOVE+' node_modules dist'},{tool:'Bash',command:REMOVE+' /tmp/court-scratch-test'},
  {tool:'Write',file_path:'/tmp/court-scratch-test/a.txt'},{tool:'Bash',command:'pip install -r requirements.txt'},
  {tool:'Bash',command:'git commit -m x'},{tool:'Bash',command:'docker compose exec app php artisan migrate'}]){
  assert.equal(await enforceTool(w.$,ctx,event,{},'req'),null,event.command || event.file_path);
 }
 assert.equal(w.asks,0);
 assert.match((await enforceTool(w.$,ctx,{tool:'Bash',command:'docker compose exec app php artisan migrate:fresh'},{},'req')).deny,/declined/);
 assert.match((await enforceTool(w.$,ctx,{tool:'Bash',command:"bash -c '"+REMOVE+" storage'"},{},'req')).deny,/declined/);
 assert.equal(w.asks,2);
 await saveProjectSettings(w.$,ctx,{...await loadProjectSettings(w.$,ctx),enabledRules:['db.migrate'],
  rules:[{id:'user:push',action:'bash.command',target:'git push*',effect:'deny'}]});
 assert.match((await enforceTool(w.$,ctx,{tool:'Bash',command:'docker compose exec app php artisan migrate'},{},'req')).deny,/declined/);
 assert.match((await enforceTool(w.$,ctx,{tool:'Bash',command:'cd api && git push origin main'},{},'req')).deny,/denied by rule: user:push/);
 assert.equal(w.asks,3);
});

test('a detained agent type is restarted on another model; a detained run cannot spawn or resume',async t=>{
 const {w,ctx}=await fresh(t,[{...secret,effect:'jail'}]);
 discipline.rememberCitizen(ctx,'dev-1',identity());
 const input={subagentType:'developer',prompt:'Build the feature.',tool_use_id:'toolu_spawn'};
 assert.deepEqual(await enforceSpawn(w.$,ctx,input,identity(null)),{input},'nothing detained: unchanged');
 await enforceTool(w.$,ctx,write(w,'dev-1'),{},'one');
 const replaced=await enforceSpawn(w.$,ctx,input,identity(null));
 assert.equal(replaced.input.model,'opus');
 assert.match(replaced.input.prompt,/^Build the feature\.\n\n\[Agent Arbiter notice: an earlier "developer" agent was detained.*user:secret/s);
 assert.equal(replaced.replacement.violationIds.length,1);
 assert.match(discipline.takeSpawnNote('toolu_spawn'),/"developer" on claude-sonnet-5-5 is detained.*started on opus instead/);
 assert.equal(discipline.takeSpawnNote('toolu_spawn'),null);
 // Asking for a model that is not detained is left alone; asking for the detained one is not.
 assert.equal((await enforceSpawn(w.$,ctx,{...input,model:'haiku'},identity(null))).input.model,'haiku');
 assert.equal((await enforceSpawn(w.$,ctx,{...input,model:'sonnet'},identity(null))).input.model,'opus');
 // Another agent type, or a changed definition, is a different citizen.
 assert.equal((await enforceSpawn(w.$,ctx,{...input,subagentType:'tester'},{...identity(null),name:'tester'})).input.model,undefined);
 assert.equal((await enforceSpawn(w.$,ctx,input,{...identity(null),definitionHash:'e'.repeat(64)})).input.model,undefined);
 assert.match((await enforceSpawn(w.$,ctx,{...input,parentAgentId:'dev-1'},identity(null))).deny,/detained agent cannot start/);
 assert.match((await enforceSpawn(w.$,ctx,{...input,resume:{agentId:'dev-1'}},identity(null))).deny,/cannot be resumed/);
 assert.deepEqual(await enforceSpawn(w.$,ctx,{...input,resume:{agentId:'dev-2'}},identity(null)),{input:{...input,resume:{agentId:'dev-2'}}});
});

test('release frees the run and the agent type; only a person can release',async t=>{
 const {w,ctx}=await fresh(t,[{...secret,effect:'jail'}]);
 discipline.rememberCitizen(ctx,'dev-1',identity());
 await enforceTool(w.$,ctx,write(w,'dev-1'),{},'one');
 assert.match((await w.command('release all','sdk')).text,/Human composer/);
 assert.equal((await discipline.disciplineState(w.$,ctx,true)).violations[0].status,'active');
 const listed=(await w.command('docket')).text.split('\n');
 assert.equal(listed.length,2);
 assert.match(listed[1],/^([a-f0-9]{12}) · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · developer@claude-sonnet-5-5 · detained \(-30\) · user:secret · in effect$/);
 assert.match((await w.command('release '+listed[1].slice(0,12)+' The write was approved by me')).text,/^Released 1 violation/);
 assert.match((await w.command('docket')).text,/released: The write was approved by me$/);
 assert.equal(await enforceTool(w.$,ctx,{tool:'Read',file_path:w.root+'/a',agentId:'dev-1'},{},'two'),null);
 assert.equal((await enforceSpawn(w.$,ctx,{subagentType:'developer',prompt:'x'},identity(null))).input.model,undefined);
 assert.match((await w.command('release all')).text,/No active violation/);
 const events=(await readProject(w.$,ctx)).events;
 assert.equal(events.filter(event=>event.kind==='discipline.released').length,1);
});

test('a violation still counts in this process when the ledger cannot be written',async t=>{
 const {w,ctx}=await fresh(t,[secret]);
 const broken={...ctx,authError:true};
 assert.match((await enforceTool(w.$,broken,write(w,'dev-1'),{},'one')).deny,/fine/);
 assert.match((await enforceTool(w.$,broken,write(w,'dev-1'),{},'two')).deny,/now detained/);
 assert.match((await enforceTool(w.$,broken,{tool:'Bash',command:'ls',agentId:'dev-1'},{},'three')).deny,/is detained/);
});

test('reducer: terms expire, releases need a human origin, replacement never repeats a detained model',()=>{
 const projectId='p'.repeat(64),at=1_000_000;
 const event=(id,kind,data,occurredAt=at)=>({id,projectId,sessionId:'s',agentId:'a',kind,occurredAt,data});
 const citizen={id:null,name:'developer',model:'claude-opus-5-5',definition:'def'};
 const events=[event('v1','discipline.violation',{sanction:'detain',ruleIds:['x'],citizen}),
  event('v2','discipline.violation',{sanction:'fine',ruleIds:['x'],citizen}),
  event('v3','discipline.violation',{sanction:'invented',ruleIds:['x']}),
  event('r1','discipline.released',{violationIds:['v2'],source:{origin:'sdk'}})];
 let state=discipline.reduceDiscipline(events,projectId,at+1);
 assert.deepEqual(state.violations.map(record=>[record.id,record.status]),[['v1','active'],['v2','active']]);
 assert.equal(discipline.jailed(state,'def').length,1);
 state=discipline.reduceDiscipline(events,projectId,at+discipline.JAIL_TERM_MS);
 assert.equal(state.violations[0].status,'served');assert.equal(discipline.jailed(state,'def').length,0);
 state=discipline.reduceDiscipline([...events,event('r2','discipline.released',{violationIds:['v1'],source:{origin:'ui'}})],projectId,at+1);
 assert.equal(state.violations[0].status,'released');
 assert.equal(discipline.reduceDiscipline(events,'other',at).violations.length,0);
 assert.deepEqual(discipline.pickReplacement(['claude-opus-5-5']),{model:'sonnet'});
 assert.deepEqual(discipline.pickReplacement(['claude-sonnet-5-5']),{model:'opus'});
 assert.deepEqual(discipline.pickReplacement(['claude-fable-5-2']),{model:'opus'});
 assert.deepEqual(discipline.pickReplacement(['claude-sonnet-5-5','claude-opus-5-5']),{model:'haiku'});
 assert.deepEqual(discipline.pickReplacement(['claude-sonnet-5-5','claude-opus-5-5','claude-haiku-5-5']),{});
 assert.deepEqual(discipline.pickReplacement(['claude-sonnet-5-5'],'claude-opus-5-5'),{keep:true});
 assert.deepEqual(discipline.pickReplacement([null],'sonnet'),{model:'opus'});
});

test('approval dialog names the agent, the command and the rule in the chosen language',async t=>{
 const {setLanguage,currentLanguage,t:text}=await import('../extension/hooks/i18n.js');
 t.after(()=>setLanguage('en'));
 assert.equal(setLanguage('auto','vi_VN.UTF-8'),'vi');assert.equal(setLanguage('auto','en_US.UTF-8'),'en');
 assert.equal(setLanguage('auto',''),'en');assert.equal(setLanguage('fr','vi_VN'),'vi');
 assert.equal(text('missing.key'),'missing.key');
 const {w,ctx}=await fresh(t);discipline.rememberCitizen(ctx,'dev-1',identity());
 let seen;w.$.ui.ask=async(question,options)=>{seen={question,options};return options[0]};
 setLanguage('vi');assert.equal(currentLanguage(),'vi');
 assert.equal(await enforceTool(w.$,ctx,{tool:'Bash',command:REMOVE+' scratch',agentId:'dev-1'},{},'one'),null);
 assert.deepEqual(seen.options,['Cho phép','Cho phép luật này trong session','Từ chối']);
 for(const part of ['Agent developer (claude-sonnet-5-5)','Lệnh: '+REMOVE+' scratch','Luật: Xoá file hoặc thư mục','fs.remove on scratch.'])assert.ok(seen.question.includes(part),part+' in '+seen.question);
 setLanguage('en');
 await enforceTool(w.$,ctx,{tool:'Bash',command:'git reset --hard'},{},'two');
 assert.deepEqual(seen.options,['Allow','Allow this rule for the session','Deny']);
 assert.match(seen.question,/The main agent wants to: git\.reset-hard on \*\.\nCommand: git reset --hard\nRule: Hard reset\./);
 // A secret in the command is masked before it reaches the dialog.
 await enforceTool(w.$,ctx,{tool:'Bash',command:'TOKEN=abc password=hunter2 '+REMOVE+' scratch2'},{},'three');
 assert.ok(!seen.question.includes('hunter2'),seen.question);
});

test('replacement validation rejects alias collision, missing actual model and unresolved aliases',()=>{
 assert.equal(typeof discipline.replacementAllowed,'function');
 const policy={blockedModels:['claude-sonnet-5-5']};
 assert.equal(discipline.replacementAllowed(policy,'claude-sonnet-5-5'),false);
 assert.equal(discipline.replacementAllowed(policy,null),false);
 for(const value of ['opus','latest','unspecified','   ','*','unknown-model','claude sonnet'])assert.equal(discipline.replacementAllowed(policy,value),false,value);
 assert.equal(discipline.replacementAllowed(policy,'claude-opus-5-5'),true);
});
