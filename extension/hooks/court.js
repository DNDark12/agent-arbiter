import { canonical, digest, publish, replay } from './ledger.js';
import { emit } from './events.js';
import { caseId, caseReason, normalizeJudgment, reduceCases, lawAppliesToRequest } from './cases.js';
import { builtinHistory, normalizeRule } from './statutes.js';
import { redact } from './privacy.js';

const HUMAN = new Set(['composer','bridge']);
const ID = /^[a-f0-9]{64}$/;
function reply(value) { return {text:typeof value==='string'?value:canonical(value)}; }
function sourceValid(source) { return source?.kind==='command' && HUMAN.has(source.origin) && typeof source.id==='string' && source.id.length>0; }

function verdictSourceValid(source) { return sourceValid(source) || (source?.kind==='court' && source.origin==='hard-law' && typeof source.id==='string' && source.id.length>0); }

async function knownLaw(input, events) {
  const builtin=(await builtinHistory()).map(rule=>({rule,sourceEventId:null,approvedAt:null}));
  const historical=[...events].sort((a,b)=>a.occurredAt-b.occurredAt || (a.id<b.id?-1:a.id>b.id?1:0))
    .filter(e=>e.kind==='laws.approved' && sourceValid(e.data.source) && Array.isArray(e.data.rules))
    .flatMap(e=>e.data.rules.map(rule=>({rule:normalizeRule(rule),sourceEventId:e.id,approvedAt:e.occurredAt})));
  const matches=[...builtin,...historical].filter(item=>item.rule?.id===input?.id && item.rule.version===input?.version);
  return matches.length && new Set(matches.map(item=>canonical(item.rule))).size===1 ? matches[0] : null;
}

async function prepareJudgment(input, ctx, events) {
  if (!input || typeof input.reason!=='string' || !input.reason.trim() || !Array.isArray(input.evidenceIds) || !input.evidenceIds.length || input.evidenceIds.length>100) throw new Error('Evidence IDs required');
  const evidenceIds=[...new Set(input.evidenceIds)].sort();
  if (evidenceIds.some(id=>typeof id!=='string' || !ID.test(id))) throw new Error('Evidence IDs invalid');
  const evidence=evidenceIds.map(id=>events.find(e=>e.id===id && e.projectId===ctx.projectId));
  if (evidence.some(e=>!e)) throw new Error('Evidence missing from project');
  const law=await knownLaw(input.law,events);
  if (!law) throw new Error('Law/version has no unique known source');
  const actor=input.actor;
  if (!actor || typeof actor.sessionId!=='string' || !actor.sessionId || !(actor.agentId===null || typeof actor.agentId==='string')) throw new Error('Evidence actor required');
  const toolEvidence=evidence.filter(e=>e.kind==='tool.request' || e.kind==='tool.result');
  if (toolEvidence.some(e=>e.sessionId!==actor.sessionId || e.agentId!==actor.agentId)) throw new Error('Evidence actor does not match');
  const bindingEvents=events.filter(e=>e.kind==='spawn.result' && e.sessionId===actor.sessionId && e.data.status==='started' && e.data.childAgentId===actor.agentId)
    .sort((a,b)=>a.occurredAt-b.occurredAt || (a.id<b.id?-1:a.id>b.id?1:0));
  const bindings=new Set(bindingEvents.map(e=>e.data.citizen?.id));
  if (actor.agentId!==null && input.citizenId!==null && (bindings.size!==1 || bindingEvents.some(e=>!ID.test(e.data.citizen?.id)) || !bindings.has(input.citizenId))) throw new Error('Citizen binding unavailable or contradictory');
  if (input.outcome==='guilty' && !toolEvidence.some(event=>lawAppliesToRequest(law.rule,law.approvedAt,event))) throw new Error('Action, scope or prior law approval cannot be proven from real request evidence');
  const id=await caseId(input.law.id,input.law.version,evidenceIds);
  const dependencyIds=[...(actor.agentId!==null && input.citizenId!==null && bindingEvents.length?[bindingEvents[0].id]:[]),...(law.sourceEventId?[law.sourceEventId]:[])];
  const judgment=normalizeJudgment({...input,dependencyIds,caseId:id,evidenceIds,reason:redact(input.reason),anchorAt:Math.max(...evidence.map(e=>e.occurredAt))});
  if (!judgment) throw new Error('Judgment/effects invalid; unknown identity cannot be punished');
  return judgment;
}

// One immutable verdict filename across adjudicating sessions. Evidence month anchors
// its directory, while occurredAt remains actual decision time (including late trials).
async function publishJudgment($, ctx, judgment, source) {
  const event={schemaVersion:1,id:judgment.caseId,projectId:ctx.projectId,sessionId:ctx.sessionId,agentId:null,
    kind:'verdict.recorded',occurredAt:Date.now(),data:{judgment,source}};
  const month=new Date(judgment.anchorAt).toISOString().slice(0,7);
  const directory=`${ctx.dataRoot}/events/${ctx.projectId}/${month}`;
  const path=`${directory}/${event.id}.json`;
  const result=await $.fs.exists(path)?'conflict':await publish($,directory,event,ctx.signer);
  if (result==='published') return {caseId:judgment.caseId,evidenceId:event.id,duplicate:false,projectionOnly:true};
  const info=await $.fs.stat(path);
  if (info.kind!=='file' || info.isLink) throw new Error('Case evidence is not a regular file');
  const envelope=JSON.parse(await $.fs.read(path));
  const prior=JSON.parse(envelope.body);
  if ((ctx.signer && !await ctx.signer.verify(envelope.body,envelope.auth)) || envelope.id!==event.id || prior.id!==event.id || prior.schemaVersion!==1 || prior.projectId!==ctx.projectId ||
      prior.kind!=='verdict.recorded' || !verdictSourceValid(prior.data?.source) ||
      canonical(prior)!==envelope.body || await digest(envelope.body)!==envelope.sha256) throw new Error('Prior case integrity invalid');
  const normalized=normalizeJudgment(prior.data.judgment);
  if (normalized && canonical(normalized)===canonical(judgment)) return {caseId:judgment.caseId,evidenceId:prior.id,duplicate:true,projectionOnly:true};
  return {caseId:judgment.caseId,evidenceId:prior.id,recording:'rejected',reason:'existing-verdict-differs; use appeal',projectionOnly:true};
}

export async function recordHardLaw($,ctx,input,events){
  if(!ctx.signer || ctx.authError)throw new Error('Authenticated hard-law evidence required');
  const judgment=await prepareJudgment(input,ctx,events);
  return publishJudgment($,ctx,judgment,{kind:'court',origin:'hard-law',id:judgment.caseId});
}

export async function handleCaseCommand($, e, ctx, read, command, body) {
  if (!['verdict','docket','record','appeal','pardon'].includes(command)) return null;
  const human=HUMAN.has(e.origin?.kind);
  if (['verdict','pardon'].includes(command) && !human) return reply('Human composer/bridge authority required for judgments and pardons.');
  const state=reduceCases(read.events,ctx.projectId);
  const ledgerConflicts=replay(read.events).conflicts;
  const integrity={invalidCount:read.invalid.length,ledgerConflictCount:ledgerConflicts.length,caseConflictCount:state.conflicts.length};
  if (command==='docket') {
    const times=new Map(read.events.map(event=>[event.id,event.occurredAt]));
    const last=record=>Math.max(...record.historyEventIds.map(id=>times.get(id)||0));
    const recent=[...state.cases].sort((a,b)=>last(b)-last(a)||(a.caseId<b.caseId?-1:a.caseId>b.caseId?1:0)).slice(0,20);
    return reply({cases:recent,integrity,projectionOnly:true,enforced:false});
  }
  if (command==='record') {
    if (!ID.test(body)) return reply('Expected citizen ID (64 lowercase hex).');
    return reply({citizen:state.citizens.find(c=>c.citizenId===body) || null,cases:state.cases.filter(c=>c.citizenId===body),integrity,projectionOnly:true,enforced:false});
  }
  if (command==='verdict') {
    if (read.invalid.length || ledgerConflicts.length) return reply('Ledger integrity unavailable; cannot record judgment.');
    let judgment;
    try { judgment=await prepareJudgment(JSON.parse(body),ctx,read.events); }
    catch { return reply('Judgment rejected: evidence, citizen, law/version or effects could not be verified.'); }
    try { return reply(await publishJudgment($,ctx,judgment,{kind:'command',origin:e.origin.kind,id:crypto.randomUUID()})); }
    catch {
      // A link may already exist even if cleanup/acknowledgment failed.
      return reply({caseId:judgment.caseId,evidenceId:judgment.caseId,recording:'unconfirmed',projectionOnly:true,
        message:'Storage outcome unconfirmed; inspect docket/evidence before retrying.'});
    }
  }

  const split=body.indexOf(' ');
  const id=split<0?body:body.slice(0,split);
  const tail=split<0?'':body.slice(split+1).trim();
  if (!ID.test(id)) return reply('Expected case ID (64 lowercase hex).');
  const existing=state.cases.find(c=>c.caseId===id);
  if (!existing) return reply('Case not found in this project.');
  if (read.invalid.length || ledgerConflicts.length) return reply('Ledger integrity unavailable; only case diagnostics are available.');
  const source={kind:'command',origin:e.origin?.kind || 'unclassified',id:crypto.randomUUID()};
  if (command==='pardon') {
    const reason=caseReason(redact(tail || 'Human pardon').trim());
    if (reason===null) return reply('Pardon reason must contain valid text without NUL.');
    const evidenceId=await emit($,ctx,null,'case.pardoned',source.id,{caseId:id,source,reason});
    return reply({caseId:id,pardoned:true,evidenceId,projectionOnly:true});
  }
  let input={reason:tail || 'Review requested'};
  if (tail.startsWith('{')) {
    try {input=JSON.parse(tail);} catch {return reply('Invalid appeal JSON.');}
  }
  const rawReason=input.reason===undefined?(Object.hasOwn(input,'decision')?'Human appeal decision':'Review requested'):input.reason;
  const reason=typeof rawReason==='string'?caseReason(redact(rawReason).trim()):null;
  if (reason===null) return reply('Appeal reason must contain non-whitespace text without NUL.');
  if (Object.hasOwn(input,'decision')) {
    if (!human) return reply('Human composer/bridge authority required to decide an appeal.');
    if (!['uphold','overturn','unknown'].includes(input.decision)) return reply('Appeal decision must be uphold, overturn or unknown.');
    const evidenceId=await emit($,ctx,null,'appeal.decided',source.id,{caseId:id,decision:input.decision,reason,source});
    return reply({caseId:id,decision:input.decision,evidenceId,projectionOnly:true});
  }
  const evidenceId=await emit($,ctx,null,'appeal.requested',source.id,{caseId:id,reason,source});
  return reply({caseId:id,appeal:'pending',evidenceId,projectionOnly:true});
}
