import test from 'node:test';
import assert from 'node:assert/strict';
import {sprite,ROLES,ROLE_EMOJI} from '../plugins/agent-arbiter/hooks/sprites.js';
import {barText,barSvg,roleIcon,fraction,pillTrackSvg,pillWidth} from '../plugins/agent-arbiter/hooks/visuals.js';
import {bandRows,drawRow} from '../plugins/agent-arbiter/hooks/band.js';
import {statusCounts} from '../plugins/agent-arbiter/hooks/status.js';
import {progressItems} from '../plugins/agent-arbiter/hooks/progress-view.js';
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
  assert.deepEqual(texts(full),[],'an icon and a meter, no loose text and no names');
  assert.equal(find(full,'Svg').length,2);
  const meter=find(full,'Svg')[1].props.source;
  assert.ok(meter.includes('3 chờ duyệt · 6/9 đã xử lý'),'the figure rides inside the pill');
  assert.match(meter,/<rect width="\d+" height="20" rx="10" fill="#F7B74E" fill-opacity="0.16"/);
  assert.match(meter,/<pattern id="pixel-grid"[^>]*width="3"[^>]*>[\s\S]*?<rect width="2" height="2"/);
  assert.match(meter,/<animateTransform[^>]*type="translate"[^>]*calcMode="discrete"/);
  assert.match(meter,/<g class="mv" clip-path="url\(#filled\)"/);
  const durations=[...meter.matchAll(/<animate[^>]*dur="([\d.]+)s"/g)].map(match=>match[1]);
  assert.ok(new Set(durations).size>1,'sparkles have independent timing');
  assert.match(meter,/<animate .*attributeName="opacity"/,'groups pulse in their own hue');
  assert.doesNotMatch(meter,/#FFFFFF/i,'no white flashes');
  assert.match(meter,/prefers-reduced-motion: reduce\) \{ \.mv \{ display: none/,'reduced motion hides the glints');
  assert.doesNotMatch(find(drawRow(table(),'desktop',rows[0],90),'Svg')[1].props.source,/<animate /,'a pill alone stands still');
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
  const pill=parts.findIndex(text=>text.trim().startsWith('3 chờ duyệt'));
  assert.ok(/^█+$/.test(parts[pill-1]),'done cells before the pill');
  assert.ok(/^░+$/.test(parts[pill+1]),'waiting cells after it');
  const first=texts(drawRow(terminal,'terminal',bandRows({detained:0,pending:19,decided:1,detainedAt:0})[0],28,undefined,true));
  assert.ok(first.some(text=>/█/.test(text)),'one decided item moves the pill, even on a short track');
  const none=texts(drawRow(terminal,'terminal',bandRows({detained:0,pending:13,decided:0,detainedAt:0})[0],80));
  const at=none.findIndex(text=>text.trim()==='13 chờ duyệt');
  assert.ok(at>0 && !none.slice(0,at).some(text=>/█/.test(text)),'with nothing done the pill opens the track');
  setLanguage('en');
});

test('the bar fills its row and the native click target covers the artwork',()=>{
  setLanguage('en');
  const row=bandRows({detained:0,pending:3,decided:6,detainedAt:0})[0];
  let pressed=0;
  const click=()=>pressed++;
  const narrow=find(drawRow(table(),'desktop',row,60,undefined,true,click),'Svg')[1].props.width;
  const wide=find(drawRow(table(),'desktop',row,140,undefined,true,click),'Svg')[1].props.width;
  assert.ok(wide>narrow+400,'a wider row gets a longer track, not a fixed stub');
  const drawn=drawRow(table(),'desktop',row,100,undefined,true,click);
  const [button]=find(drawn,'Button');
  assert.equal(button.props.label,'⠀');
  const target=find(drawn,'Box').find(box=>box.props.key==='band-hit-reviews');
  assert.deepEqual([target.props.position,target.props.left,target.props.right,target.props.top,target.props.bottom],['absolute',0,0,0,0]);
  assert.ok(texts(drawn).includes(' Reviews '));
  assert.equal(find(button,'Svg').length,0);
  const [,track]=find(drawn,'Svg');
  assert.match(track.props.source,/<text[^>]*>6\/9<\/text>/);
  assert.match(track.props.source,/<animate /);
  button.props.onPress();assert.equal(pressed,1);
});

test('review items branch under their agent and judge usage uses the same review window as the band',()=>{
  setLanguage('en');
  const now=2*86400000;
  const recentReviews=[
    {id:'older',at:0,agentId:'a',citizen:{name:'reviewer'},quality:80,exemplar:{state:'none'},
      findings:[{ref:'old',claim:'Old decision',state:'confirmed'}]},
    {id:'latest',at:now-10,agentId:null,quality:70,exemplar:{state:'none'},
      findings:[{ref:'open',claim:'Needs a decision',state:'open'},{ref:'noted',claim:'Minor note',state:'noted'}]},
  ];
  assert.deepEqual(progressItems({recentReviews},'reviews',now).map(item=>[item.key,Boolean(item.branch)]),
    [['latest',false],['open',true],['older',false],['old',true]]);
  assert.deepEqual(progressItems({recentReviews},'judge',now).map(item=>item.key),['latest']);
});
