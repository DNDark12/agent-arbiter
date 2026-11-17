import { canonical, digest, replay } from './ledger.js';
import { ACTIONS, normalizeRule } from './statutes.js';

const ID = /^[a-f0-9]{64}$/;
const RESTRICTIONS = ['warning', 'fine', 'probation', 'detain', 'imprison', 'life'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 256) => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= limit && !value.includes('\0');
const identity = value => typeof value === 'string' && ID.test(value);
const sorted = values => [...new Set(values)].sort();
export function caseReason(value) { return text(value,4096) ? value : null; }
const noEffects = () => ({ trustDelta: 0, restrictions: [], lessonIds: [] });
const human = source => object(source) && source.kind === 'command' &&
  ['composer', 'bridge'].includes(source.origin) && text(source.id);
const adjudicator = source => human(source) || (object(source) && source.kind==='court' && source.origin==='hard-law' && text(source.id));
const requestSource = source => object(source) && source.kind === 'command' &&
  text(source.origin) && text(source.id);

export function lawAppliesToRequest(rule, approvedAt, event) {
  if (event.kind!=='tool.request') return false;
  let observed;
  if (['Write','Edit','NotebookEdit'].includes(event.data.tool)) {
    observed={action:'source.write',target:event.data.file?.path??null,environment:event.data.environment??null};
  } else if (event.data.tool==='Bash') {
    observed=event.data.action;
  }
  if (!observed || observed.action!==rule.action || (rule.target!==null && observed.target!==rule.target) ||
      (rule.environment!==null && observed.environment!==rule.environment)) return false;
  // Equal millisecond timestamps do not prove that approval preceded the action.
  return approvedAt===null || approvedAt<event.occurredAt;
}

export async function caseId(lawId, lawVersion, evidenceIds) {
  if (!text(lawId) || !identity(lawVersion) || !Array.isArray(evidenceIds) ||
      !evidenceIds.length || !evidenceIds.every(identity)) throw new TypeError('Invalid case identity');
  return digest(canonical([lawId, lawVersion, sorted(evidenceIds)]));
}

// Structural validation only: the writer must verify the ID hash, actual evidence,
// law version, citizen binding and command provenance before recording a verdict.
export function normalizeJudgment(input) {
  if (!object(input) || !identity(input.caseId) ||
      !(input.citizenId === null || identity(input.citizenId)) ||
      !object(input.actor) || !text(input.actor.sessionId) ||
      !(input.actor.agentId === null || text(input.actor.agentId)) ||
      !object(input.law) || !text(input.law.id) || !identity(input.law.version) ||
      !Array.isArray(input.evidenceIds) || !input.evidenceIds.length ||
      !input.evidenceIds.every(identity) || !['guilty', 'not-guilty', 'unknown'].includes(input.outcome) ||
      caseReason(input.reason)===null || !Number.isFinite(input.anchorAt) || !object(input.effects)) return null;
  const dependencyIds=input.dependencyIds===undefined?[]:input.dependencyIds;
  if (!Array.isArray(dependencyIds) || !dependencyIds.every(identity)) return null;
  const effects = input.effects;
  const trustDelta = effects.trustDelta === undefined ? 0 : effects.trustDelta;
  if (!Number.isSafeInteger(trustDelta) || trustDelta > 0 ||
      !Array.isArray(effects.restrictions) || !effects.restrictions.every(value => RESTRICTIONS.includes(value)) ||
      !Array.isArray(effects.lessonIds) || !effects.lessonIds.every(identity)) return null;
  const restrictions = sorted(effects.restrictions);
  const lessonIds = sorted(effects.lessonIds);
  if (input.outcome !== 'guilty' && (trustDelta !== 0 || restrictions.length || lessonIds.length)) return null;
  if (input.outcome === 'guilty' && input.actor.agentId !== null && input.citizenId === null) return null;
  if (input.actor.agentId === null && input.citizenId !== null) return null;
  if (input.actor.agentId === null && (trustDelta !== 0 || lessonIds.length ||
      restrictions.some(value => value !== 'warning'))) return null;
  return { caseId: input.caseId, citizenId: input.citizenId,
    actor: { sessionId: input.actor.sessionId, agentId: input.actor.agentId },
    law: { id: input.law.id, version: input.law.version }, evidenceIds: sorted(input.evidenceIds),
    outcome: input.outcome, reason: input.reason,
    effects: { trustDelta, restrictions, lessonIds }, dependencyIds:sorted(dependencyIds), anchorAt: input.anchorAt };
}

function validEvent(event, projectId) {
  return object(event) && event.schemaVersion === 1 && identity(event.id) &&
    event.projectId === projectId && identity(event.projectId) && text(event.sessionId) &&
    (event.agentId === null || text(event.agentId)) && text(event.kind) &&
    Number.isFinite(event.occurredAt) && object(event.data);
}

function compare(left, right) {
  return left.occurredAt - right.occurredAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function referencedCase(event) {
  const value = event.kind === 'verdict.recorded' ? event.data.judgment?.caseId : event.data.caseId;
  return identity(value) ? value : null;
}

export function reduceCases(events, projectId) {
  const variants = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!validEvent(event, projectId)) continue;
    let body;
    try { body = canonical(event); } catch { continue; }
    if (!variants.has(event.id)) variants.set(event.id, new Map());
    variants.get(event.id).set(body, JSON.parse(body));
  }
  const accepted = [];
  const all = [];
  const conflicts = [];
  const disputedTargets = new Set();
  const caseConflicts = new Map();
  const markCase = (id, eventId) => {
    if (!identity(id)) return;
    if (!caseConflicts.has(id)) caseConflicts.set(id, new Set());
    caseConflicts.get(id).add(eventId);
  };
  for (const id of [...variants.keys()].sort()) {
    const bodies = variants.get(id);
    const values = [...bodies.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, value]) => value);
    all.push(...values);
    if (values.length === 1) accepted.push(values[0]);
    else {
      conflicts.push({ type: 'event-id', id, variantCount: values.length });
      disputedTargets.add(id);
      for (const value of values) {
        markCase(referencedCase(value), id);
        if (value.kind === 'ledger.conflict' && identity(value.data.targetId)) {
          disputedTargets.add(value.data.targetId);
        }
      }
    }
  }
  accepted.sort(compare);
  const evidenceById = new Map(accepted.map(event => [event.id,event]));
  for (const conflict of replay(accepted).conflicts) {
    if (conflict.type !== 'tool-call') continue;
    for (const id of [...conflict.requestIds,...conflict.resultIds]) disputedTargets.add(id);
    conflicts.push({...conflict,type:'evidence-tool-call'});
  }
  const records = new Map();
  // Preserve disputed verdicts as visible records, but never apply their effects.
  for (const event of all) {
    if (event.kind !== 'verdict.recorded' || !adjudicator(event.data.source)) continue;
    const judgment = normalizeJudgment(event.data.judgment);
    if (!judgment) continue;
    if (!records.has(judgment.caseId)) records.set(judgment.caseId,
      { judgments: new Map(), verdictEventIds: new Set(), historyEventIds: new Set() });
    const record = records.get(judgment.caseId);
    record.judgments.set(canonical(judgment), judgment);
    record.verdictEventIds.add(event.id);
    record.historyEventIds.add(event.id);
  }
  for (const event of accepted) {
    if (event.kind === 'ledger.conflict' && identity(event.data.targetId)) {
      disputedTargets.add(event.data.targetId);
      conflicts.push({ type: 'persisted-conflict', id: event.id, targetId: event.data.targetId });
    }
    if (event.kind === 'case.conflicted' && identity(event.data.caseId)) {
      markCase(event.data.caseId, event.id);
      conflicts.push({ type: 'case-conflict', id: event.id, caseId: event.data.caseId });
    }
  }
  for (const event of all) {
    if (disputedTargets.has(event.id)) markCase(referencedCase(event), event.id);
  }
  const cases = [];
  for (const id of [...records.keys()].sort()) {
    const record = records.get(id);
    const judgments = [...record.judgments.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const judgment = judgments[0][1];
    const verdictEventIds = sorted(record.verdictEventIds);
    if (judgments.length > 1) {
      conflicts.push({ type: 'judgment', caseId: id, eventIds: verdictEventIds });
      for (const eventId of verdictEventIds) markCase(id, eventId);
    }
    for (const [, value] of judgments) {
      for (const evidenceId of [...value.evidenceIds,...value.dependencyIds]) {
        if (disputedTargets.has(evidenceId)) markCase(id, evidenceId);
      }
    }
    for (const [,value] of judgments) {
      for (const evidenceId of [...value.evidenceIds,...value.dependencyIds]) {
        if (!evidenceById.has(evidenceId)) {
          markCase(id,evidenceId);
          conflicts.push({type:'missing-evidence',caseId:id,id:evidenceId});
        }
      }
    }
    for (const [,value] of judgments) {
      if (value.outcome!=='guilty') continue;
      if (value.actor.agentId!==null && !value.dependencyIds.some(dependencyId=>{
        const event=evidenceById.get(dependencyId);
        return event?.kind==='spawn.result' && event.sessionId===value.actor.sessionId &&
          event.data.status==='started' && event.data.childAgentId===value.actor.agentId && event.data.citizen?.id===value.citizenId;
      })) {
        markCase(id,id);conflicts.push({type:'missing-identity-provenance',caseId:id,id});
      }
      const requests=value.evidenceIds.map(evidenceId=>evidenceById.get(evidenceId)).filter(event=>
        event && event.sessionId===value.actor.sessionId && event.agentId===value.actor.agentId);
      const action=value.law.id.startsWith('builtin.')?value.law.id.slice('builtin.'.length):null;
      const applicable=action!==null ? ACTIONS.includes(action) && requests.some(event=>
        lawAppliesToRequest({action,target:null,environment:null},null,event)) : value.dependencyIds.some(dependencyId=>{
          const event=evidenceById.get(dependencyId);
          return event?.kind==='laws.approved' && human(event.data.source) && Array.isArray(event.data.rules) &&
            event.data.rules.map(normalizeRule).some(rule=>rule && rule.id===value.law.id && rule.version===value.law.version &&
              requests.some(request=>lawAppliesToRequest(rule,event.occurredAt,request)));
        });
      if (!applicable) {
        markCase(id,id);conflicts.push({type:'unproven-law-applicability',caseId:id,id});
      }
    }
    let currentOutcome = judgment.outcome;
    let appealStatus = 'none';
    let pardoned = false;
    for (const event of accepted) {
      if (event.data.caseId !== id) continue;
      const reasonValid = caseReason(event.data.reason)!==null;
      if (event.kind === 'appeal.requested' && reasonValid && requestSource(event.data.source)) {
        appealStatus = 'pending';
      } else if (event.kind === 'appeal.decided' && reasonValid && human(event.data.source) &&
          ['uphold', 'overturn', 'unknown'].includes(event.data.decision)) {
        currentOutcome = event.data.decision === 'uphold' ? judgment.outcome :
          event.data.decision === 'overturn' ? 'not-guilty' : 'unknown';
        appealStatus = 'resolved';
      } else if (event.kind === 'case.pardoned' && reasonValid && human(event.data.source)) {
        pardoned = true;
      } else continue;
      record.historyEventIds.add(event.id);
    }
    const conflictEventIds = sorted(caseConflicts.get(id) || []);
    const status = pardoned ? 'pardoned' : conflictEventIds.length ? 'disputed' :
      currentOutcome === 'guilty' ? 'active' : currentOutcome === 'not-guilty' ? 'cleared' : 'unknown';
    cases.push({ caseId: id, citizenId: judgment.citizenId, judgment, currentOutcome, status,
      appealStatus, effects: status === 'active' ? { ...judgment.effects,
        restrictions: [...judgment.effects.restrictions], lessonIds: [...judgment.effects.lessonIds] } : noEffects(),
      verdictEventIds, historyEventIds: sorted(record.historyEventIds), conflictEventIds });
  }
  const withdrawnLessons = new Set();
  for (const record of cases) {
    if (record.status === 'active') continue;
    for (const judgment of records.get(record.caseId).judgments.values()) {
      for (const lessonId of judgment.effects.lessonIds) withdrawnLessons.add(lessonId);
    }
  }
  for (const record of cases) record.effects.lessonIds=record.effects.lessonIds.filter(id=>!withdrawnLessons.has(id));
  const totals = new Map();
  const citizens = new Map();
  for (const record of cases) {
    if (record.citizenId === null) continue;
    if (!citizens.has(record.citizenId)) citizens.set(record.citizenId,
      { citizenId: record.citizenId, caseIds: [], ...noEffects() });
    const citizen = citizens.get(record.citizenId);
    if (record.status !== 'active') continue;
    citizen.caseIds.push(record.caseId);
    totals.set(record.citizenId,(totals.get(record.citizenId) || 0n)+BigInt(record.effects.trustDelta));
    citizen.restrictions = sorted([...citizen.restrictions, ...record.effects.restrictions]);
    citizen.lessonIds = sorted([...citizen.lessonIds, ...record.effects.lessonIds]);
  }
  for (const citizen of citizens.values()) {
    const total=totals.get(citizen.citizenId) || 0n;
    citizen.trustDelta=total<BigInt(Number.MIN_SAFE_INTEGER)?null:Number(total);
    if (citizen.trustDelta===null) citizen.scoreIncomplete=true;
  }
  return { cases, citizens: [...citizens.values()].sort((left, right) =>
    left.citizenId < right.citizenId ? -1 : left.citizenId > right.citizenId ? 1 : 0),
  conflicts: conflicts.sort((left, right) => canonical(left) < canonical(right) ? -1 :
    canonical(left) > canonical(right) ? 1 : 0) };
}
