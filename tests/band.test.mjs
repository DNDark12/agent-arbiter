import test from 'node:test';
import assert from 'node:assert/strict';
import {sprite,ROLES,ROLE_EMOJI} from '../plugins/agent-arbiter/hooks/sprites.js';
import {barText,barSvg,roleIcon,fraction,pillTrackSvg,pillWidth} from '../plugins/agent-arbiter/hooks/visuals.js';
import {bandRows,drawRow} from '../plugins/agent-arbiter/hooks/band.js';
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

test('the band bars: what waits first and decides whether it shows; activity joins the full list',()=>{
  setLanguage('vi');
  const rows=bandRows({detained:1,pending:3,decided:6,detainedAt:Date.now(),detainee:'court-coder',judgedToday:4},Date.now(),{asked:5,allowed:4});
  assert.deepEqual(rows.map(row=>[row.key,row.waiting]),[['jail',true],['reviews',true],['asks',false],['judge',false]]);
  assert.deepEqual([rows[0].pill,rows[0].max,rows[0].pulse,rows[0].role,rows[0].stat],['1 bị giam',null,true,'dev',''],'no raw agent name as a figure');
  assert.deepEqual([rows[1].pill,rows[1].stat,rows[1].value,rows[1].max],['3 chờ duyệt','6/9 đã xử lý',6,9]);
  assert.deepEqual([rows[2].pill,rows[2].value,rows[2].max],['5 lần hỏi',4,5]);
  assert.deepEqual([rows[3].pill,rows[3].value,rows[3].max],['4/20 lượt chấm',4,20]);
  assert.equal(bandRows({detained:0,pending:13,decided:0,detainedAt:0})[0].stat,'','nothing decided yet adds no figure');
  assert.equal(bandRows({detained:1,pending:0,decided:0,detainedAt:Date.now()-60000})[0].pulse,false,'an old detention is still');
  const full=drawRow(table(),'desktop',rows[1],90);
  assert.deepEqual(texts(full),['6/9 đã xử lý'],'an icon and a meter, one dim figure, no names');
  assert.equal(find(full,'Svg').length,2);
  assert.deepEqual(texts(drawRow(table(),'desktop',rows[1],90,undefined,true)),[],'the small band has no figure');
  const jail=drawRow(table(),'desktop',rows[0],90);
  assert.equal(find(jail,'Svg').filter(graphic=>graphic.props.isInteractive).length,1,'a fresh detention flashes');
  const terminal=table(false),buttons=terminal.Box({children:[]});
  assert.ok(texts(drawRow(terminal,'terminal',rows[1],80)).some(text=>/^[█▏▎▍▌▋▊▉░]+$/.test(text)),'a block track where there is room');
  const narrow=texts(drawRow(terminal,'terminal',rows[1],25,buttons));
  assert.ok(narrow.some(text=>text.trim()==='3 chờ duyệt'),'the pill never goes');
  assert.ok(!narrow.some(text=>/[█░]/.test(text)),'beside the buttons the track goes first');
  assert.equal(texts(roleIcon(table(false),'terminal','dev',24,{detained:true})).join(''),'⛓');
  setLanguage('en');
});

test('the pill sits at the fill end, opens the track when nothing is done, and stands alone without a total',()=>{
  const at=svg=>Number(/<rect x="([0-9.]+)" width="[0-9.]+" height="20" rx="10" fill="#F7B74E"/.exec(svg)[1]);
  const none=pillTrackSvg({label:'13 chờ duyệt',color:'#F7B74E',value:0,max:13,width:240});
  assert.equal(none.width,240);assert.equal(at(none.source),0);
  const some=pillTrackSvg({label:'3 chờ duyệt',color:'#F7B74E',value:6,max:9,width:240});
  assert.equal(at(some.source),Math.round(6/9*(240-pillWidth('3 chờ duyệt'))),'the pill travels along the free track');
  const alone=pillTrackSvg({label:'1 bị giam',color:'#F76E72'});
  assert.equal(alone.width,pillWidth('1 bị giam'));
  assert.doesNotMatch(pillTrackSvg({label:'<b>',color:'#F7B74E"/><script>'}).source,/<script>|<b>/);
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

test('in a terminal the pill sits at the fill end, between the done and the waiting cells',()=>{
  setLanguage('vi');
  const terminal=table(false),row=bandRows({detained:0,pending:3,decided:6,detainedAt:0})[0];
  const parts=texts(drawRow(terminal,'terminal',row,80));
  const pill=parts.findIndex(text=>text.trim()==='3 chờ duyệt');
  assert.ok(/^█+$/.test(parts[pill-1]),'done cells before the pill');
  assert.ok(/^░+$/.test(parts[pill+1]),'waiting cells after it');
  const none=texts(drawRow(terminal,'terminal',bandRows({detained:0,pending:13,decided:0,detainedAt:0})[0],80));
  const at=none.findIndex(text=>text.trim()==='13 chờ duyệt');
  assert.ok(at>0 && !none.slice(0,at).some(text=>/█/.test(text)),'with nothing done the pill opens the track');
  setLanguage('en');
});
