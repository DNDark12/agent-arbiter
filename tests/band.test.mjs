import test from 'node:test';
import assert from 'node:assert/strict';
import {sprite,ROLES,ROLE_EMOJI} from '../plugins/agent-arbiter/hooks/sprites.js';
import {barText,barSvg,levelRow,roleIcon,fraction} from '../plugins/agent-arbiter/hooks/visuals.js';
import {bandRows} from '../plugins/agent-arbiter/hooks/band.js';
import {statusCounts} from '../plugins/agent-arbiter/hooks/status.js';
import {noteDecision,decisionNote,forgetNotes} from '../plugins/agent-arbiter/hooks/notes.js';
import {setLanguage} from '../plugins/agent-arbiter/hooks/i18n.js';
import {ROLES as AGENT_ROLES} from '../plugins/agent-arbiter/hooks/roles.js';

// A drawing table that records what was drawn, as $.ui.resolve's would.
const table=(withSvg=true)=>{
  const make=type=>props=>({type,props,children:props.children});
  return {Box:make('Box'),Text:make('Text'),Button:make('Button'),...(withSvg?{Svg:make('Svg')}:{})};
};
const texts=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(texts):
  [...(node.type==='Text'&&typeof node.children==='string'?[node.children]:[]),...texts(node.children)];
const find=(node,type)=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(item=>find(item,type)):
  [...(node.type===type?[node]:[]),...find(node.children,type)];

test('every agent role and the main agent has its own icon',()=>{
  for(const role of [...AGENT_ROLES,'main'])assert.ok(ROLES.includes(role),role);
  assert.equal(new Set(ROLES.map(role=>sprite(role))).size,ROLES.length);
  for(const role of ROLES)assert.ok(ROLE_EMOJI[role],role);
});

test('icons idle only where motion is welcome, each role on its own beat; a detainee stands still',()=>{
  const idle=sprite('dev',{animate:true});
  assert.match(idle,/@media \(prefers-reduced-motion: no-preference\)[^@]*\.body \{ animation: bob/);
  assert.match(idle,/class="eye"/);
  assert.doesNotMatch(sprite('dev'),/animation/);
  const delays=new Set(ROLES.map(role=>/bob 1\.6s steps\(1\) infinite; animation-delay: (-[0-9.]+s)/.exec(sprite(role,{animate:true}))?.[1]));
  assert.ok(delays.size>4);
  const held=sprite('dev',{animate:true,detained:true});
  assert.doesNotMatch(held,/@keyframes bob/);
  assert.match(held,/class="jail"/);
  assert.match(sprite('dev',{detained:true,pulse:true}),/alarm 0\.4s steps\(1\) 3/);
});

test('bars are exact at their ends and drawn only against a known total',()=>{
  assert.equal(barText({value:0,max:9},10),'░'.repeat(10));
  assert.equal(barText({value:9,max:9},10),'█'.repeat(10));
  assert.equal(barText({value:6,max:9},10).length,10);
  assert.equal(fraction({value:3,max:0}),0);
  assert.match(barSvg({value:6,max:9,color:'#F7B74E"><script>'},120),/^<svg [^>]*width="120"/);
  assert.doesNotMatch(barSvg({value:6,max:9,color:'#F7B74E"><script>'},120),/<script>/);
});

test('the band holds what waits: a detention as a figure, the reviews against their total',()=>{
  setLanguage('vi');
  const h=table();
  const rows=bandRows(h,'desktop',{detained:1,pending:3,decided:6,detainedAt:Date.now(),detainee:'court-coder'});
  assert.deepEqual(rows.map(row=>row.key),['jail','reviews']);
  assert.equal(rows[0].bar,null);
  assert.equal(rows[0].figure,'1 agent bị giam');
  assert.equal(rows[0].lead.props.isInteractive,true,'a fresh detention flashes');
  assert.deepEqual(rows[1].bar,{value:6,max:9,color:'#F7B74E'});
  assert.equal(rows[1].figure,'6/9 đã xử lý · 3 chờ');
  const stale=bandRows(h,'desktop',{detained:1,pending:0,decided:0,detainedAt:Date.now()-60000,detainee:null});
  assert.equal(stale[0].lead.props.isInteractive,undefined,'an old detention is still');
  const drawn=levelRow(h,'desktop',rows[1],90);
  assert.ok(texts(drawn).includes('6/9 đã xử lý · 3 chờ'));
  assert.equal(find(drawn,'Svg').length,1);
  const terminal=table(false),buttons=terminal.Box({children:[]});
  assert.deepEqual(texts(levelRow(terminal,'terminal',rows[1],26)).filter(text=>/chờ/.test(text)),['6/9 · 3 chờ']);
  const narrow=levelRow(terminal,'terminal',rows[1],25,buttons);
  assert.deepEqual(texts(narrow).filter(text=>/chờ/.test(text)),['3 chờ'],'beside the buttons only what waits is left');
  assert.equal(find(narrow,'Svg').length,0);
  assert.equal(texts(roleIcon(table(false),'terminal','dev',24,{detained:true})).join(''),'⛓');
  setLanguage('en');
});

test('decided counts only reviews still in their waiting window',()=>{
  const now=Date.now(),day=24*60*60*1000;
  const review=(age,states,exemplar='none')=>({at:now-age*day,findings:states.map(state=>({state})),exemplar:{state:exemplar}});
  const counts=statusCounts({violations:[{sanction:'detain',status:'active',sessionId:'s',agentId:'a',citizen:{name:'court-coder'}}]},
    [review(1,['open','confirmed']),review(2,['dismissed'],'approved'),review(30,['confirmed','dismissed'])],now);
  assert.deepEqual(counts,{detainee:'court-coder',detained:1,pending:1,decided:3});
});

test('a decision note is kept per tool call, bounded, newest kept',()=>{
  forgetNotes();
  noteDecision('t1',['fs.remove'],'approved');
  noteDecision('',['fs.remove'],'approved');noteDecision('t2',[],'approved');
  assert.deepEqual(decisionNote('t1'),{ruleIds:['fs.remove'],outcome:'approved'});
  assert.equal(decisionNote('t2'),null);
  for(let n=0;n<600;n++)noteDecision('n'+n,['fs.remove'],'refused');
  assert.equal(decisionNote('t1'),null);
  assert.ok(decisionNote('n599'));
});
