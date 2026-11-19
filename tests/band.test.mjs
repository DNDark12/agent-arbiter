import test from 'node:test';
import assert from 'node:assert/strict';
import {sprite,ROLES,ROLE_EMOJI} from '../plugins/agent-arbiter/hooks/sprites.js';
import {barText,barSvg,roleIcon,fraction,pillTrackSvg,pillWidth,agentStripSvg} from '../plugins/agent-arbiter/hooks/visuals.js';
import {bandRows,drawRow,agentStrips,registerBand} from '../plugins/agent-arbiter/hooks/band.js';
import {statusCounts,bandAgents,refreshStatus} from '../plugins/agent-arbiter/hooks/status.js';
import {progressItems,bandDetail,bandDetailModel} from '../plugins/agent-arbiter/hooks/progress-view.js';
import {noteDecision,decisionNote,forgetNotes} from '../plugins/agent-arbiter/hooks/notes.js';
import {setLanguage} from '../plugins/agent-arbiter/hooks/i18n.js';
import {ROLES as AGENT_ROLES} from '../plugins/agent-arbiter/hooks/roles.js';
import {world} from './fixtures.mjs';
import {observationContext} from '../plugins/agent-arbiter/hooks/context.js';
import {saveProjectSettings} from '../plugins/agent-arbiter/hooks/project-rules.js';
import {reportedOperation,saveChecklist} from '../plugins/agent-arbiter/hooks/checklist.js';
import {emit} from '../plugins/agent-arbiter/hooks/events.js';

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
  assert.match(meter,/fill="url\(#track-tint\)"/,'a tinted track that deepens toward the end');
  assert.match(meter,/<pattern id="particles-0"/,'square particles fill the done part');
  const durations=[...meter.matchAll(/\.flicker-\d+\{opacity:0;animation:flicker-\d+ ([\d.]+)s/g)].map(match=>match[1]);
  assert.ok(new Set(durations).size>1,'sparkles have independent timing');
  assert.doesNotMatch(meter,/#FFFFFF"/i,'no white flashes');
  assert.match(meter,/prefers-reduced-motion: reduce\)\{\.stream\{animation:none\}\.glint\{display:none\}/,'reduced motion stills the track');
  assert.doesNotMatch(find(drawRow(table(),'desktop',rows[0],90),'Svg')[1].props.source,/@keyframes/,'a pill alone stands still');
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
  const at=(svg,label)=>Number(new RegExp(`<text x="([0-9.]+)"[^>]*>${label}</text>`).exec(svg)[1])-pillWidth(label)/2;
  const none=pillTrackSvg({label:'13 chờ duyệt',color:'#F7B74E',value:0,max:13,width:240});
  assert.equal(none.width,240);assert.equal(at(none.source,'13 chờ duyệt'),0);
  const some=pillTrackSvg({label:'3 chờ duyệt',color:'#F7B74E',value:6,max:9,width:240});
  assert.equal(at(some.source,'3 chờ duyệt'),Math.round(6/9*(240-pillWidth('3 chờ duyệt'))),'the pill travels along the free track');
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
  assert.match(track.props.source,/@keyframes/);
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

test('the open list shows only what waits, with its actions, and folds the settled into dots',()=>{
  setLanguage('vi');
  const now=2*86400000;
  const recentReviews=[
    {id:'a',at:now-100,quality:90,exemplar:{state:'approved'},findings:[{ref:'r1',claim:'Done check',state:'confirmed',severity:'medium'},{ref:'r2',claim:'Wrong claim',state:'dismissed',severity:'medium'}]},
    {id:'b',at:now-10,quality:60,exemplar:{state:'none'},findings:[{ref:'r3',claim:'Rollback untested',state:'open',severity:'high'},{ref:'r4',claim:'Minor',state:'noted',severity:'low'},{ref:'r5',claim:'Expired card',state:'open',severity:'medium'}]},
  ];
  const model=bandDetailModel({recentReviews},'reviews',now);
  assert.deepEqual(model.waiting.map(item=>item.ref),['r3','r5']);
  assert.equal(model.settled.length,3);assert.equal(model.figure,'3 đã xử lý');
  const decided=[];
  const drawn=bandDetail(table(),'reviews',model,6,{busy:new Set(['r5']),more:()=>{},decide:(ref,decision)=>decided.push([ref,decision]),release:()=>{}});
  assert.equal(drawn.props.key,'progress-tree-reviews');
  const buttons=find(drawn,'Button');
  assert.deepEqual(buttons.map(button=>button.props.key),['confirm:r3','dismiss:r3'],'a finding being recorded shows no buttons');
  buttons[1].props.onPress();assert.deepEqual(decided,[['r3','dismissed']]);
  assert.ok(texts(drawn).includes('…'));
  assert.ok(!texts(drawn).includes('Done check'),'settled findings carry no text');
  const tight=bandDetail(table(),'reviews',model,2,{busy:new Set(),more:()=>{},decide:()=>{},release:()=>{}});
  assert.deepEqual(find(tight,'Button').map(button=>button.props.key),['confirm:r3','dismiss:r3','band-more'],'what does not fit opens the panel');
  const judge=bandDetailModel({recentReviews},'judge',now);
  assert.deepEqual([judge.waiting.length,judge.settled.length,judge.figure],[0,2,'trung bình 75/100']);
  const jail=bandDetailModel({detainedRecords:[{id:'v1',citizen:{name:'court-coder'},ruleIds:['user:x']}]},'jail');
  assert.deepEqual(find(bandDetail(table(),'jail',jail,4,{busy:new Set(),more:()=>{},decide:()=>{},release:()=>{}}),'Button').map(button=>button.props.key),['release:v1']);
  setLanguage('en');
});

test('subagent strips: at work, held or just ended; newest few, then how many more',()=>{
  setLanguage('en');
  const now=10*60000,agent=(id,extra)=>({agentId:id,name:'agent-'+id,model:'claude-sonnet-4',status:'done',detained:false,endedAt:null,startedAt:0,calls:3,durationMs:1000,...extra});
  const list=bandAgents({agents:[agent('old',{endedAt:now-5*60000}),agent('fresh',{endedAt:now-30000}),agent('run',{status:'running',startedAt:now-65000,durationMs:null}),agent('held',{detained:true})]},now);
  assert.deepEqual(list.map(item=>item.agentId),['fresh','run','held']);
  const opened=[];
  const rows=agentStrips(table(),'desktop',list,90,2,item=>opened.push(item?.agentId ?? 'all'),now);
  const buttons=find(rows,'Button');
  assert.deepEqual(buttons.map(button=>button.props.key),['strip:held','strip-more'],'what does not fit is counted');
  assert.match(find(rows,'Svg')[0].props.alt,/detained/);
  buttons[1].props.onPress();assert.deepEqual(opened,['all']);
  const running=find(agentStrips(table(),'desktop',list,90,4,()=>{},now),'Svg').map(svg=>svg.props.alt);
  assert.ok(running.some(alt=>/agent-run · sonnet-4 · 3 call\(s\) · 1m 5s/.test(alt)),running.join('|'));
  assert.match(agentStripSvg({name:'a',state:'running'}).source,/prefers-reduced-motion: no-preference/);
  assert.doesNotMatch(agentStripSvg({name:'<b>',figure:'"/><x'}).source,/<b>|<x/);
  assert.ok(texts(agentStrips(table(false),'terminal',list,80,4,()=>{},now)).some(text=>text.trim()==='◉'));
});

test('the agents bar counts this session’s finished agents and lists them with their score',()=>{
  setLanguage('en');
  const now=Date.now(),agents=[
    {agentId:'a',name:'reviewer',model:'claude-haiku-4-5',status:'done',detained:false,startedAt:now-90000,endedAt:now-30000,durationMs:60000,calls:4,quality:92,violations:[]},
    {agentId:'b',name:'coder',model:'claude-sonnet-4-5',status:'running',detained:false,startedAt:now-20000,endedAt:null,durationMs:null,calls:2,quality:null,violations:[]},
  ];
  const row=bandRows({detained:0,pending:0,decided:0,detainedAt:0,agents},now).find(item=>item.key==='agents');
  assert.deepEqual([row.value,row.max,row.live,row.waiting],[1,2,true,false]);
  assert.equal(bandRows({detained:0,pending:0,decided:0,detainedAt:0,agents:[{...agents[0],endedAt:now-10*60000}]},now).length,0,'long-finished agents leave the band');
  const alts=find(agentStrips(table(),'desktop',agents,90,4,()=>{},now),'Svg').map(svg=>svg.props.alt);
  assert.ok(alts.some(alt=>/reviewer · haiku-4-5 · 4 call\(s\) · 1m 0s · 92\/100/.test(alt)),alts.join('|'));
  const model=bandDetailModel({agents},'agents');
  assert.deepEqual([model.waiting.length,model.settled.length],[1,1]);
});

test('the collapsed band puts waiting items, running agents and the unfinished checklist ahead of counters',async t=>{
  const {$}=await world(t),ctx=await observationContext($);
  $.ui={...$.ui,resolve:()=>table(),invalidate(){}};
  const hooks=[];
  registerBand((...args)=>hooks.push(args));
  const render=hooks.find(([event,match])=>event==='ui.render' && match.component==='AbovePrompt')[2];
  const draw=()=>render($,{surface:'desktop',props:{bodyColumns:90,maxRows:8,hasSurvey:false}},()=>null);
  const rowKeys=tree=>find(tree,'Box').map(node=>node.props.key).filter(key=>['jail','reviews','agents','checklist','judge'].includes(key));
  const openList=tree=>find(tree,'Button').find(node=>node.props.key==='band-list').props.onPress();
  await saveProjectSettings($,ctx,{mode:'observe',checklist:true});
  const review=await emit($,ctx,null,'judge.review','fixture',{scores:{honesty:2},exemplar:{worthy:false},
    findings:[{claim:'QA check',evidence:'Synthetic fixture',severity:'high',dimension:'honesty'}]});
  await emit($,ctx,null,'judge.decision','decided',{reviewId:review,finding:0,decision:'dismissed',source:{origin:'ui'}});
  await refreshStatus($,ctx);
  assert.equal(await draw(),null,'judge usage alone does not open the band');

  await saveChecklist($,ctx,'checklist',reportedOperation({tasks:[{id:'one',label:'Verify',status:'in_progress'}]}));
  await refreshStatus($,ctx);
  assert.deepEqual(rowKeys(await draw()),['checklist']);
  openList(await draw());
  assert.ok(rowKeys(await draw()).includes('judge'),'judge usage stays available in the expanded list');
  openList(await draw());

  await emit($,ctx,null,'spawn.result','agent',{childAgentId:'a',status:'started',citizen:{name:'coder'}});
  await refreshStatus($,ctx);
  assert.deepEqual(rowKeys(await draw()),['agents']);

  const pending=await emit($,ctx,null,'judge.review','pending',{scores:{honesty:2},exemplar:{worthy:false},
    findings:[{claim:'Unresolved QA check',evidence:'Synthetic fixture',severity:'high',dimension:'honesty'}]});
  await refreshStatus($,ctx);
  assert.deepEqual(rowKeys(await draw()),['reviews']);
  await emit($,ctx,null,'judge.decision','handled',{reviewId:pending,finding:0,decision:'dismissed',source:{origin:'ui'}});
  await emit($,ctx,'a','turn.complete','finished',{reason:'answer',durationMs:1000});
  await refreshStatus($,ctx);
  assert.deepEqual(rowKeys(await draw()),['checklist'],'a recently finished agent makes room for unfinished work');
});
