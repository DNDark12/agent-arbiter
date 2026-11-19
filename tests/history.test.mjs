import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionTimeline,recentSessions,durationText} from '../plugins/agent-arbiter/hooks/history.js';
import {timelineGutterText} from '../plugins/agent-arbiter/hooks/visuals.js';

let seq=0;
const event=(kind,agentId,at,data={},sessionId='s1')=>({id:(++seq).toString(16).padStart(64,'0'),projectId:'p',sessionId,agentId,kind,occurredAt:at,data});
const spawn=(child,name,at,end,extra={})=>[
  event('spawn.request',null,at,{agentType:name,spawnAttemptId:'a-'+child}),
  event('spawn.result',null,at+10,{spawnAttemptId:'a-'+child,childAgentId:child,status:'started',citizen:{name,resolvedModel:'claude-sonnet-5-5'},profile:{runRole:'dev',difficulty:'easy'}}),
  event('tool.request',child,at+20,{tool:'Edit',toolCallId:'t-'+child,file:{path:'src/'+child+'.js',scope:'project'}}),
  event('tool.request',child,at+30,{tool:'Bash',toolCallId:'u-'+child}),
  ...(end?[event('turn.complete',child,end,{durationMs:end-at,isAborted:false,reason:'answer',model:'claude-sonnet-5-5',...extra})]:[]),
];

test('a session reads as the main thread and a branch per agent it sent, side by side when they overlap',()=>{
  const now=3_000_000;
  const events=[event('session.start',null,0,{model:'claude-opus-5-5'}),event('tool.request',null,5,{tool:'Read',toolCallId:'m1'}),
    ...spawn('c1','coder',100,400),...spawn('c2','tester',200,300),...spawn('c3','scout',500,null),
    event('turn.complete',null,600,{model:'claude-opus-5-5'}),event('tool.request',null,10,{tool:'Read'},'other')];
  const line=sessionTimeline(events,'p','s1',{now:now,discipline:{violations:[{id:'v1',sessionId:'s1',agentId:'c2',sanction:'detain',status:'active',ruleIds:['fs.remove']}]},
    reviews:[{sessionId:'s1',agentId:'c1',id:'r1',quality:80,findings:[{ref:'r1-0',state:'open',severity:'high',claim:'x'}]}]});
  assert.deepEqual(line.main,{model:'claude-opus-5-5',turns:1,calls:1});
  assert.deepEqual(line.agents.map(run=>[run.name,run.lane,run.status,run.calls]),[['coder',0,'done',2],['tester',1,'done',2],['scout',0,'unfinished',2]]);
  assert.equal(line.lanes,2);
  const [coder,tester]=line.agents;
  assert.equal(coder.quality,80);assert.equal(coder.findings.length,1);assert.equal(coder.files,1);assert.deepEqual(coder.tools,[{tool:'Bash',count:1},{tool:'Edit',count:1}]);
  assert.equal(tester.detained,true);assert.equal(tester.parallel,true);
  assert.equal(sessionTimeline(events,'p','s1',{now:520}).agents[2].status,'running','a run with recent signs of life and no end is running');
  assert.equal(sessionTimeline(events,'p','none'),null);
  assert.deepEqual(recentSessions(events,'p').map(item=>[item.sessionId,item.agents]),[['s1',3],['other',0]]);
  assert.equal(durationText(125000),'2m 5s');
  assert.equal(timelineGutterText({lane:0,lanes:2,last:true}),'└─ ');
  assert.equal(timelineGutterText({lane:9,lanes:9}),'├─────── ','deep lanes share the last shown one');
});
