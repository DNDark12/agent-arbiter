import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);

async function rules() { return import('../plugins/agent-arbiter/hooks/project-rules.js'); }
async function fixture(t) {
 const archiveRoot=await fs.mkdtemp(join(tmpdir(),'arbiter-rules-'));t.after(()=>fs.rm(archiveRoot,{recursive:true,force:true}));
 const ctx={archiveRoot,projectId:'fixture-project'};
 const $={clock:{sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))},process:{run:async argv=>{try{return {exitCode:0,...await exec(argv[0],argv.slice(1))}}catch(e){if(typeof e.code!=='number')throw e;return {exitCode:e.code}}}},fs:{exists:async p=>{try{await fs.stat(p);return true}catch(e){if(e.code==='ENOENT')return false;throw e}},read:p=>fs.readFile(p,'utf8'),write:async(p,s)=>{await fs.mkdir(dirname(p),{recursive:true});await fs.writeFile(p,s)}}};
 return {$,ctx,path:join(archiveRoot,'projects','fixture-project','preferences.json')};
}

test('fresh projects enforce built-ins without authentication or setup',async t=>{
 const {loadProjectSettings,listRules,matchRules}=await rules();const {$,ctx}=await fixture(t);
 const settings=await loadProjectSettings($,ctx);
 assert.deepEqual(settings,{mode:'enforce',hardened:false,disabledRules:[],enabledRules:[],rules:[],lessons:true,judge:true,lessonExperiment:false,roles:{}});
 assert.equal(listRules(settings).length,16);
 for(const action of ['deploy.publish','exec.remote','system.sudo'])assert.equal(matchRules([{action,target:'*'}],settings).effect,'ask',action);
 assert.equal(matchRules([{action:'git.force-push',target:'origin/main'}],settings).effect,'ask');
 // Arbiter data is denied; Claude settings and agent definitions only ask.
 assert.equal(matchRules([{action:'file.arbiter',target:'/court/data'}],settings).effect,'deny');
 assert.equal(matchRules([{action:'file.protected',target:'/home/.claude/settings.json'}],settings).effect,'ask');
 assert.equal(matchRules([{action:'file.write',target:'src/main.js'}],settings).effect,'allow');
});

test('settings persist independently per project and external same-size edits are read',async t=>{
 const {loadProjectSettings,saveProjectSettings}=await rules();const {$,ctx,path}=await fixture(t);
 await saveProjectSettings($,ctx,{mode:'observe',hardened:false,disabledRules:['fs.remove'],rules:[]});
 assert.equal((await loadProjectSettings($,ctx)).mode,'observe');
 assert.equal((await loadProjectSettings($,{...ctx,projectId:'another-project'})).mode,'enforce');
 const raw=await fs.readFile(path,'utf8');await fs.writeFile(path,raw.replace('observe','enforce'));
 assert.equal((await loadProjectSettings($,ctx)).mode,'enforce');
 await saveProjectSettings($,ctx,{mode:'off',hardened:true,disabledRules:[],rules:[]});
 assert.equal((await loadProjectSettings($,ctx)).hardened,true);
});

test('disabled built-ins and custom normalized glob rules affect only their target',async()=>{
 const {matchRules,listRules}=await rules();
 const settings={mode:'enforce',hardened:false,disabledRules:['fs.remove'],rules:[
  {id:'user:one',action:'file.write',target:'src/*.js',effect:'ask'},
  {id:'user:two',action:'file.write',target:'private/**',effect:'deny'}]};
 assert.equal(listRules(settings).find(r=>r.id==='fs.remove').enabled,false);
 assert.equal(matchRules([{action:'fs.remove',target:'tmp/a'}],settings).effect,'allow');
 assert.equal(matchRules([{action:'file.write',target:'./src/x/../main.js'}],settings).effect,'ask');
 assert.equal(matchRules([{action:'file.write',target:'src/nested/main.js'}],settings).effect,'allow');
 assert.equal(matchRules([{action:'file.write',target:'/project/src/main.js',relativeTarget:'src/main.js'}],settings).effect,'ask');
 assert.equal(matchRules([{action:'file.write',target:'private/nested/a.js'}],settings).effect,'deny');
 assert.equal(matchRules([{action:'file.write',target:'private\\nested\\a.js'}],settings).effect,'deny');
 assert.equal(matchRules([{action:'file.write',target:'src/main.js'},{action:'file.write',target:'private/a'}],settings).effect,'deny');
});

test('invalid preference data does not silently disable enforcement',async t=>{
 const {loadProjectSettings,saveProjectSettings}=await rules();const {$,ctx,path}=await fixture(t);
 for(const value of [{mode:'invalid'},{disabledRules:['unknown']},{rules:[{id:'x',action:'file.write',target:'**',effect:'allow'}]},{rules:[{id:'x',action:'unknown',target:'**',effect:'deny'}]},{rules:[{id:'x',action:'file.write',target:'',effect:'deny'}]}]) {
  await assert.rejects(()=>saveProjectSettings($,ctx,value));
 }
 await $.fs.write(path,'not json');await assert.rejects(()=>loadProjectSettings($,ctx));
 await assert.rejects(()=>loadProjectSettings($,{...ctx,projectId:'../escape'}));
});

function nativeSurface() {
 const constructors=Object.fromEntries(['Box','Text','Button','Input','Select'].map(type=>[type,props=>({type,props})]));
 const flatten=tree=>[tree,...(Array.isArray(tree?.props?.children)?tree.props.children:[tree?.props?.children]).flat(Infinity).filter(v=>v&&typeof v==='object').flatMap(flatten)];
 return {constructors,flatten};
}

test('native rules pane uses current settings and reports failures without stale overwrites',async t=>{
 const {openRulesPane,registerRulesPane}=await import('../plugins/agent-arbiter/hooks/rules-pane.js');
 const {loadProjectSettings,saveProjectSettings}=await rules();
 const {world}=await import('./fixtures.mjs'),{observationContext}=await import('../plugins/agent-arbiter/hooks/context.js');
 const {$}=await world(t),ctx=await observationContext($);
 const hooks=[];registerRulesPane((...args)=>{hooks.push(args);return {catch(){}}});
 const {constructors,flatten}=nativeSurface();let invalidated=0;
 $.ui={resolve:()=>constructors,open:async()=>({}),invalidate:()=>{invalidated++}};
 await openRulesPane($,ctx);const render=hooks.find(([event])=>event==='ui.render').at(-1);
 const e={component:'Pane',requestId:'arbiter-rules',surface:'desktop',props:{}};
 let nodes;const draw=async()=>{nodes=flatten(await render($,e,()=>null));};
 const press=async key=>{await nodes.find(n=>n.props?.key===key).props.onPress();await draw();};
 await draw();assert.ok(nodes.find(n=>n.props?.key==='tab-settings'));await press('tab-rules');
 const toggle=nodes.find(n=>n.props?.key==='toggle:fs.remove');
 await saveProjectSettings($,ctx,{mode:'observe',rules:[{id:'user:external',action:'file.write',target:'secret/**',effect:'deny'}]});
 await toggle.props.onPress();let saved=await loadProjectSettings($,ctx);
 assert.equal(saved.mode,'observe');assert.equal(saved.rules.length,1);assert.deepEqual(saved.disabledRules,['fs.remove']);
 await draw();await press('new-rule');
 await nodes.find(n=>n.props?.key==='rule-target').props.onInput('src/**');await draw();
 await press('add-rule');saved=await loadProjectSettings($,ctx);assert.equal(saved.rules.length,2);
 await press('delete:user:external');assert.equal((await loadProjectSettings($,ctx)).rules.length,2);
 await press('confirm-delete');assert.equal((await loadProjectSettings($,ctx)).rules.length,1);
 const write=$.fs.write;$.fs.write=async()=>{throw new Error('disk unavailable')};
 await press('new-rule');await press('add-rule');
 assert.ok(nodes.some(n=>n.type==='Text'&&String(n.props.children).includes('disk unavailable')));
 assert.ok(invalidated>=3);$.fs.write=write;
});


test('preference publication failure preserves the previous complete settings',async t=>{
 const {loadProjectSettings,saveProjectSettings}=await rules();const {$,ctx}=await fixture(t);
 await saveProjectSettings($,ctx,{mode:'observe'});
 const run=$.process.run;
 $.process.run=async argv=>argv[0]==='/bin/mv'?{exitCode:1}:run(argv);
 await assert.rejects(()=>saveProjectSettings($,ctx,{mode:'off'}));
 assert.equal((await loadProjectSettings($,ctx)).mode,'observe');
 assert.deepEqual(await fs.readdir(join(ctx.archiveRoot,'projects',ctx.projectId)),['preferences.json']);
});

test('commit, push and migrate rules are off until switched on and toggle through their own list',async()=>{
 const {listRules,matchRules,toggleBuiltin}=await rules();
 let settings={};
 for(const id of ['git.commit','git.push','db.migrate']){
  assert.equal(listRules(settings).find(rule=>rule.id===id).enabled,false,id);
  assert.equal(matchRules([{action:id,target:'*'}],settings).effect,'allow',id);
 }
 settings=toggleBuiltin(settings,'git.commit');
 assert.deepEqual(settings.enabledRules,['git.commit']);
 assert.equal(matchRules([{action:'git.commit',target:'*'}],settings).effect,'ask');
 assert.deepEqual(toggleBuiltin(settings,'git.commit').enabledRules,[]);
 // A default-on rule still switches through disabledRules.
 assert.deepEqual(toggleBuiltin({},'fs.remove').disabledRules,['fs.remove']);
 assert.deepEqual(toggleBuiltin(toggleBuiltin({},'fs.remove'),'fs.remove').disabledRules,[]);
 assert.throws(()=>toggleBuiltin({},'unknown'));
});

test('command-pattern rules match whole command lines, wildcard across slashes',async()=>{
 const {matchRules}=await rules();
 const settings={rules:[
  {id:'user:push',action:'bash.command',target:'git  push*',effect:'deny'},
  {id:'user:deploy',action:'bash.command',target:'*deploy*',effect:'ask'}]};
 const command=target=>[{action:'bash.command',target}];
 assert.equal(matchRules(command('git push origin feature/x'),settings).effect,'deny');
 assert.equal(matchRules(command('git pull'),settings).effect,'allow');
 assert.equal(matchRules(command('npm run deploy:prod -- --dir a/b'),settings).effect,'ask');
 // A path rule never matches a command, and the reverse.
 assert.equal(matchRules([{action:'file.write',target:'git push origin main'}],settings).effect,'allow');
 assert.equal(matchRules(command('git push'),{rules:[{id:'user:x',action:'file.write',target:'**',effect:'deny'}]}).effect,'allow');
});

test('a jail rule denies, is marked severe, and reports the actions it matched',async()=>{
 const {matchRules}=await rules();
 const settings={rules:[{id:'user:env',action:'file.write',target:'.env*',effect:'jail'}]};
 const decision=matchRules([{action:'file.write',target:'/p/.env',relativeTarget:'.env'},{action:'file.write',target:'/p/a.js',relativeTarget:'a.js'}],settings);
 assert.equal(decision.effect,'deny');assert.equal(decision.severe,true);
 assert.deepEqual(decision.matched.map(action=>action.relativeTarget),['.env']);
 assert.equal(matchRules([{action:'fs.remove',target:'x'}],{}).severe,false);
});

test('custom CRUD retains identity and cannot mutate builtins or overwrite stale edits',async()=>{
 const m=await rules();assert.equal(typeof m.createUserRule,'function');assert.equal(typeof m.updateUserRule,'function');assert.equal(typeof m.deleteUserRule,'function');
 const original={id:'user:edit',action:'file.write',target:'private/**',effect:'ask'};
 const settings=m.createUserRule({rules:[]},original);assert.equal(settings.rules.length,1);
 const changed=m.updateUserRule(settings,original.id,{action:'bash.command',target:'git push*',effect:'deny'},original);
 assert.deepEqual(changed.rules,[{id:original.id,action:'bash.command',target:'git push*',effect:'deny'}]);
 assert.equal(m.deleteUserRule(changed,original.id,changed.rules[0]).rules.length,0);
 assert.throws(()=>m.updateUserRule(settings,'git.push',{effect:'deny'}),/custom|user|built/i);
 assert.throws(()=>m.deleteUserRule(settings,'git.push'),/custom|user|built/i);
 assert.throws(()=>m.updateUserRule(changed,original.id,{effect:'jail'},original),/changed|stale/i);
 assert.throws(()=>m.deleteUserRule(changed,original.id,original),/changed|stale/i);
});

test('two sessions changing rules at once both keep their change; a stale lock is abandoned',async t=>{
 const {loadProjectSettings,updateProjectSettings,createUserRule}=await rules();const {$,ctx,path}=await fixture(t);
 $.fs.stat=async p=>{const s=await fs.stat(p);return {kind:'file',mtimeMs:s.mtimeMs,isLink:false}};
 const add=n=>updateProjectSettings($,ctx,latest=>createUserRule(latest,{id:`user:r${n}`,action:'file.write',target:`dir${n}/**`,effect:'ask'}));
 await Promise.all(Array.from({length:8},(_,n)=>add(n)));
 assert.deepEqual((await loadProjectSettings($,ctx)).rules.map(rule=>rule.id).sort(),Array.from({length:8},(_,n)=>`user:r${n}`).sort());
 const leftovers=(await fs.readdir(dirname(path))).filter(name=>name.includes('.lock'));
 assert.deepEqual(leftovers,[]);
 // A lock left by a crashed session is taken over after ten seconds.
 await fs.writeFile(path+'.lock','x');const old=new Date(Date.now()-60000);await fs.utimes(path+'.lock',old,old);
 await add(9);
 assert.ok((await loadProjectSettings($,ctx)).rules.some(rule=>rule.id==='user:r9'));
});
