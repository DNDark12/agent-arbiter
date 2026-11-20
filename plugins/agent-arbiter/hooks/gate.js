import {analyzeBash} from './bash-risk.js';
import {loadProjectSettings,matchRules,COMMAND_ACTION} from './project-rules.js';
import {disciplineState,runRecord,recordViolation,rememberRefusal,refusedBefore,actionKeys,takeReport,citizenOf,REPORT_LIMIT,replacementHeld,replacementPending} from './discipline.js';
import {t,ruleLabel} from './i18n.js';
import {refreshStatus} from './status.js';
import {redact} from './privacy.js';
import {classifyTool} from './action.js';
import {currentEnforcement,approvedRules,checkCurrentPolicy} from './controls.js';
import {runtimeReady,hardLawBackup} from './runtime.js';
import {canonical,digest,replay} from './ledger.js';
import {readProject,emit} from './events.js';
import {reduceGrants} from './grants.js';
import {sentencing} from './sentencing.js';
import {reduceCases} from './cases.js';
import {recordHardLaw} from './court.js';
import {actorSentence,stopForHandover} from './prison.js';
import {worktreeRoots} from './forensics.js';
import {beginWait,noteDecision} from './notes.js';

const block=reason=>({deny:'Agent Arbiter: '+reason});
const turnBoundaries=new Map();
const reportBudget=new Map();
const pendingActors=new Map();
export function endedTurn(ctx,agentId){turnBoundaries.set(ctx.sessionId+':'+(agentId || ''),Date.now());}

// A host may discard a plugin's permission request and then allow the tool
// through its own policy. Only a surface with an Arbiter dialog can give consent.
async function hasApprovalSurface($){
  try{return (await $.session.surfaces()).length>0;}
  catch{return false;}
}
const approvalUnavailable=()=>block('approval requires an interactive session. Open Claude CLI or Desktop to review this action.');

async function askUnknown($,ctx,event){
  if(!await hasApprovalSurface($))return approvalUnavailable();
  const inputHash=await digest(canonical(event));
  const detail=redact(event.command || event.file_path || event.notebook_path || JSON.stringify(Object.keys(event)));
  const question=`Agent Arbiter cannot prove action/scope for ${event.tool}, actor ${event.agentId || 'main'}, project ${ctx.projectRoot}. Requested input: ${detail}. Check the original tool panel if redacted/truncated. Allow only this tool call ${event.tool_use_id || inputHash} (hash ${inputHash})? This is not a reusable grant.`;
  let answer='';
  const settle=beginWait($,ctx,event.agentId || null,event.tool_use_id || crypto.randomUUID(),'approval');
  try{answer=await $.ui.ask(question,['Deny','Allow']);}catch{ /* No answer never grants. */ }
  finally{await settle();}
  if(answer!=='Allow')return block('consent declined or unavailable; no violation recorded.');
  if(inputHash!==await digest(canonical(event)) || !(await runtimeReady($,ctx)).ready)return block('request or protected runtime changed during consent.');
  const read=await readProject($,ctx);
  if(read.invalid.length || replay(read.events).conflicts.length)return block('authenticated evidence integrity unavailable.');
  if(event.agentId && actorSentence(read.events,ctx,event.agentId).held)return block('agent detained while consent was pending.');
  await emit($,ctx,event.agentId || null,'tool.consent',event.tool_use_id || crypto.randomUUID(),{inputHash,allowed:true,source:{kind:'ui',origin:'composer',id:crypto.randomUUID()}});
  return null;
}

export async function enforceTool($,ctx,event,data,requestId){
  const key=ctx.sessionId+':'+(event.agentId || 'main');
  const previous=pendingActors.get(key) || Promise.resolve();
  const pending=previous.catch(()=>{}).then(async()=>{
    const state=await currentEnforcement($,ctx);
    return state.hardened?enforceToolOne($,ctx,event,data,requestId):enforceDefault($,ctx,event,state,requestId);
  });
  pendingActors.set(key,pending);
  try{return await pending;}finally{if(pendingActors.get(key)===pending)pendingActors.delete(key);}
}

async function enforceToolOne($,ctx,event,data,requestId){
  const state=await currentEnforcement($,ctx);
  if(state.mode==='off')return null;
  if(state.mode!=='enforce' && !ctx.authConfigured)return null;
  if(state.bindingMismatch || ctx.authError || !(await runtimeReady($,ctx)).ready)return block('protected runtime, scope or same-session OS proof unavailable.');
  if(state.mode!=='enforce')return null;
  const read=await readProject($,ctx);
  if(read.invalid.length || replay(read.events).conflicts.length)return block('authenticated evidence integrity unavailable.');
  const actor=event.agentId || null;
  const sentence=actorSentence(read.events,ctx,actor);
  if(actor && sentence.held){
    if(event.tool==='SubagentHandback'){
      const message=typeof event.message==='string'?event.message:null;
      const reportKey=ctx.sessionId+':'+actor+':'+canonical(sentence.caseIds);
      const count=Math.max(reportBudget.get(reportKey) || 0,read.events.filter(e=>e.kind==='handover.report' && e.sessionId===ctx.sessionId && e.agentId===actor && canonical(e.data.caseIds)===canonical(sentence.caseIds)).length);
      if(message!==null && message.length<=2048 && count<1){
        await emit($,ctx,actor,'handover.report',event.tool_use_id || crypto.randomUUID(),{messageHash:await digest(message),caseIds:sentence.caseIds});
        reportBudget.set(reportKey,count+1);return null;
      }
    }
    return block('agent detained; only one bounded final report is permitted.');
  }
  // An early child can call tools before spawn.result is returned. Hold it until
  // its actual resolved model/identity is bound; never infer the desired model.
  if(!await hardLawBackup($,ctx,(await approvedRules($,ctx,read.events)).rules))return block('engine deny backup missing; no sentence.');
  if(actor && read.events.some(e=>e.kind==='spawn.result' && e.sessionId===ctx.sessionId && e.data.childAgentId===actor && e.data.modelVerified===false))return block('actual replacement model not verified; writer held.');
  if(actor && !sentence.known)return block('agent identity/model binding pending or unknown; no guilt inferred.');
  if(['AskUserQuestion','TaskStop','SubagentHandback'].includes(event.tool))return null;
  const classified=event.tool==='Bash'?{kind:'unknown',reason:'Bash cwd/remote scope unproven'}:classifyTool(event,{...ctx,environment:'local',file:data.file});
  if(classified.kind==='read')return null;
  if(classified.kind!=='action')return askUnknown($,ctx,event);
  // No trusted Bash cwd/remote/environment is supplied by this gate. Its grammar
  // is unit-tested but Bash remains unknown in the production integration.
  const activeCases=new Set(reduceCases(read.events,ctx.projectId).cases.filter(record=>record.status==='active').map(record=>record.caseId));
  const probation=sentence.restrictions.includes('probation') || read.events.some(e=>e.kind==='spawn.result' && e.sessionId===ctx.sessionId && e.data.childAgentId===actor && e.data.probationFrom?.some(id=>activeCases.has(id)));
  const request=classified.request;
  const laws=await approvedRules($,ctx,read.events);
  const decision=checkCurrentPolicy(request,reduceGrants(read.events),laws,ctx,Date.now());
  if(decision.outcome==='allow')return probation?askUnknown($,ctx,event):null;
  if(probation && decision.reason==='approval-required')return askUnknown($,ctx,event);
  if(decision.outcome!=='deny' || !decision.violation || !requestId)return block('action held pending permission/review; no sentence.');
  const law=laws.rules.find(rule=>rule.id===decision.lawId);
  if(!law)return block('law unavailable; no sentence.');
  const lastBoundary=Math.max(turnBoundaries.get(ctx.sessionId+':'+(actor || '')) || 0,...read.events.filter(e=>e.kind==='turn.complete' && e.sessionId===ctx.sessionId && e.agentId===actor).map(e=>e.occurredAt));
  const prior=read.events.filter(e=>e.kind==='policy.enforced' && e.sessionId===ctx.sessionId && e.agentId===actor && e.data.lawId===law.id && e.data.violation===true && e.occurredAt>lastBoundary && e.data.requestId!==requestId);
  const proposal=sentencing({decision,actorId:actor,group:law.group,repeatInTurn:prior.length>0,attributableHarm:false});
  if(proposal.type==='none')return block('unapproved action; evidence insufficient for a sentence.');
  const effects={trustDelta:proposal.type==='fine'?-state.policy.finePoints:0,restrictions:proposal.type==='detain'?['detain','imprison']:[proposal.type],lessonIds:[]};
  if((await currentEnforcement($,ctx)).mode!=='enforce')return null;
  try{
    const judgment=await recordHardLaw($,ctx,{citizenId:actor?sentence.citizenId:null,actor:{sessionId:ctx.sessionId,agentId:actor},law:{id:law.id,version:law.version},evidenceIds:[requestId],outcome:'guilty',reason:'Known hard-law action without a matching scoped grant under the human-selected grants-only protocol.',effects},read.events);
    if(judgment.recording==='rejected')return block('action denied; existing case retained for review.');
    await emit($,ctx,actor,'policy.enforced',event.tool_use_id || requestId,{lawId:law.id,requestId,caseId:judgment.caseId,violation:true,proposal:proposal.type});
    let handover;
    if(actor && ['detain','imprison'].includes(proposal.type)){
      handover=await stopForHandover($,ctx,actor,(await readProject($,ctx)).events);
      await emit($,ctx,actor,'handover.checked',judgment.caseId,{caseId:judgment.caseId,...handover});
    }
    return {...block(`${proposal.type}; case ${judgment.caseId}. Obtain an exact /arbiter grant before retrying. Appeal/pardon remain available.`),context:handover && !handover.safe?'Agent Arbiter: handover not proven safe; replacement writer must wait.':undefined};
  }catch{return block('action denied; sentencing/storage outcome unconfirmed. Inspect docket before retrying.');}
}


function absolutePath(path,root){
  if(typeof path!=='string' || !path || path.includes('\0'))return null;
  const parts=(path.startsWith('/')?path:root+'/'+path).split('/'),out=[];
  for(const part of parts){if(!part || part==='.')continue;if(part==='..')out.pop();else out.push(part);}
  return '/'+out.join('/');
}
function within(path,root){return typeof root==='string' && (path===root || path.startsWith(root+'/'));}
async function resolvedPath($,path,root){
  const absolute=absolutePath(path,root);if(!absolute)return null;
  let cursor=absolute,tail=[];
  while(cursor!=='/'){
    try{const stat=await $.fs.stat(cursor,{resolve:true});return (stat.realPath || cursor)+(tail.length?'/'+tail.reverse().join('/'):'');}
    catch{tail.push(cursor.slice(cursor.lastIndexOf('/')+1));cursor=cursor.slice(0,cursor.lastIndexOf('/')) || '/';}
  }
  return absolute;
}
// Scratch space and folders a build recreates: removing them is routine work.
const TEMP_ROOTS=['/tmp','/private/tmp','/var/tmp','/private/var/tmp','/var/folders','/private/var/folders'];
const REGENERABLE=new Set(['node_modules','dist','build','coverage','.cache','.next','.nuxt','.turbo','.parcel-cache','__pycache__','.pytest_cache','tmp','.tmp']);
// 'court': Arbiter's own data and code. 'claude': Claude settings and agent definitions.
function protectedKind(path,ctx,removal=false){
  const covers=root=>typeof root==='string' && root.length>0 && (within(path,root) || removal && within(root,path));
  if([ctx.archiveRoot,ctx.dataRoot,ctx.configRoot+'/plugins/data/agent-arbiter',ctx.pluginRoot].some(covers))return 'court';
  if([ctx.configRoot+'/agents',ctx.projectRoot+'/.claude/agents',ctx.root+'/.claude/agents'].some(covers))return 'claude';
  const globalFiles=[ctx.home?ctx.home+'/.claude.json':null,ctx.configRoot+'/.claude.json'];
  if(globalFiles.some(file=>file && (path===file || removal && within(file,path))))return 'claude';
  return [ctx.configRoot,ctx.projectRoot+'/.claude',ctx.root+'/.claude'].some(root=>
    path===root+'/settings.json' || path===root+'/settings.local.json' || path===root+'/settings.local.json.bak' || removal && within(root+'/settings.json',path))?'claude':null;
}
let lastContext=null;
export function fallbackTool(event){
  if(['Read','Grep','Glob','AskUserQuestion','SubagentHandback','TaskStop'].includes(event.tool))return null;
  if(event.tool==='Bash')return analyzeBash(event.command,lastContext?.root || '/').actions.length?block('sensitive command could not be checked; retry after inspecting Arbiter status.'):null;
  const path=absolutePath(event.file_path || event.notebook_path,lastContext?.root || '/');
  return path && lastContext && (protectedKind(path,lastContext) || !within(path,lastContext.root))?block('sensitive write could not be checked.'):null;
}
async function defaultActions($,ctx,event){
  let actions=[];
  if(event.tool==='Bash'){
    const analysis=analyzeBash(event.command,ctx.root);
    actions=[...analysis.actions,...analysis.optional,...analysis.commands.map(target=>({action:COMMAND_ACTION,target}))];
  }
  else if(['Write','Edit','MultiEdit','NotebookEdit'].includes(event.tool)){
    const target=event.file_path || event.notebook_path;
    if(typeof target==='string')actions=[{action:'file.write',target}];
  }
  const result=[];
  let worktrees=null;
  for(const item of actions){
    if(item.action!=='file.write' && item.action!=='fs.remove'){result.push(item);continue;}
    const removal=item.action==='fs.remove';
    const lexical=absolutePath(item.target,ctx.root),resolved=await resolvedPath($,item.target,ctx.root);
    if(!resolved){result.push(item);continue;}
    let kind=protectedKind(lexical,ctx,removal) || protectedKind(resolved,ctx,removal);
    let base=within(resolved,ctx.root)?ctx.root:null;
    // Another checkout of the same repository (a git worktree) is the same project;
    // its own Claude settings and agent definitions stay protected.
    if(!base && !kind){
      worktrees??=await worktreeRoots($,ctx.projectRoot || ctx.root);
      const tree=worktrees.find(root=>root!==ctx.root && within(resolved,root));
      if(tree){base=tree;kind=protectedKind(resolved,{...ctx,root:tree,projectRoot:tree},removal);}
    }
    const inside=base!==null;
    const temporary=!inside && TEMP_ROOTS.some(root=>resolved.startsWith(root+'/'));
    item.target=resolved;
    if(inside)item.relativeTarget=resolved.slice(base.length+1) || '.';
    const routine=!kind && removal && (temporary || inside && REGENERABLE.has(resolved.slice(resolved.lastIndexOf('/')+1)));
    if(!routine)result.push(item);
    if(kind)result.push({action:kind==='court'?'file.arbiter':'file.protected',target:resolved});
    else if(!inside && !temporary)result.push({action:'file.external',target:resolved});
  }
  return result;
}

// Rules the person allowed for the rest of this session; process memory only.
const sessionAllows=new Map();
const consentScope=ctx=>ctx.projectId+':'+ctx.sessionId;
const consentRule=rule=>canonical([rule.id,rule.action,rule.target,rule.effect]);
function sessionAllowed(ctx,rules){
  const allowed=sessionAllows.get(consentScope(ctx));
  return !!allowed && rules.every(rule=>allowed.has(consentRule(rule)));
}
function describe(actions,quiet=false){
  // Inside the project the short relative path reads better than the real path.
  // quiet: leave the command text out, for records of calls that broke nothing.
  return redact(actions.map(item=>item.action===COMMAND_ACTION?(quiet?'run a command matching the rule':'run '+item.target):item.action+' on '+(item.relativeTarget ?? item.target)).join('; ')).slice(0,400);
}
function sanctionMessage(record,rules){
  const ids=rules.map(rule=>rule.id).join(', ');
  if(record.sanction==='detain')return block(`denied by rule: ${ids}. This agent is now detained: every further tool call is refused. Send one short final report to the lead now.`);
  if(record.sanction==='fine')return block(`denied by rule: ${ids}. Violation recorded (fine, -${record.points} points). Do not retry or work around it: a second violation detains this agent. If the task needs this action, report that to the lead.`);
  return block(`denied by rule: ${ids}. Warning recorded. The person can change rules in /arbiter rules.`);
}
async function violate($,ctx,event,decision,receipt,reason,requestId){
  const record=await recordViolation($,ctx,event,{ruleIds:receipt.ruleIds,reason,severe:decision.severe,detail:receipt.detail,requestId});
  void refreshStatus($,ctx);
  return sanctionMessage(record,decision.rules);
}
async function enforceDefault($,ctx,event,state,requestId){
  lastContext=ctx;
  if(state.mode!=='enforce')return null;
  const actor=event.agentId || null;
  let discipline=null;
  if(actor){
    try{discipline=await disciplineState($,ctx);}catch{ /* Unknown history never detains. */ }
    if(replacementPending(ctx) && (!discipline || !citizenOf(discipline,ctx,actor)))return block('replacement model/identity binding pending; retry after spawn verification. No violation recorded.');
    if(discipline && replacementHeld(discipline,ctx,actor))return block('replacement held: actual model was not verified as different from the detained model.');
    if(discipline && runRecord(discipline,ctx.sessionId,actor).detained){
      if(event.tool==='SubagentHandback' && typeof event.message==='string' && event.message.length<=REPORT_LIMIT && takeReport(ctx,actor))return null;
      return block('this agent is detained after breaking project rules. Every tool call is refused. Send one short final report to the lead.');
    }
  }
  const actions=await defaultActions($,ctx,event);
  if(!actions.length)return null;
  const decision=matchRules(actions,await loadProjectSettings($,ctx));
  if(decision.effect==='allow')return null;
  const keys=await actionKeys(decision.matched);
  const receipt={effect:decision.effect,ruleIds:decision.rules.map(r=>r.id),detail:describe(decision.matched),quietDetail:describe(decision.matched,true),actionKeys:keys};
  if(decision.effect==='deny'){
    await recordDecision($,ctx,event,receipt,'denied-by-rule');
    return violate($,ctx,event,decision,receipt,decision.severe?'severe-rule':'deny-rule',requestId);
  }
  // The person already said no to this action in this run: trying again, or
  // reaching the same target another way, is a violation rather than a question.
  if(actor && discipline && refusedBefore(discipline,ctx,actor,keys)){
    await recordDecision($,ctx,event,receipt,'retry-after-refusal');
    return violate($,ctx,event,decision,receipt,'retry-after-refusal',requestId);
  }
  if(sessionAllowed(ctx,decision.rules)){await recordDecision($,ctx,event,receipt,'session-allow');return null;}
  if(!await hasApprovalSurface($)){
    await recordDecision($,ctx,event,receipt,'unanswered');
    return approvalUnavailable();
  }
  const labels={deny:t('ask.deny'),once:t('ask.once'),session:t('ask.session')};
  const citizen=actor && discipline?citizenOf(discipline,ctx,actor):null;
  const who=actor?t('actor.agent',{name:citizen?citizen.name+(citizen.model?' ('+citizen.model+')':''):actor}):t('actor.main');
  const command=typeof event.command==='string'?t('ask.command',{command:redact(event.command).slice(0,300)}):'';
  const question=t('ask.question',{actor:who,detail:receipt.detail,command,rules:decision.rules.map(ruleLabel).join('; ')});
  let answer='';
  const settle=beginWait($,ctx,actor,event.tool_use_id || crypto.randomUUID(),'approval');
  // Allow first: the common answer is one keystroke. Skip or dismiss still never grants.
  try{answer=await $.ui.ask(question,[labels.once,labels.session,labels.deny]);}catch{ /* Dismissed/unavailable never grants. */ }
  finally{await settle();}
  if(answer!==labels.once && answer!==labels.session){
    const refused=answer===labels.deny;
    if(refused && actor)rememberRefusal(ctx,actor,keys);
    await recordDecision($,ctx,event,receipt,refused?'refused':'unanswered');
    return block('approval declined or unavailable; no sentence recorded.');
  }
  const current=await currentEnforcement($,ctx);
  const freshActions=await defaultActions($,ctx,event);
  if(canonical(freshActions)!==canonical(actions))return block('action target changed while approval was pending; retry.');
  const fresh=matchRules(freshActions,await loadProjectSettings($,ctx));
  if(current.mode==='enforce' && (current.hardened || fresh.effect==='deny'))return block('rule or mode changed while approval was pending; retry.');
  if(actor && current.mode==='enforce' && runRecord(await disciplineState($,ctx),ctx.sessionId,actor).detained)return block('agent detained while approval was pending.');
  if(answer===labels.session){
    if(!sessionAllows.has(consentScope(ctx)))sessionAllows.set(consentScope(ctx),new Set());
    for(const rule of decision.rules)sessionAllows.get(consentScope(ctx)).add(consentRule(rule));
  }
  await recordDecision($,ctx,event,receipt,'approved');return null;
}

async function recordDecision($,ctx,event,receipt,outcome){
  // The ledger keeps a command's text only for a violation or a refusal.
  const {quietDetail,...stored}=receipt;
  if(!['denied-by-rule','retry-after-refusal','refused'].includes(outcome))stored.detail=quietDetail;
  noteDecision(event.tool_use_id,receipt.ruleIds,outcome);
  try{await emit($,ctx,event.agentId || null,'rule.decision',event.tool_use_id || crypto.randomUUID(),{...stored,outcome,allowed:outcome==='approved' || outcome==='session-allow'});}
  catch{ /* Evidence failure never substitutes for consent or penalizes a normal tool. */ }
}
