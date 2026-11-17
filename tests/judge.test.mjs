import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {world} from './fixtures.mjs';
import {observationContext} from '../extension/hooks/context.js';
import {enforceSpawn} from '../extension/hooks/spawn.js';
import {readProject,emit} from '../extension/hooks/events.js';
import * as discipline from '../extension/hooks/discipline.js';
import * as judge from '../extension/hooks/judge.js';

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
 assert.deepEqual([review.role,review.difficulty,review.quality,review.citizen.name,review.agentId],['dev','hard',92,'developer','dev-1']);
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
 assert.equal(JSON.parse((await w.command('finding '+list[0].findings[0].ref+' confirm')).text).decision,'confirmed');
 assert.equal(JSON.parse((await w.command('finding '+list[1].findings[0].ref+' dismiss')).text).decision,'dismissed');
 assert.match((await w.command('exemplar '+list[0].ref+' approve')).text,/Usage: \/arbiter exemplar/,'only a candidate can be approved');
 assert.equal(JSON.parse((await w.command('exemplar '+list[2].ref+' approve')).text).decision,'approved');
 list=await reviews(w,ctx);
 assert.deepEqual(list.map(review=>[review.findings[0]?.state ?? null,review.disputed,review.exemplar.state]),[['confirmed',false,'none'],['dismissed',true,'none'],[null,false,'approved']]);
 // Quality averages the two reviews that stand: 92 and 97.
 await emit(w.$,ctx,null,'spawn.result','run',{status:'started',childAgentId:'dev-1',citizen:identity()});
 assert.match((await w.command('citizens')).text,/quality 95 \(2 reviews, 2 hard\)/);
 const taught=(await spawn()).input.prompt;
 assert.match(taught,/Agent Arbiter lessons\..*\n- Report says tests passed but no test command ran \(review finding, honesty\)\nAgent Arbiter exemplars\..*\n- Ran the targeted tests before reporting and listed what was not verified\]$/s);
 assert.ok(!taught.includes('Touched an unrelated file'),'a dismissed finding is not taught');
 const lessons=(await w.command('lessons')).text;
 assert.match(lessons,/· finding · Report says tests passed/);assert.match(lessons,/· exemplar · Ran the targeted tests/);
});
