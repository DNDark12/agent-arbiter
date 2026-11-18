import test from 'node:test';
import assert from 'node:assert/strict';
import {world} from './fixtures.mjs';
import {observationContext} from '../extension/hooks/context.js';
import {saveProjectSettings,updateUserRule,loadProjectSettings} from '../extension/hooks/project-rules.js';
import {enforceTool} from '../extension/hooks/gate.js';
test('editing a custom rule invalidates its earlier session consent',async t=>{
 const w=await world(t);w.$.plugin.root=w.root+'/extension';w.$.session.id=async()=>w.root;await w.command('mode enforce');const ctx=await observationContext(w.$);
 const rule={id:'user:edit',action:'file.write',target:'src/**',effect:'ask'};
 await saveProjectSettings(w.$,ctx,{rules:[rule]});let asks=0;
 w.$.ui.ask=async(_question,options)=>{asks++;return options[1]};
 assert.equal(await enforceTool(w.$,ctx,{tool:'Write',file_path:w.root+'/src/a.js'},{},'one'),null);
 assert.equal(await enforceTool(w.$,ctx,{tool:'Write',file_path:w.root+'/src/b.js'},{},'two'),null);assert.equal(asks,1);
 await saveProjectSettings(w.$,ctx,updateUserRule(await loadProjectSettings(w.$,ctx),rule.id,{target:'private/**'},rule));
 assert.equal(await enforceTool(w.$,ctx,{tool:'Write',file_path:w.root+'/private/key'},{},'three'),null);assert.equal(asks,2);
});
