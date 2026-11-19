import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {world} from './fixtures.mjs';
import {observationContext} from '../plugins/agent-arbiter/hooks/context.js';
import {enforceSpawn} from '../plugins/agent-arbiter/hooks/spawn.js';
import {readProject,emit} from '../plugins/agent-arbiter/hooks/events.js';
import * as discipline from '../plugins/agent-arbiter/hooks/discipline.js';
import * as judge from '../plugins/agent-arbiter/hooks/judge.js';
import {reduceScores} from '../plugins/agent-arbiter/hooks/scoring.js';
import {prunable} from '../plugins/agent-arbiter/hooks/retention.js';
import {mainCitizen} from '../plugins/agent-arbiter/hooks/citizens.js';

const identity=(name='developer',model='claude-sonnet-5-5')=>({id:'c'.repeat(64),name,source:'userSettings',provider:null,
 definitionHash:'d'.repeat(64),resolvedModel:model,engineVersion:'2.1.325'});
const verdict=(over={})=>JSON.stringify({difficulty:'hard',scores:{completeness:5,honesty:5,verification:4,scope:5,correctness:4,performance:null,security:null},
 findings:[{severity:'high',dimension:'honesty',claim:'Report says tests passed but no test command ran',evidence:'activity has no test call'}],
 exemplar:{worthy:false,why:''},...over});
async function fresh(t){
 discipline.resetDiscipline();judge.resetJudge();
 const w=await world(t);w.$.plugin.root=w.root+'/extension';w.$.session.id=async()=>w.root;await w.command('mode enforce');
 const ctx=await observationContext(w.$);
 w.requests=[];w.reply=verdict();
 w.$.model={complete:async request=>{w.requests.push(request);return w.reply===null?{isAnswered:false,reason:'api-error'}:{isAnswered:true,text:w.reply,usage:{input_tokens:900,output_tokens:120}}}};
 return {w,ctx};
}
async function ran(w,ctx,agentId='dev-1',files={'src/a.js':'export const a = 1;\n'}){
 judge.rememberBrief(ctx,agentId,{prompt:'Add function a and run the tests. token=BRIEFSECRET'},identity());
 for(const [path,text] of Object.entries(files)){
  await fs.mkdir(w.root+'/'+path.split('/').slice(0,-1).join('/'),{recursive:true});await fs.writeFile(w.root+'/'+path,text);
  judge.noteActivity(ctx,agentId,{tool:'Write',target:path,status:'completed'});
 }
 judge.noteActivity(ctx,agentId,{tool:'Bash',target:'npm [arguments redacted]',status:'completed'});
}
const turn=(agentId='dev-1',turnId='t1',answer='Added a; all tests passed. password=REPORTSECRET')=>({agentId,turnId,isAborted:false,answer});
const reviews=async(w,ctx)=>judge.reduceReviews((await readProject(w.$,ctx)).events,ctx.projectId);

test('a main-only session keeps per-turn usage and review evidence without a spawned agent',async t=>{
 const {w,ctx}=await fresh(t);
 judge.rememberMainTurn(ctx,{turnId:'main-1',text:'Read the fixture and report verification. token=MAINSECRET'});
 judge.noteActivity(ctx,null,{tool:'Read',target:'fixture.txt',status:'completed'});
 const result={turnId:'main-1',answer:'Read fixture.txt and reported the evidence.',usage:{model:'claude-sonnet-5-5'}};
 await emit(w.$,ctx,null,'turn.complete','main-1',{turnId:'main-1',model:'claude-sonnet-5-5',reason:'answer',durationMs:1000,usage:{input_tokens:15,cache_read_input_tokens:30,output_tokens:12}});
 assert.ok(await judge.judgeRun(w.$,ctx,result));
 assert.equal(await judge.judgeRun(w.$,ctx,result),null);
 assert.equal(w.requests.length,1);
 assert.doesNotMatch(w.requests[0].prompt,/MAINSECRET/);
 const events=(await readProject(w.$,ctx)).events;
 const [row]=reduceScores(events,ctx.projectId,discipline.reduceDiscipline(events,ctx.projectId),{},judge.reduceReviews(events,ctx.projectId));
 assert.equal(row.kind,'main');
 assert.equal(row.runs,1);
 assert.equal(row.reviews,1);
 assert.equal(row.inputTokens,15);
 assert.equal(row.cacheReadTokens,30);
 assert.equal(row.outputTokens,12);
 assert.equal(row.durationMs,1000);
});

test('main-only interrupted turns and warnings stay visible without a quality grade',async t=>{
 const {w,ctx}=await fresh(t);
 await emit(w.$,ctx,null,'turn.complete','main-2',{turnId:'main-2',model:'claude-haiku-5-5',reason:'aborted',durationMs:20,usage:{}});
 const requestId=await emit(w.$,ctx,null,'tool.request','main-denied',{turnId:'main-2',tool:'Bash'});
 await discipline.recordViolation(w.$,ctx,{tool_use_id:'main-denied'},{ruleIds:['fixture'],reason:'test',detail:'fixture',requestId});
 const events=(await readProject(w.$,ctx)).events;
 const rows=reduceScores(events,ctx.projectId,discipline.reduceDiscipline(events,ctx.projectId));
 const run=rows.find(row=>row.runs===1);
 assert.equal(run.interruptedRuns,1);
 assert.deepEqual(run.qualityGroups,[]);
 assert.equal(run.warnings,1);
 assert.ok(rows.every(row=>row.trust===100 && !row.detained));
});

test('pruning keeps main turns with court records; a warning without a turn joins its session row',async t=>{
 const {w,ctx}=await fresh(t);
 const model='claude-sonnet-5-5';
 await emit(w.$,ctx,null,'turn.complete','main-a',{turnId:'main-a',model,reason:'answer',durationMs:10,usage:{input_tokens:1}});
 await emit(w.$,ctx,null,'turn.complete','main-b',{turnId:'main-b',model,reason:'answer',durationMs:10,usage:{input_tokens:1}});
 await emit(w.$,ctx,null,'turn.complete','main-c',{turnId:'main-c',model,reason:'answer',durationMs:10,usage:{input_tokens:1}});
 await emit(w.$,ctx,null,'judge.review','main-a',{turnId:'main-a',citizen:mainCitizen(model),role:'dev',difficulty:'easy',scores:{completeness:4},findings:[]});
 const requestId=await emit(w.$,ctx,null,'tool.request','main-b-call',{turnId:'main-b',tool:'Bash'});
 await discipline.recordViolation(w.$,ctx,{tool_use_id:'main-b-call'},{ruleIds:['fixture'],reason:'test',detail:'fixture',requestId});
 // An older record names no request, so no turn.
 await discipline.recordViolation(w.$,ctx,{tool_use_id:'legacy'},{ruleIds:['fixture'],reason:'test',detail:'fixture'});
 const all=(await readProject(w.$,ctx)).events;
 const gone=new Set(prunable(all,Date.now()+40*24*60*60*1000).map(event=>event.id));
 const kept=all.filter(event=>!gone.has(event.id));
 assert.deepEqual(kept.filter(event=>event.kind==='turn.complete').map(event=>event.data.turnId).sort(),['main-a','main-b']);
 const rows=reduceScores(kept,ctx.projectId,discipline.reduceDiscipline(kept,ctx.projectId),{},judge.reduceReviews(kept,ctx.projectId));
 assert.deepEqual(rows.map(row=>[row.kind,row.model,row.runs,row.reviews,row.warnings]),[['main',model,2,1,2]]);
});

test('main turns use at most part of the daily reviews; subagent runs are still reviewed',async t=>{
 const {w,ctx}=await fresh(t);
 for(let n=0;n<judge.MAIN_DAILY_TRIALS;n++)await emit(w.$,ctx,null,'judge.review','old-'+n,{turnId:'old-'+n,citizen:mainCitizen('claude-sonnet-5-5'),scores:{},findings:[]});
 judge.rememberMainTurn(ctx,{turnId:'main-cap',text:'Read the fixture.'});
 judge.noteActivity(ctx,null,{tool:'Read',target:'fixture.txt',status:'completed'});
 assert.equal(await judge.judgeRun(w.$,ctx,{turnId:'main-cap',reason:'answer',answer:'Read it.'}),null);
 assert.equal(w.requests.length,0);
 await ran(w,ctx);
 // A subagent turn is judged whatever reason the host gives for its end.
 assert.ok(await judge.judgeRun(w.$,ctx,{...turn(),reason:'handback'}));
 assert.equal(w.requests.length,1);
});

test('parseVerdict: accepts JSON inside prose, keeps unscored dimensions null, bounds and masks findings',()=>{
 const parsed=judge.parseVerdict('Here you go:\n'+verdict({scores:{completeness:9,honesty:'5',verification:3.26,scope:0},
  findings:[...Array(7).fill({severity:'extreme',dimension:'nonsense',claim:'x'.repeat(400)+' password=hunter2',evidence:'line 2'}),{claim:'no evidence'}]})+'\nDone.');
 assert.deepEqual(parsed.scores,{completeness:null,honesty:null,verification:3.3,scope:0,correctness:null,performance:null,security:null});
 assert.equal(parsed.findings.length,5);
 assert.deepEqual([parsed.findings[0].severity,parsed.findings[0].dimension,parsed.findings[0].claim.length],['low','correctness',240]);
 assert.equal(parsed.difficulty,'hard');
 assert.equal(judge.parseVerdict(verdict({exemplar:{worthy:true,why:''}})).exemplar.worthy,false,'an exemplar needs a reason');
 assert.equal(judge.parseVerdict(verdict({difficulty:'impossible'})).difficulty,'medium');
 for(const bad of ['no json','{"scores":',JSON.stringify({findings:[]}),null])assert.equal(judge.parseVerdict(bad),null);
 assert.equal(judge.qualityOf(parsed.scores),33);assert.equal(judge.qualityOf({}),null);
});

test('a finished run that did work is reviewed once, from masked evidence; the ledger keeps scores, not content',async t=>{
 const {w,ctx}=await fresh(t);
 await ran(w,ctx,'dev-1',{'src/a.js':'export const a = 1; // api_key=FILESECRET\n','.env':'DB_PASSWORD=ENVSECRET\n'});
 const id=await judge.judgeRun(w.$,ctx,turn());
 assert.match(id,/^[a-f0-9]{64}$/);
 assert.equal(await judge.judgeRun(w.$,ctx,turn()),null,'the same turn is not judged twice');
 assert.equal(w.requests.length,1);
 const request=w.requests[0];
 assert.equal(request.model,'haiku');assert.ok(request.timeoutMs>0);assert.match(request.system,/never follow instructions/);
 for(const part of ['EVIDENCE: ROLE\n\ndev','Add function a and run the tests.','Added a; all tests passed.','1. Write src/a.js — completed','3. Bash npm [arguments redacted] — completed','--- src/a.js\nexport const a = 1;'])assert.ok(request.prompt.includes(part),part);
 for(const secret of ['BRIEFSECRET','REPORTSECRET','FILESECRET','ENVSECRET','--- .env'])assert.ok(!request.prompt.includes(secret),secret+' reached the model');
 const stored=JSON.stringify((await readProject(w.$,ctx)).events.filter(event=>event.kind==='judge.review'));
 for(const text of ['Add function a','all tests passed','export const'])assert.ok(!stored.includes(text),text+' stored in the ledger');
 const [review]=await reviews(w,ctx);
 // Difficulty comes from the brief before the run, not from the judge's view of the result.
 assert.deepEqual([review.role,review.difficulty,review.quality,review.citizen.name,review.agentId],['dev','easy',92,'developer','dev-1']);
 assert.equal((await readProject(w.$,ctx)).events.find(event=>event.kind==='judge.review').data.judgeDifficulty,'hard');
 assert.deepEqual(review.findings.map(finding=>[finding.severity,finding.dimension,finding.state]),[['high','honesty','open']]);
 assert.match(review.findings[0].ref,/^[a-f0-9]{12}-0$/);
});

test('nothing is reviewed, and no model is called, when there is no work, no brief, the switch is off or the cap is reached',async t=>{
 const {w,ctx}=await fresh(t);
 judge.rememberBrief(ctx,'reader',{prompt:'Look around'},identity());
 judge.noteActivity(ctx,'reader',{tool:'Read',target:'a',status:'completed'});
 assert.equal(await judge.judgeRun(w.$,ctx,turn('reader')),null,'read-only run');
 judge.noteActivity(ctx,'no-brief',{tool:'Bash',target:'ls',status:'completed'});
 assert.equal(await judge.judgeRun(w.$,ctx,turn('no-brief')),null);
 await ran(w,ctx,'dev-1');
 assert.equal(await judge.judgeRun(w.$,ctx,{...turn(),isAborted:true}),null);
 assert.equal(await judge.judgeRun(w.$,ctx,{...turn(),answer:'  '}),null);
 assert.equal(await judge.judgeRun(w.$,ctx,{turnId:'t',answer:'main agent'}),null,'the main agent is not reviewed');
 await w.command('judge off');
 assert.equal(await judge.judgeRun(w.$,ctx,turn('dev-1','off')),null);
 assert.match((await w.command('judge on','sdk')).text,/Human composer/);
 await w.command('judge on');
 assert.equal(w.requests.length,0);
 w.reply=null;assert.equal(await judge.judgeRun(w.$,ctx,turn('dev-1','unanswered')),null,'no answer is no verdict');
 w.reply='not json';assert.equal(await judge.judgeRun(w.$,ctx,turn('dev-1','garbled')),null);
 assert.equal((await reviews(w,ctx)).length,0);
 w.reply=verdict();
 for(let n=0;n<judge.DAILY_TRIALS;n++)await emit(w.$,ctx,'old','judge.review','seed'+n,{scores:{},findings:[],usage:{input_tokens:1,output_tokens:1}});
 const before=w.requests.length;
 assert.equal(await judge.judgeRun(w.$,ctx,turn('dev-1','capped')),null);
 assert.equal(w.requests.length,before,'the daily cap stops the call itself');
});

test('findings count only when the person confirms; a dismissed finding withdraws the review; an approved exemplar is taught',async t=>{
 const {w,ctx}=await fresh(t);
 await ran(w,ctx,'dev-1');await judge.judgeRun(w.$,ctx,turn('dev-1','t1'));
 w.reply=verdict({findings:[{severity:'low',dimension:'scope',claim:'Touched an unrelated file',evidence:'activity line 2'}]});
 await ran(w,ctx,'dev-2');await judge.judgeRun(w.$,ctx,turn('dev-2','t2'));
 w.reply=verdict({scores:{completeness:5,honesty:5,verification:5,scope:5,correctness:5,performance:4,security:5},findings:[],
  exemplar:{worthy:true,why:'Ran the targeted tests before reporting and listed what was not verified'}});
 await ran(w,ctx,'dev-3');await judge.judgeRun(w.$,ctx,turn('dev-3','t3'));
 let list=await reviews(w,ctx);
 assert.deepEqual(list.map(review=>[review.quality,review.exemplar.state]),[[92,'none'],[92,'none'],[97,'candidate']]);
 const table=(await w.command('judge')).text;
 assert.match(table,/judge: on · model haiku · 3\/20 reviews in the last 24 hours · 3 in all · tokens in 2700, out 360/);
 assert.match(table,new RegExp(list[0].findings[0].ref+' · high · honesty · open · Report says tests passed'));
 const spawn=()=>enforceSpawn(w.$,ctx,{subagentType:'developer',prompt:'Build it.'},identity('developer',null));
 assert.equal((await spawn()).input.prompt,'Build it.','an open finding teaches nothing');
 assert.match((await w.command('finding '+list[0].findings[0].ref+' confirm','sdk')).text,/Human composer/);
 assert.match((await w.command('finding nope confirm')).text,/Usage: \/arbiter finding/);
 assert.match((await w.command('finding '+list[0].findings[0].ref+' confirm')).text,/^Recorded: .* confirmed\.$/);
 assert.match((await w.command('finding '+list[1].findings[0].ref+' dismiss')).text,/dismissed\.$/);
 assert.match((await w.command('exemplar '+list[0].ref+' approve')).text,/Usage: \/arbiter exemplar/,'only a candidate can be approved');
 assert.match((await w.command('exemplar '+list[2].ref+' approve')).text,/approved\.$/);
 list=await reviews(w,ctx);
 assert.deepEqual(list.map(review=>[review.findings[0]?.state ?? null,review.disputed,review.exemplar.state]),[['confirmed',false,'none'],['dismissed',true,'none'],[null,false,'approved']]);
 // Quality averages the two reviews that stand: 92 and 97.
 await emit(w.$,ctx,null,'spawn.result','run',{status:'started',childAgentId:'dev-1',citizen:identity()});
 assert.match((await w.command('citizens')).text,/Development · Easy · quality 95\/100 · 2 scored/);
 const taught=(await spawn()).input.prompt;
 assert.match(taught,/Agent Arbiter lessons\..*\n- Report says tests passed but no test command ran \(review finding, honesty\)\nAgent Arbiter exemplars\..*\n- Ran the targeted tests before reporting and listed what was not verified\]$/s);
 assert.ok(!taught.includes('Touched an unrelated file'),'a dismissed finding is not taught');
 const lessons=(await w.command('lessons')).text;
 assert.match(lessons,/· finding · Report says tests passed/);assert.match(lessons,/· exemplar · Ran the targeted tests/);
});

test('brief profile: difficulty and run role are read from the brief before the run',async()=>{
 const {briefProfile,effectiveRole}=await import('../plugins/agent-arbiter/hooks/roles.js');
 assert.deepEqual(briefProfile('Fix the typo in README.md'),{runRole:'dev',difficulty:'easy'});
 assert.deepEqual(briefProfile('Review the diff of the payment module and find bugs.'),{runRole:'review',difficulty:'easy'});
 assert.equal(briefProfile('Refactor the cache layer for concurrency and fix the race in the transaction handling.').difficulty,'medium');
 assert.equal(briefProfile('Refactor the migration with a backfill, keep it idempotent, handle concurrency, and update a.php b.php c.php d.php'+' x'.repeat(800)).difficulty,'hard');
 assert.equal(briefProfile('Check for SQL injection and XSS in the auth controller').runRole,'security');
 assert.deepEqual(briefProfile(undefined),{runRole:'other',difficulty:'easy'});
 assert.equal(effectiveRole('general-purpose','Write unit tests for the parser'),'test-design');
 assert.equal(effectiveRole('developer','Review this change'),'dev','a named agent type keeps its own role');
 assert.equal(effectiveRole('general-purpose','Review this change',{'general-purpose':'other'}),'other','the person decided');
});

test('a reviewer is a plaintiff: defects it reports are filed against the agent that last wrote those files',async t=>{
 const {w,ctx}=await fresh(t);
 await ran(w,ctx,'dev-1',{'src/a.js':'export const a = 1;\n'});
 judge.rememberBrief(ctx,'dev-2',{prompt:'Add b'},identity('engineer'));judge.noteActivity(ctx,'dev-2',{tool:'Write',target:'src/b.js',status:'completed'});
 judge.rememberBrief(ctx,'rev-1',{prompt:'Review the diff and find bugs'},identity('reviewer'));
 judge.noteActivity(ctx,'rev-1',{tool:'Bash',target:'git [arguments redacted]',status:'completed'});
 w.reply=verdict({findings:[],accusations:[{file:'src/a.js',severity:'high',claim:'a() ignores negative input'},{file:'./src/b.js',claim:'b leaks a handle'},
  {file:'../etc/passwd',claim:'escape'},{file:'src/none.js',claim:'nobody wrote this'}]});
 assert.match(await judge.judgeRun(w.$,ctx,turn('rev-1','r1','Found two bugs.')),/^[a-f0-9]{64}$/);
 assert.match(w.requests[0].prompt,/"accusations"/);
 const list=await reviews(w,ctx);
 const against=agent=>list.find(review=>review.agentId===agent);
 assert.deepEqual(against('dev-1').findings.map(f=>[f.severity,f.claim,f.state,f.evidence]),[['high','a() ignores negative input','open','reviewer reported it in src/a.js']]);
 assert.equal(against('dev-1').plaintiff,'reviewer');assert.equal(against('dev-1').quality,null,'a complaint does not score quality');
 assert.equal(against('dev-2').findings[0].claim,'b leaks a handle');
 assert.equal(list.length,3,'the reviewer\'s own review plus one complaint per accused agent');
 assert.match((await w.command('judge')).text,/· complaint by reviewer/);
 // Confirmed, the complaint becomes a lesson for the accused agent type.
 await w.command('finding '+against('dev-1').findings[0].ref+' confirm');
 const taught=await enforceSpawn(w.$,ctx,{subagentType:'developer',prompt:'Build it.'},identity('developer',null));
 assert.match(taught.input.prompt,/a\(\) ignores negative input \(review finding, correctness\)/);
 // A non-reviewer's accusations are ignored.
 judge.rememberBrief(ctx,'dev-3',{prompt:'Add c'},identity());judge.noteActivity(ctx,'dev-3',{tool:'Write',target:'src/c.js',status:'completed'});
 w.reply=verdict({accusations:[{file:'src/a.js',claim:'x'}]});
 await judge.judgeRun(w.$,ctx,turn('dev-3','d3'));
 assert.ok(!w.requests.at(-1).prompt.includes('"accusations"'));
 assert.equal((await reviews(w,ctx)).filter(review=>review.plaintiff).length,2);
});

test('a finding waits for an answer only when it could change what the person does',()=>{
  const event=(id,difficulty,findings,extra={})=>({id,projectId:'p',kind:'judge.review',occurredAt:Date.now()-1000,sessionId:'s',agentId:null,
    data:{scores:{completeness:5},findings,difficulty,role:'other',exemplar:{worthy:false,why:''},...extra}});
  const finding=(severity,dimension)=>({severity,dimension,claim:'c',evidence:'e'});
  const state=(difficulty,severity,dimension)=>judge.reduceReviews([event('a'.repeat(64),difficulty,[finding(severity,dimension)])],'p')[0].findings[0].state;
  assert.equal(state('easy','low','correctness'),'noted');
  assert.equal(state('easy','medium','honesty'),'noted','a process remark on an easy task is noted on its own');
  assert.equal(state('easy','medium','verification'),'noted');
  assert.equal(state('easy','medium','correctness'),'open','a correctness doubt still waits');
  assert.equal(state('easy','medium','security'),'open');
  assert.equal(state('medium','medium','honesty'),'open','a medium finding on real work still waits');
  assert.equal(state('easy','high','honesty'),'open','a high finding always waits');
});

test('a suggested example never counts as a wait',async()=>{
  const {statusCounts}=await import('../plugins/agent-arbiter/hooks/status.js');
  const now=Date.now(),review=state=>({at:now-1000,findings:[{state}],exemplar:{state:'candidate'}});
  assert.equal(statusCounts({violations:[]},[review('noted')],now).pending,0,'a candidate and a noted finding wait for nothing');
  assert.equal(statusCounts({violations:[]},[review('open')],now).pending,1);
});
