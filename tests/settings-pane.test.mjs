import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {world} from './fixtures.mjs';
import {observationContext} from '../plugins/agent-arbiter/hooks/context.js';
import {openRulesPane,registerRulesPane} from '../plugins/agent-arbiter/hooks/rules-pane.js';
import {loadProjectSettings,saveProjectSettings} from '../plugins/agent-arbiter/hooks/project-rules.js';
import {currentEnforcement,setMasterEnabled} from '../plugins/agent-arbiter/hooks/controls.js';
import {publish,digest} from '../plugins/agent-arbiter/hooks/ledger.js';
import {setLanguage} from '../plugins/agent-arbiter/hooks/i18n.js';
import {emit,readProject} from '../plugins/agent-arbiter/hooks/events.js';
import {recordViolation,disciplineState,resetDiscipline,rememberCitizen} from '../plugins/agent-arbiter/hooks/discipline.js';

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
 return {...w,ctx,configs,hooks,draw,find,first,press,select,input,text};
}

test('bare arbiter opens the inbox; old rules shortcut still opens rules',async t=>{
 const p=await pane(t);assert.ok(p.find('court-mode'));
 const answer=await p.command('');assert.match(answer?.text ?? '',/panel opened/i);
 await p.draw();assert.ok(p.find('panel-inbox'));assert.equal(p.find('court-mode'),undefined);
 await p.command('rules');await p.draw();assert.ok(p.find('new-rule'));
});

test('the inbox scopes findings and detentions to this thread and honors decisions from other threads',async t=>{
 const p=await pane(t,'inbox'),other={...p.ctx,sessionId:'other-thread'};
 const findings=claim=>({scores:{honesty:2},findings:[{severity:'high',dimension:'honesty',claim,evidence:'fixture'}],exemplar:{worthy:false}});
 const current=await emit(p.$,p.ctx,'local','judge.review','here',findings('Current finding'));
 await emit(p.$,other,'remote','judge.review','there',findings('Other finding'));
 await emit(p.$,other,null,'judge.decision','decision',{reviewId:current,finding:0,decision:'confirmed',source:{origin:'ui'}});
 await recordViolation(p.$,other,{agentId:'remote',tool_use_id:'other-v'},{ruleIds:['git.push'],severe:true,reason:'fixture'});
 await p.press('refresh-rules');
 assert.match(p.text(),/Other finding/);assert.doesNotMatch(p.text(),/Current finding/);
 assert.ok(p.first('inbox-detention:'));
 await p.select('panel-scope','thread');
 assert.doesNotMatch(p.text(),/Other finding|Current finding/);
 assert.equal(p.first('inbox-detention:'),undefined);
 assert.match(p.text(),/Nothing waits on you/);
 await p.select('panel-scope','project');
 assert.match(p.text(),/Other finding/);
});

test('pin is project-bound, reopens on Desktop and honors a manual close within the session',async t=>{
 const p=await pane(t,'inbox');
 let opens=0,paneRequested=Promise.withResolvers(),desktopAttached=Promise.withResolvers();
 p.$.ui.open=async()=>{opens++;paneRequested.resolve();await desktopAttached.promise;return {isPlaced:true};};
 const attach=p.hooks.find(([name])=>name==='session.attach').at(-1);
 const close=p.hooks.find(([name])=>name==='ui.close').at(-1);
 const connect=async()=>attach(p.$,{surface:'desktop'},async()=>({clientId:'desktop'}));
 await connect();assert.equal(opens,0);
 await p.press('pin-project');assert.equal((await loadProjectSettings(p.$,p.ctx)).panelPinned,true);
 p.$.session.id=async()=> 'same-project-next-thread';
 await connect();desktopAttached.resolve();
 await paneRequested.promise;assert.equal(opens,1);
 await close(p.$,{id:'arbiter-rules',origin:{kind:'person'}},async()=>undefined);
 await connect();assert.equal(opens,1);
 p.$.session.root=async()=>p.root+'/unrelated';p.$.session.id=async()=> 'different-project';
 await connect();assert.equal(opens,1);
 p.$.session.root=async()=>p.root;p.$.session.id=async()=>p.ctx.sessionId;
 await p.draw();await p.press('pin-project');
 assert.equal(Boolean((await loadProjectSettings(p.$,p.ctx)).panelPinned),false);
});

test('help directs normal users to the pane while preserving advanced command help',async t=>{
 const p=await pane(t);assert.match((await p.command('help')).text,/Open \/arbiter/);
 assert.match((await p.command('help advanced')).text,/hardened/);
});

test('pane exposes global config, rejects locked/denied writes, and applies language without losing project preferences',async t=>{
 const p=await pane(t);assert.ok(p.find('global-enabled'));assert.ok(p.find('global-language'));
 assert.equal(p.find('global-language').props.options.find(option=>option.value==='vi').label,'Tiếng Việt');
 p.configs.get('agent-arbiter.enabled').isLocked=true;await p.draw();await p.press('global-enabled');
 assert.equal(p.configs.get('agent-arbiter.enabled').value,true);assert.match(p.text(),/locked/i);
 p.configs.get('agent-arbiter.enabled').isLocked=false;
 const set=p.$.config.set;p.$.config.set=async()=>({deny:'managed policy'});
 await p.press('global-enabled');assert.match(p.text(),/managed policy/);assert.equal(p.configs.get('agent-arbiter.enabled').value,true);
 p.$.config.set=set;await p.select('global-language','vi');assert.match(p.text(),/Chỉ quan sát/);
 assert.equal((await loadProjectSettings(p.$,p.ctx)).mode,'observe');
});

test('surfaces without plugin configuration rows explain the limitation and retain project controls',async t=>{
 const p=await pane(t);p.configs.clear();await p.draw();
 assert.match(p.text(),/Global options are unavailable/);
 assert.ok(p.find('court-mode'));assert.equal(p.find('global-enabled'),undefined);
 await p.select('court-mode','enforce');assert.equal((await loadProjectSettings(p.$,p.ctx)).mode,'enforce');
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

test('session display controls persist separately from the gate settings',async t=>{
 const p=await pane(t);
 await p.press('progress-checklist');
 await p.press('progress-effects');
 await p.press('progress-fold');
 const saved=await loadProjectSettings(p.$,p.ctx);
 assert.equal(saved.checklist,true);
 assert.equal(saved.effects,false);
 assert.equal(saved.foldAgentStrips,true);
 assert.equal(saved.mode,'observe');
 assert.ok(p.find('progress-update'));
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

test('refresh is beside status and only shows ledger health inside Data; purge cancellation preserves data',async t=>{
 const p=await pane(t);await emit(p.$,p.ctx,null,'session.start','s',{});
 assert.equal(p.find('refresh-diagnostics'),undefined);
 assert.ok(p.find('panel-status').props.children.some(child=>child.props?.key==='refresh-rules'));
 await p.press('refresh-rules');assert.doesNotMatch(p.text(),/Events:/);
 await p.press('show-maintenance');await p.press('refresh-rules');assert.match(p.text(),/Events: 1/);
 assert.doesNotMatch(p.text(),/Mode:/);
 let scans=0;const list=p.$.fs.list;p.$.fs.list=async path=>{if(path.includes('/events/'))scans++;return list(path);};
 await p.draw();await p.draw();assert.equal(scans,0);
 p.$.ui.ask=async()=> 'Cancel';await p.press('purge-project');await p.press('confirm-purge-project');
 assert.match(p.text(),/Nothing was deleted/);assert.equal((await readProject(p.$,p.ctx)).events.length,1);
 assert.equal((await loadProjectSettings(p.$,p.ctx)).mode,'observe');
});

test('saving a preference keeps settings mounted and skips a ledger scan',async t=>{
 const p=await pane(t),original=p.$.fs.write;
 await p.press('refresh-rules');
 let scans=0;const list=p.$.fs.list;
 p.$.fs.list=async path=>{if(path.includes('/events/'))scans++;return list(path);};
 const entered=Promise.withResolvers(),resume=Promise.withResolvers();
 p.$.fs.write=async(path,value)=>{
  if(path.includes('/preferences.json.')){entered.resolve();await resume.promise;}
  return original(path,value);
 };
 const save=p.find('toggle-judge').props.onPress();
 await entered.promise;
 try{
  await p.draw();assert.ok(p.find('global-language'));assert.ok(p.find('toggle-lessons'));
  assert.match(p.text(),/Saving/);assert.doesNotMatch(p.text(),/Events:/);
 }finally{resume.resolve();await save;}
 await p.draw();assert.equal((await loadProjectSettings(p.$,p.ctx)).judge,false);assert.equal(scans,0);
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
  scores:{completeness:3},findings:[{severity:'medium',dimension:'correctness',claim:'Missing verification',evidence:'Final report has no test result'}],exemplar:{worthy:false}});
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
 for(let n=0;n<8;n++)id=await emit(p.$,p.ctx,'coder','judge.review','r'+n,{scores:{honesty:3},findings:[{severity:'medium',dimension:'honesty',claim:'Claim '+n,evidence:'Evidence '+n}],exemplar:{worthy:false}});
 await p.select('agent-section','reviews');assert.ok(p.find('reviews-next'));await p.press('reviews-next');assert.match(p.text(),/7–8 \/ 8/);
 assert.equal(p.find('reviews-previous').props.label,'‹');
 assert.equal(p.find('pager-reviews').props.justifyContent,'center');
 assert.equal(p.find('reviews-next'),undefined);
 await p.press('reviews-previous');await p.press('review:'+id);const button=p.first('confirm:');assert.ok(button);
 const event=(await readProject(p.$,p.ctx)).events.find(e=>e.id===id);
 await emit(p.$,p.ctx,null,'judge.decision','elsewhere',{reviewId:event.id,finding:0,decision:'dismissed',source:{origin:'composer'}});
 await p.press(button);assert.match(p.text(),/no longer anything|nothing to decide/i);
 assert.equal((await readProject(p.$,p.ctx)).events.filter(e=>e.kind==='judge.decision').length,1);
});

test('Vietnamese reviews translate the current page without changing the source finding',async t=>{
 const p=await pane(t,'citizens');
 await emit(p.$,p.ctx,'agent','judge.review','translation-fixture',{scores:{correctness:3},
  findings:[{severity:'high',dimension:'correctness',claim:'Pagination skips a row.',evidence:'The review fixture proves the skipped row.'}],exemplar:{worthy:false}});
 await p.select('agent-section','reviews');
 assert.equal(p.find('translate-reviews'),undefined);
 setLanguage('vi');
 await p.draw();
 const translation=p.find('translate-reviews');
 assert.equal(translation.props.label,'Dịch');
 p.$.model={complete:async()=>({isAnswered:false})};
 await p.press('translate-reviews');
 for(let n=0;n<100;n++){
  await p.draw();
  if(p.text().includes('Model chưa trả bản dịch hợp lệ.'))break;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 assert.match(p.text(),/Model chưa trả bản dịch hợp lệ/);
 assert.match(p.text(),/Pagination skips a row/);
 p.$.model.complete=async({prompt})=>({isAnswered:true,text:prompt});
 await p.press('translate-reviews');
 for(let n=0;n<100 && !p.find('review-translation-message');n++){
  await new Promise(resolve=>setTimeout(resolve,5));
  await p.draw();
 }
 assert.match(p.find('review-translation-message')?.props.children ?? '',/Bản dịch giữ nguyên nội dung/);
 p.$.model={complete:async({model,prompt})=>{
  assert.equal(model,'haiku');
  assert.deepEqual(JSON.parse(prompt),['Pagination skips a row.','The review fixture proves the skipped row.']);
  return {isAnswered:true,text:'["Phân trang bỏ sót một dòng.","Bằng chứng cho thấy dòng bị bỏ sót."]'};
 }};
 assert.equal(translation.props.onPress(),undefined,'press acknowledges before the model returns');
 for(let n=0;n<100;n++){
  await p.draw();
  if(p.text().includes('Đã dịch 2 câu.'))break;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 assert.match(p.text(),/Phân trang bỏ sót một dòng/);
 const [review]=(await readProject(p.$,p.ctx)).events.filter(e=>e.kind==='judge.review');
 assert.equal(review.data.findings[0].claim,'Pagination skips a row.');
});

test('release-all does not silently include a new violation that arrived during confirmation',async t=>{
 const p=await pane(t,'violations');
 await recordViolation(p.$,p.ctx,{agentId:'a',tool_use_id:'a'},{ruleIds:['git.push'],reason:'prohibited',detail:'first'});
 await p.press('refresh-rules');await p.press('release-all');
 await recordViolation(p.$,p.ctx,{agentId:'b',tool_use_id:'b'},{ruleIds:['git.push'],reason:'prohibited',detail:'second'});
 await p.press('confirm-release-all');assert.ok((await disciplineState(p.$,p.ctx,true)).violations.every(record=>record.status==='active'));
 assert.match(p.text(),/changed|refresh/i);
});

test('thread release-all leaves another thread’s active violation alone',async t=>{
 const p=await pane(t,'violations'),other={...p.ctx,sessionId:'other-thread'};
 await recordViolation(p.$,p.ctx,{agentId:'here',tool_use_id:'here'},{ruleIds:['git.push'],reason:'fixture'});
 await recordViolation(p.$,other,{agentId:'there',tool_use_id:'there'},{ruleIds:['git.push'],reason:'fixture'});
 await p.select('panel-scope','thread');
 await p.press('release-all');
 assert.match(p.text(),/in this thread/);
 await p.press('confirm-release-all');
 const records=(await disciplineState(p.$,p.ctx,true)).violations;
 assert.equal(records.find(row=>row.sessionId===p.ctx.sessionId).status,'released');
 assert.equal(records.find(row=>row.sessionId===other.sessionId).status,'active');
});

test('a finding is answered from the list without leaving it, and auto review records the model\'s answers as automatic',async t=>{
 const p=await pane(t,'citizens');
 const review=async(key,claim)=>emit(p.$,p.ctx,'coder1','judge.review',key,{citizen:{name:'coder',model:'model-a',definition:'d'.repeat(64)},role:'dev',difficulty:'easy',
  scores:{completeness:3},findings:[{severity:'medium',dimension:'correctness',claim,evidence:'src/a.js'}],exemplar:{worthy:false},evidence:{files:['src/a.js']}});
 const one=await review('r1','Off by one'),two=await review('r2','Null not handled'),three=await review('r3','Maybe slow');
 await p.select('agent-section','reviews');
 await p.press('dismiss:'+one.slice(0,12)+'-0');
 assert.ok(!p.find('back-reviews'),'still on the list');assert.match(p.text(),/Recorded/);
 const answers={'Null not handled':'confirmed','Maybe slow':'unsure'},asked=[];
 let finishFirst, firstStarted;
 const firstCall=new Promise(resolve=>{firstStarted=resolve;});
 const waitForFirst=new Promise(resolve=>{finishFirst=resolve;});
 p.$.model={complete:async({prompt,model})=>{
  asked.push(model);
  if(asked.length===1){firstStarted();await waitForFirst;}
  const claim=/claim: (.*)/.exec(prompt)[1];return {isAnswered:true,text:JSON.stringify({decision:answers[claim],why:'checked'})};
 }};
 await p.press('tab-settings');await p.select('judge-model','sonnet');assert.equal((await loadProjectSettings(p.$,p.ctx)).judgeModel,'sonnet');
 await p.press('tab-citizens');await p.select('agent-section','reviews');
 const button=p.find('auto-review').props.onPress;
 const acknowledged=button();
 try {
  assert.equal(acknowledged,undefined,'press must return before waiting for the model');
  await firstCall;
  button();
  assert.deepEqual(asked,['sonnet'],'a second press cannot start another batch');
  await p.draw();
  assert.match(p.text(),/Reviewing on its own 0\/2/);
 } finally {
  finishFirst();
 }
 for(let n=0;n<100;n++){
  await p.draw();
  if(p.text().includes('1 correct, 0 wrong, 1 left for you'))break;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 assert.deepEqual(asked,['sonnet','sonnet'],'the chosen judge model checks each waiting finding');
 const decisions=(await readProject(p.$,p.ctx)).events.filter(e=>e.kind==='judge.decision');
 const auto=decisions.find(e=>e.data.source.auto);
 assert.equal(decisions.length,2);assert.equal(auto.data.reviewId,two);assert.equal(auto.data.decision,'confirmed');
 assert.equal(auto.data.source.origin,'ui');assert.equal(auto.data.source.model,'sonnet');
 assert.ok(p.find('confirm:'+three.slice(0,12)+'-0'),'what the model could not tell stays for the person');
 assert.match(p.text(),/1 correct, 0 wrong, 1 left for you/);
 assert.equal(p.find('auto-review'),undefined,'an inconclusive finding belongs to manual review');
 assert.match(p.find('review-manual-count').props.children,/1.*manual review/i);
 await review('r4','Retryable finding');
 await p.press('refresh-rules');
 p.$.model.complete=async()=>({isAnswered:false});
 await p.press('auto-review');
 for(let n=0;n<100;n++){
  await p.draw();
  if(p.text().includes('could not be processed and are still waiting'))break;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 assert.match(p.text(),/1 could not be processed and are still waiting/);
 assert.match(p.text(),/The model did not return a usable answer/);
 assert.ok(p.find('confirm:'+three.slice(0,12)+'-0'));
 assert.match(p.find('auto-review').props.label,/retry.*1/i);
 assert.equal((await readProject(p.$,p.ctx)).events.filter(e=>e.kind==='judge.decision').length,2);
});

test('Inbox translates the visible finding and its auto-review explanation',async t=>{
 const p=await pane(t,'inbox');
 const claim='The report omits the reconciliation result.';
 const evidence='Only the summary was recorded.';
 const why='The available evidence cannot resolve the finding.';
 await emit(p.$,p.ctx,'coder','judge.review','inbox-translation',{scores:{honesty:3},
  findings:[{severity:'medium',dimension:'honesty',claim,evidence}],exemplar:{worthy:false}});
 setLanguage('vi');
 await p.press('refresh-rules');
 p.$.model={complete:async()=>({isAnswered:true,text:JSON.stringify({decision:'unsure',why})})};
 await p.press('auto-review');
 for(let n=0;n<100 && !p.find('review-auto-summary');n++){
  await new Promise(resolve=>setTimeout(resolve,5));
  await p.draw();
 }
 assert.match(p.find('review-auto-summary')?.props.children ?? '',/1 để bạn xem/);
 assert.match(p.text(),/available evidence/);
 const phrases=new Map([[claim,'Báo cáo thiếu kết quả đối soát.'],[evidence,'Chỉ có phần tóm tắt.'],
  [why,'Bằng chứng hiện có chưa đủ để kết luận.']]);
 p.$.model.complete=async({prompt})=>({isAnswered:true,text:JSON.stringify(JSON.parse(prompt).map(text=>phrases.get(text)))});
 await p.press('translate-reviews');
 for(let n=0;n<100 && !p.find('review-translation-message');n++){
  await new Promise(resolve=>setTimeout(resolve,5));
  await p.draw();
 }
 assert.match(p.find('review-translation-message')?.props.children ?? '',/Đã dịch 3 câu/);
 assert.match(p.text(),/Báo cáo thiếu kết quả đối soát/);
 assert.match(p.text(),/Bằng chứng hiện có chưa đủ để kết luận/);
 await p.press('translate-reviews');
 assert.match(p.find('review-translation-message')?.props.children ?? '',/Đã dịch/);
 assert.equal((await readProject(p.$,p.ctx)).events.filter(event=>event.kind==='judge.decision').length,0);
});

test('session history shows the agents a session sent and opens one to what it did',async t=>{
 const p=await pane(t,'citizens');
 await emit(p.$,p.ctx,null,'spawn.request','a1',{agentType:'court-coder',spawnAttemptId:'att1'});
 await emit(p.$,p.ctx,null,'spawn.result','att1',{spawnAttemptId:'att1',childAgentId:'kid1',status:'started',citizen:{name:'court-coder',resolvedModel:'claude-sonnet-5-5'},profile:{runRole:'dev',difficulty:'easy'}});
 await emit(p.$,p.ctx,'kid1','tool.request','call1',{tool:'Edit',toolCallId:'call1'});
 await emit(p.$,p.ctx,'kid1','turn.complete','turn1',{durationMs:42000,isAborted:false,reason:'answer',model:'claude-sonnet-5-5'});
 await p.select('agent-section','history');
 assert.ok(p.find('run:main'));assert.match(p.text(),/court-coder/);assert.match(p.text(),/done · 42s · 1 call/);
 await p.press('run:kid1');
 assert.ok(p.find('back-history'));assert.match(p.text(),/Tools used: Edit 1/);assert.match(p.text(),/No violation/);
});
