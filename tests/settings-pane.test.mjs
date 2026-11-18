import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {world} from './fixtures.mjs';
import {observationContext} from '../extension/hooks/context.js';
import {openRulesPane,registerRulesPane} from '../extension/hooks/rules-pane.js';
import {loadProjectSettings,saveProjectSettings} from '../extension/hooks/project-rules.js';
import {currentEnforcement,setMasterEnabled} from '../extension/hooks/controls.js';
import {publish,digest} from '../extension/hooks/ledger.js';
import {setLanguage} from '../extension/hooks/i18n.js';
import {emit,readProject} from '../extension/hooks/events.js';
import {recordViolation,disciplineState,resetDiscipline,rememberCitizen} from '../extension/hooks/discipline.js';

async function pane(t,tab='settings'){
 setMasterEnabled(true);setLanguage('en');resetDiscipline();t.after(()=>{setMasterEnabled(true);setLanguage('en');});
 const w=await world(t),ctx=await observationContext(w.$),hooks=[];
 const configs=new Map([
  ['agent-arbiter.enabled',{key:'agent-arbiter.enabled',kind:'boolean',value:true,isLocked:false}],
  ['agent-arbiter.language',{key:'agent-arbiter.language',kind:'choice',value:'en',isLocked:false,options:['auto','en','vi']}],
 ]);
 w.$.config={list:async()=>[...configs.values()],set:async({key,value})=>{configs.get(key).value=value;return {value};}};
 const types=Object.fromEntries(['Box','Text','Button','Input','Select'].map(type=>[type,props=>({type,props})]));
 const flatten=node=>[node,...(Array.isArray(node?.props?.children)?node.props.children:[node?.props?.children]).flat(Infinity).filter(x=>x&&typeof x==='object').flatMap(flatten)];
 let nodes=[];
 w.$.ui={...w.$.ui,resolve:()=>types,invalidate:()=>{},open:async()=>({isPlaced:true}),status:()=>{}};
 registerRulesPane((...args)=>{hooks.push(args);return {catch(){}};});
 const render=hooks.find(([event])=>event==='ui.render').at(-1);
 const draw=async()=>{nodes=flatten(await render(w.$,{component:'Pane',requestId:'arbiter-rules',surface:'desktop'},()=>null));};
 const find=key=>nodes.find(n=>n.props?.key===key);
 const first=prefix=>nodes.find(n=>typeof n.props?.key==='string' && n.props.key.startsWith(prefix))?.props.key;
 const press=async key=>{assert.ok(find(key),`missing button ${key}`);await find(key).props.onPress();await draw();};
 const select=async(key,value)=>{assert.ok(find(key),`missing select ${key}`);await find(key).props.onSelect(value);await draw();};
 const input=async(key,value)=>{assert.ok(find(key),`missing input ${key}`);await find(key).props.onInput(value);await draw();};
 const text=()=>nodes.filter(n=>n.type==='Text').map(n=>n.props.children).join('\n');
 await openRulesPane(w.$,ctx,tab);await draw();
 return {...w,ctx,configs,draw,find,first,press,select,input,text};
}

test('bare arbiter opens the settings pane; old rules shortcut still opens rules',async t=>{
 const p=await pane(t);assert.ok(p.find('court-mode'));
 const answer=await p.command('');assert.match(answer?.text ?? '',/panel opened/i);
 await p.draw();assert.ok(p.find('court-mode'));
 await p.command('rules');await p.draw();assert.ok(p.find('new-rule'));
});

test('help directs normal users to the pane while preserving advanced command help',async t=>{
 const p=await pane(t);assert.match((await p.command('help')).text,/Open \/arbiter/);
 assert.match((await p.command('help advanced')).text,/hardened/);
});

test('pane exposes global config, rejects locked/denied writes, and applies language without losing project preferences',async t=>{
 const p=await pane(t);assert.ok(p.find('global-enabled'));assert.ok(p.find('global-language'));
 p.configs.get('agent-arbiter.enabled').isLocked=true;await p.draw();await p.press('global-enabled');
 assert.equal(p.configs.get('agent-arbiter.enabled').value,true);assert.match(p.text(),/locked/i);
 p.configs.get('agent-arbiter.enabled').isLocked=false;
 const set=p.$.config.set;p.$.config.set=async()=>({deny:'managed policy'});
 await p.press('global-enabled');assert.match(p.text(),/managed policy/);assert.equal(p.configs.get('agent-arbiter.enabled').value,true);
 p.$.config.set=set;await p.select('global-language','vi');assert.match(p.text(),/Bảng điều khiển|Chỉ ghi nhận/);
 assert.equal((await loadProjectSettings(p.$,p.ctx)).mode,'observe');
});

test('turning enforcement back on in the pane clears emergency off and changes only this project',async t=>{
 const p=await pane(t);await p.command('off');assert.equal((await currentEnforcement(p.$,p.ctx)).mode,'off');
 const other={...p.ctx,projectId:'a'.repeat(64)};await saveProjectSettings(p.$,other,{mode:'observe'});
 await p.select('court-mode','enforce');assert.equal((await currentEnforcement(p.$,p.ctx)).mode,'enforce');
 assert.equal((await loadProjectSettings(p.$,other)).mode,'observe');
});

test('settings switches persist, and resetting rules keeps judge, lessons, experiment and role preferences',async t=>{
 const p=await pane(t);await p.press('toggle-judge');await p.press('toggle-lessons');await p.press('toggle-experiment');
 await saveProjectSettings(p.$,p.ctx,{...await loadProjectSettings(p.$,p.ctx),roles:{coder:'dev'},rules:[{id:'user:x',action:'file.write',target:'x',effect:'deny'}]});
 await p.press('show-maintenance');await p.press('reset-rules');await p.press('cancel-confirm');
 assert.equal((await loadProjectSettings(p.$,p.ctx)).rules.length,1);
 await p.press('reset-rules');await p.press('confirm-reset');
 const prefs=await loadProjectSettings(p.$,p.ctx);assert.deepEqual(prefs.roles,{coder:'dev'});assert.equal(prefs.judge,false);assert.equal(prefs.lessons,false);assert.equal(prefs.lessonExperiment,true);assert.deepEqual(prefs.rules,[]);
});

test('reset does not overwrite valid preferences when reading them fails temporarily',async t=>{
 const p=await pane(t);await saveProjectSettings(p.$,p.ctx,{mode:'off',judge:false,roles:{coder:'review'}});
 const path=`${p.ctx.archiveRoot}/projects/${p.ctx.projectId}/preferences.json`,before=await fs.readFile(path,'utf8'),read=p.$.fs.read;
 p.$.fs.read=async path=>{if(path.endsWith('preferences.json'))throw new Error('temporary read outage');return read(path);};
 await p.draw();await p.press('reset-rules');await p.press('confirm-reset');
 assert.equal(await fs.readFile(path,'utf8'),before);assert.match(p.text(),/temporary read outage/);
});

test('explicit recovery can reset an oversized corrupt preference file',async t=>{
 const p=await pane(t),path=`${p.ctx.archiveRoot}/projects/${p.ctx.projectId}/preferences.json`;
 await fs.writeFile(path,'x'.repeat(130*1024));await p.draw();await p.press('reset-rules');await p.press('confirm-reset');
 assert.equal((await loadProjectSettings(p.$,p.ctx)).mode,'enforce');assert.deepEqual((await loadProjectSettings(p.$,p.ctx)).rules,[]);
});

test('diagnostics are explicit refreshes, and purge cancellation changes neither ledger nor preferences',async t=>{
 const p=await pane(t);await emit(p.$,p.ctx,null,'session.start','s',{});
 await p.press('refresh-diagnostics');assert.match(p.text(),/Events: 1/);
 let scans=0;const list=p.$.fs.list;p.$.fs.list=async path=>{if(path.includes('/events/'))scans++;return list(path);};
 await p.draw();await p.draw();assert.equal(scans,0);
 await p.press('show-maintenance');p.$.ui.ask=async()=> 'Cancel';await p.press('purge-project');await p.press('confirm-purge-project');
 assert.match(p.text(),/Nothing was deleted/);assert.equal((await readProject(p.$,p.ctx)).events.length,1);
 assert.equal((await loadProjectSettings(p.$,p.ctx)).mode,'observe');
});

test('violations paginate, release has a reason, and release-all needs confirmation',async t=>{
 const p=await pane(t,'violations');
 for(let n=0;n<8;n++)await recordViolation(p.$,p.ctx,{agentId:'a'+n,tool_use_id:'v'+n},{ruleIds:['git.push'],reason:'prohibited'});
 await p.press('refresh-rules');assert.ok(p.find('violations-next'));await p.press('violations-next');
 assert.match(p.text(),/7–8 \/ 8/);
 await p.select('violation-filter','active');const id=p.first('release:').slice('release:'.length);const record=(await disciplineState(p.$,p.ctx,true)).violations.find(record=>record.id===id);
 await p.press('violation:'+record.id);assert.ok(p.find('back-violations'));await p.press('back-violations');
 await p.press('release:'+record.id);await p.input('release-reason','Approved after review');await p.press('confirm-release');
 const released=(await disciplineState(p.$,p.ctx,true)).violations.find(x=>x.id===record.id);assert.equal(released.status,'released');assert.equal(released.releaseReason,'Approved after review');
 await p.press('release-all');await p.press('cancel-confirm');assert.ok((await disciplineState(p.$,p.ctx,true)).violations.some(x=>x.status==='active'));
 await p.press('release-all');await p.press('confirm-release-all');assert.ok((await disciplineState(p.$,p.ctx,true)).violations.every(x=>x.status==='released'));
});

test('global disabled state stays visible even with project enforce, and global toggle works from the pane',async t=>{
 const p=await pane(t);await p.select('court-mode','enforce');await p.press('global-enabled');
 assert.equal(p.configs.get('agent-arbiter.enabled').value,false);assert.equal((await currentEnforcement(p.$,p.ctx)).mode,'off');
 assert.match(p.text(),/disabled globally/i);await p.press('global-enabled');assert.equal((await currentEnforcement(p.$,p.ctx)).mode,'enforce');
});

const identity={id:'c'.repeat(64),name:'coder',source:'userSettings',provider:null,definitionHash:'d'.repeat(64),resolvedModel:'model-a',engineVersion:'2.1.325'};
test('agent roles are editable for this project and read-only in the all-project score view',async t=>{
 const p=await pane(t,'citizens');
 await emit(p.$,p.ctx,null,'spawn.result','spawn1',{status:'started',childAgentId:'coder1',citizen:identity});await p.press('refresh-rules');
 await p.select('role:coder','review');assert.equal((await loadProjectSettings(p.$,p.ctx)).roles.coder,'review');
 await p.select('role:coder','auto');assert.deepEqual((await loadProjectSettings(p.$,p.ctx)).roles,{});
 await p.select('score-scope','all');assert.equal(p.find('role:coder'),undefined);assert.match(p.text(),/coder/);
});

test('lessons can be shared and withdrawn in the pane, while review decisions keep UI provenance',async t=>{
 const p=await pane(t,'citizens');rememberCitizen(p.ctx,'coder1',identity);
 await recordViolation(p.$,p.ctx,{agentId:'coder1',tool_use_id:'bad'},{ruleIds:['git.push'],reason:'prohibited'});
 await p.select('agent-section','lessons');
 const share=p.first('share:');
 // The list exposes stable per-record controls, without requiring an ID to be typed.
 assert.ok(share);await p.press(share);await p.press('confirm-share');
 await p.select('lesson-scope','library');assert.ok(p.first('unshare:'));await p.press(p.first('unshare:'));await p.press('confirm-unshare');
 assert.match(p.text(),/shared library is empty/i);
 const reviewId=await emit(p.$,p.ctx,'coder1','judge.review','review1',{citizen:{name:'coder',model:'model-a',definition:'d'.repeat(64)},role:'dev',difficulty:'easy',
  scores:{completeness:3},findings:[{severity:'low',dimension:'correctness',claim:'Missing verification',evidence:'Final report has no test result'}],exemplar:{worthy:false}});
 await p.select('agent-section','reviews');await p.press('review:'+reviewId);assert.ok(p.find('back-reviews'));
 assert.match(p.text(),/Final report has no test result/);await p.press('confirm:'+reviewId.slice(0,12)+'-0');
 const event=(await readProject(p.$,p.ctx)).events.find(e=>e.kind==='judge.decision');
 assert.equal(event.data.source.origin,'ui');assert.equal(event.data.decision,'confirmed');
});

test('a stale callback cannot change another project and a failed save preserves the prior mode',async t=>{
 const p=await pane(t),select=p.find('court-mode').props.onSelect;
 const root=p.$.session.root;p.$.session.root=async()=>p.root+'/another';await select('enforce');p.$.session.root=root;
 assert.equal((await loadProjectSettings(p.$,p.ctx)).mode,'observe');await p.draw();assert.match(p.text(),/project changed/i);
 const write=p.$.fs.write;p.$.fs.write=async()=>{throw Error('fixture disk unavailable')};await p.select('court-mode','enforce');
 p.$.fs.write=write;assert.equal((await loadProjectSettings(p.$,p.ctx)).mode,'observe');assert.match(p.text(),/disk unavailable/);
});

test('double-clicking a destructive confirmation runs once and project purge keeps other projects and library',async t=>{
 const p=await pane(t),other={...p.ctx,projectId:'b'.repeat(64)};
 await saveProjectSettings(p.$,other,{mode:'off'});const lib=p.ctx.archiveRoot+'/library/lessons.json';await p.$.fs.write(lib,'[]');
 await emit(p.$,p.ctx,null,'session.start','one',{});await p.press('show-maintenance');await p.press('purge-project');
 let asks=0;let resolve;const answer=new Promise(r=>{resolve=r;});p.$.ui.ask=async()=>{asks++;await answer;return 'Delete';};
 const confirm=p.find('confirm-purge-project').props.onPress,a=confirm(),b=confirm();
 await new Promise(r=>setTimeout(r,20));resolve();await Promise.all([a,b]);await p.draw();
 assert.equal(asks,1);assert.equal((await readProject(p.$,p.ctx)).events.length,0);
 assert.equal((await loadProjectSettings(p.$,other)).mode,'off');assert.equal(await p.$.fs.read(lib),'[]');
});

test('quarantine and cleanup require confirmation; default cleanup keeps decisions and cited evidence',async t=>{
 const p=await pane(t);const old=Date.now()-40*86400000;
 const id=await digest('old-routine');await publish(p.$,`${p.ctx.dataRoot}/events/${p.ctx.projectId}/${new Date(old).toISOString().slice(0,7)}`,{schemaVersion:1,id,projectId:p.ctx.projectId,sessionId:p.ctx.sessionId,agentId:null,kind:'tool.result',occurredAt:old,data:{status:'completed'}});
 await p.press('show-maintenance');await p.press('cleanup');await p.press('cancel-confirm');
 assert.equal((await readProject(p.$,p.ctx)).events.length,1);
 await p.press('cleanup');await p.press('confirm-cleanup');assert.match(p.text(),/removed: 1/);assert.equal((await readProject(p.$,p.ctx)).events.length,0);
 await p.press('quarantine');await p.press('cancel-confirm');assert.equal(p.find('confirm-quarantine'),undefined);
});

test('review pagination and a stale finding decision never overwrite a decision made elsewhere',async t=>{
 const p=await pane(t,'citizens');let id;
 for(let n=0;n<8;n++)id=await emit(p.$,p.ctx,'coder','judge.review','r'+n,{scores:{honesty:3},findings:[{severity:'low',dimension:'honesty',claim:'Claim '+n,evidence:'Evidence '+n}],exemplar:{worthy:false}});
 await p.select('agent-section','reviews');assert.ok(p.find('reviews-next'));await p.press('reviews-next');assert.match(p.text(),/7–8 \/ 8/);
 await p.press('reviews-previous');await p.press('review:'+id);const button=p.first('confirm:');assert.ok(button);
 const event=(await readProject(p.$,p.ctx)).events.find(e=>e.id===id);
 await emit(p.$,p.ctx,null,'judge.decision','elsewhere',{reviewId:event.id,finding:0,decision:'dismissed',source:{origin:'composer'}});
 await p.press(button);assert.match(p.text(),/no longer anything|nothing to decide/i);
 assert.equal((await readProject(p.$,p.ctx)).events.filter(e=>e.kind==='judge.decision').length,1);
});

test('release-all does not silently include a new violation that arrived during confirmation',async t=>{
 const p=await pane(t,'violations');
 await recordViolation(p.$,p.ctx,{agentId:'a',tool_use_id:'a'},{ruleIds:['git.push'],reason:'prohibited',detail:'first'});
 await p.press('refresh-rules');await p.press('release-all');
 await recordViolation(p.$,p.ctx,{agentId:'b',tool_use_id:'b'},{ruleIds:['git.push'],reason:'prohibited',detail:'second'});
 await p.press('confirm-release-all');assert.ok((await disciplineState(p.$,p.ctx,true)).violations.every(record=>record.status==='active'));
 assert.match(p.text(),/changed|refresh/i);
});
