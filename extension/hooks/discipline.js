// Default-mode court: what happens after a rule is broken. It needs no key,
// settings or probe. The ledger is unsigned here, so this guards against agent
// mistakes, not against an agent that edits Arbiter data on purpose.
//
// Sanctions, lightest first:
//   warning  the main agent broke a deny rule (the main loop is never detained)
//   fine     a subagent's first violation
//   detain   a subagent's second violation in one run, or any jail rule
// A detained run can only send one final report. Its agent type is detained in
// the project on that model for JAIL_TERM_MS: starting it again runs another
// model. The person releases a violation from /arbiter rules or /arbiter release.
import {resolvedModelId} from './citizens.js';
import { t } from './i18n.js';
import { canonical, digest } from './ledger.js';
import { emit, readProject } from './events.js';

export const FINE_POINTS = 10;
export const DETAIN_POINTS = 30;
export const JAIL_TERM_MS = 7 * 24 * 60 * 60 * 1000;
export const REPORT_LIMIT = 4000;
const SNAPSHOT_TTL_MS = 15000;
const RELEASERS = new Set(['composer', 'bridge', 'ui']);
const SANCTIONS = ['warning', 'fine', 'detain'];
const POINTS = { warning: 0, fine: FINE_POINTS, detain: DETAIN_POINTS };

// Process memory. The ledger is the record; these keep the gate correct between
// reads and when a write to the ledger fails.
const snapshots = new Map();
const localViolations = new Map();
const localRefusals = new Map();
const localReleases = new Set();
const citizens = new Map();
const reported = new Set();
const spawnNotes = new Map();
const rejectedRuns = new Set();
const pendingReplacements = new Map();

const runKey = (sessionId, agentId) => `${sessionId}:${agentId}`;
const byTime = (left, right) => left.occurredAt - right.occurredAt ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

export function forgetProject(projectId) { snapshots.delete(projectId); localViolations.delete(projectId); localRefusals.delete(projectId); }

export function resetDiscipline() {
  for (const store of [snapshots, localViolations, localRefusals, localReleases, citizens, reported, spawnNotes, rejectedRuns, pendingReplacements]) store.clear();
}

// The same agent type and definition is one lineage whatever model it runs on.
export function definitionKey(identity) {
  return canonical([identity.name, identity.source ?? 'unknown', identity.provider ?? null,
    identity.definitionHash || (identity.source === 'built-in' ? identity.engineVersion : null) || null]);
}

export function citizenSummary(identity) {
  if (!identity || typeof identity.name !== 'string' || !identity.name) return null;
  return { id: typeof identity.id === 'string' ? identity.id : null, name: identity.name,
    model: typeof identity.resolvedModel === 'string' && identity.resolvedModel ? identity.resolvedModel : null,
    definition: definitionKey(identity) };
}

function violationRecord(id, at, sessionId, agentId, data, released, now) {
  const status = released.has(id) ? 'released' :
    data.sanction === 'detain' && now - at >= JAIL_TERM_MS ? 'served' : 'active';
  return { id, at, sessionId, agentId, sanction: data.sanction, reason: data.reason,
    ruleIds: Array.isArray(data.ruleIds) ? data.ruleIds.filter(rule => typeof rule === 'string') : [],
    detail: typeof data.detail === 'string' ? data.detail : '', toolCallId: data.toolCallId ?? null,
    citizen: data.citizen && typeof data.citizen === 'object' ? data.citizen : null,
    points: POINTS[data.sanction], status, releaseReason: released instanceof Map ? released.get(id) ?? null : null };
}

export function reduceDiscipline(events, projectId, now = Date.now()) {
  const list = (Array.isArray(events) ? events : []).filter(event => event && event.projectId === projectId &&
    event.data && typeof event.data === 'object').sort(byTime);
  // Releasing is how the person pardons or overturns a violation; the reason is kept.
  const released = new Map(), bindings = new Map(), refused = [], rejected = new Set();
  for (const event of list) {
    if (event.kind === 'discipline.released' && RELEASERS.has(event.data.source?.origin) &&
        Array.isArray(event.data.violationIds)) {
      for (const id of event.data.violationIds) released.set(id, typeof event.data.reason === 'string' ? event.data.reason.slice(0, 200) : null);
    } else if (event.kind === 'spawn.result' && event.data.status === 'started' &&
        typeof event.data.childAgentId === 'string') {
      if(event.data.modelVerified===false && event.data.replacement?.blockedModels)rejected.add(runKey(event.sessionId,event.data.childAgentId));
      const summary = citizenSummary(event.data.citizen);
      if (summary) bindings.set(runKey(event.sessionId, event.data.childAgentId), summary);
    } else if (event.kind === 'rule.decision' && event.data.outcome === 'refused' &&
        Array.isArray(event.data.actionKeys)) {
      refused.push({ sessionId: event.sessionId, agentId: event.agentId, keys: event.data.actionKeys });
    }
  }
  const violations = list.filter(event => event.kind === 'discipline.violation' && SANCTIONS.includes(event.data.sanction))
    .map(event => violationRecord(event.id, event.occurredAt, event.sessionId, event.agentId, event.data, released, now));
  return { violations, bindings, refused, rejected };
}

export function runRecord(state, sessionId, agentId) {
  const violations = state.violations.filter(record => record.sessionId === sessionId &&
    record.agentId === agentId && record.status !== 'released');
  return { strikes: violations.length, violations,
    detained: violations.some(record => record.sanction === 'detain' && record.status === 'active') };
}

export function jailed(state, definition) {
  return state.violations.filter(record => record.sanction === 'detain' && record.status === 'active' &&
    record.citizen?.definition === definition);
}

export function modelFamily(model) {
  const text = typeof model === 'string' ? model.toLowerCase() : '';
  return ['opus', 'sonnet', 'haiku', 'fable'].find(family => text.includes(family)) ?? null;
}

// Which model a new run of a detained agent type gets. keep: the model asked
// for is already a different one. No model: every alias is detained.
export function pickReplacement(jailedModels, requested) {
  const families = new Set(jailedModels.map(modelFamily));
  const wanted = modelFamily(requested);
  if (wanted && !families.has(wanted) && !families.has(null)) return { keep: true };
  const order = families.has('sonnet') || families.has('fable') ? ['opus', 'sonnet', 'haiku'] : ['sonnet', 'opus', 'haiku'];
  // A detained run whose model is unknown may have been the requested one.
  const model = order.find(family => !families.has(family) && !(families.has(null) && family === wanted));
  return model ? { model } : {};
}

export async function actionKeys(actions) {
  return Promise.all(actions.map(action => digest(`${action.action}\u0000${action.target}`)));
}

export async function disciplineState($, ctx, fresh = false) {
  const cached = snapshots.get(ctx.projectId), now = Date.now();
  if (cached && !fresh && now - cached.at < SNAPSHOT_TTL_MS) return cached.state;
  let events = [];
  try { events = (await readProject($, ctx)).events; } catch { /* Process memory still applies. */ }
  const state = reduceDiscipline(events, ctx.projectId, now);
  for (const record of localViolations.get(ctx.projectId) ?? []) {
    if (!state.violations.some(known => known.id === record.id)) state.violations.push({ ...record });
  }
  for (const record of state.violations) if (localReleases.has(record.id)) record.status = 'released';
  state.refused.push(...(localRefusals.get(ctx.projectId) ?? []));
  for (const [key, summary] of citizens) if (!state.bindings.has(key)) state.bindings.set(key, summary);
  snapshots.set(ctx.projectId, { at: now, state });
  return state;
}

export function rememberCitizen(ctx, agentId, identity) {
  const summary = citizenSummary(identity);
  if (summary && typeof agentId === 'string') citizens.set(runKey(ctx.sessionId, agentId), summary);
}

export function citizenOf(state, ctx, agentId) {
  return citizens.get(runKey(ctx.sessionId, agentId)) ?? state.bindings.get(runKey(ctx.sessionId, agentId)) ?? null;
}

export function rememberRefusal(ctx, agentId, keys) {
  if (!localRefusals.has(ctx.projectId)) localRefusals.set(ctx.projectId, []);
  localRefusals.get(ctx.projectId).push({ sessionId: ctx.sessionId, agentId, keys });
  snapshots.delete(ctx.projectId);
}

export function refusedBefore(state, ctx, agentId, keys) {
  return state.refused.some(entry => entry.sessionId === ctx.sessionId && entry.agentId === agentId &&
    entry.keys.some(key => keys.includes(key)));
}

// input: { ruleIds, reason, severe, detail, requestId }. Always returns the
// record: when the ledger cannot be written the violation lives in this process.
export async function recordViolation($, ctx, event, input) {
  const actor = event.agentId || null;
  const state = await disciplineState($, ctx, true);
  const toolCallId = event.tool_use_id || null;
  const repeat = toolCallId && state.violations.find(record => record.sessionId === ctx.sessionId &&
    record.agentId === actor && record.toolCallId === toolCallId);
  if (repeat) return repeat;
  const strikes = actor ? runRecord(state, ctx.sessionId, actor).strikes : 0;
  const sanction = !actor ? 'warning' : input.severe || strikes > 0 ? 'detain' : 'fine';
  const data = { ruleIds: input.ruleIds, reason: input.reason, sanction, points: POINTS[sanction],
    detail: input.detail, requestId: input.requestId ?? null, toolCallId,
    citizen: actor ? citizenOf(state, ctx, actor) : null };
  let id;
  try { id = await emit($, ctx, actor, 'discipline.violation', toolCallId || crypto.randomUUID(), data); }
  catch { id = `local:${crypto.randomUUID()}`; }
  const record = violationRecord(id, Date.now(), ctx.sessionId, actor, data, new Map(), Date.now());
  if (!localViolations.has(ctx.projectId)) localViolations.set(ctx.projectId, []);
  localViolations.get(ctx.projectId).push(record);
  snapshots.delete(ctx.projectId);
  return record;
}

export async function releaseViolations($, ctx, violationIds, source, reason = null) {
  const ids = [...new Set(violationIds)].filter(id => typeof id === 'string' && id);
  if (!ids.length) return null;
  let evidenceId = null;
  // A violation that never reached the ledger has nothing to release there.
  const persisted = ids.filter(id => !id.startsWith('local:'));
  const why = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : null;
  if (persisted.length) evidenceId = await emit($, ctx, null, 'discipline.released', crypto.randomUUID(), { violationIds: persisted, source, ...(why ? { reason: why } : {}) });
  for (const id of ids) localReleases.add(id);
  snapshots.delete(ctx.projectId);
  return evidenceId;
}

// True once per detained run: its single final report to the lead.
export function takeReport(ctx, agentId) {
  const key = runKey(ctx.sessionId, agentId);
  if (reported.has(key)) return false;
  reported.add(key);
  return true;
}

export async function handbackNoteFor($, ctx, agentId) {
  try { return handbackNote(await disciplineState($, ctx), ctx, agentId); }
  catch { return null; }
}

export function handbackNote(state, ctx, agentId) {
  const run = runRecord(state, ctx.sessionId, agentId);
  if (!run.strikes) return null;
  const rules = [...new Set(run.violations.flatMap(record => record.ruleIds))].join(', ');
  return `\n[Agent Arbiter: this agent broke project rules (${rules}). ` + (run.detained ?
    'It is detained and was stopped; starting this agent type again runs a different model. ' : 'It was fined. ') +
    'The person can review or release it in /arbiter rules.]';
}

// Decide what a spawn becomes. { input } passes, possibly on another model;
// { deny } refuses it. Every $ operation stays in this top-level function.
export async function disciplineSpawn($, ctx, input, identity) {
  const state = await disciplineState($, ctx, true);
  if(replacementPending(ctx) && [input.parentAgentId,input.resume?.agentId].some(agentId=>agentId && !citizenOf(state,ctx,agentId)))return {deny:'Agent Arbiter: replacement identity/model binding pending; cannot spawn or resume yet.'};
  if(input.parentAgentId && replacementHeld(state,ctx,input.parentAgentId))return {deny:'Agent Arbiter: rejected replacement cannot spawn agents.'};
  if(input.resume?.agentId && replacementHeld(state,ctx,input.resume.agentId))return {deny:'Agent Arbiter: rejected replacement cannot resume.'};
  if (input.parentAgentId && runRecord(state, ctx.sessionId, input.parentAgentId).detained) {
    return { deny: 'Agent Arbiter: a detained agent cannot start or resume agents.' };
  }
  const resumed = input.resume?.agentId;
  if (resumed) {
    return runRecord(state, ctx.sessionId, resumed).detained ?
      { deny: 'Agent Arbiter: that agent is detained and cannot be resumed. Start a new agent, or the person can release it in /arbiter rules.' } : { input };
  }
  const summary = citizenSummary(identity);
  const held = summary ? jailed(state, summary.definition) : [];
  if (!held.length) return { input };
  const choice = pickReplacement(held.map(record => record.citizen.model), input.model);
  const replacement={model:choice.keep?input.model:choice.model,violationIds:held.map(record=>record.id),blockedModels:[...new Set(held.map(record=>record.citizen.model))]};
  if (choice.keep) return { input, replacement };
  const rules = [...new Set(held.flatMap(record => record.ruleIds))].join(', ');
  if (!choice.model) {
    return { deny: `Agent Arbiter: every model of agent type "${summary.name}" is detained in this project (rules: ${rules}). The person can release one in /arbiter rules.` };
  }
  const models = [...new Set(held.map(record => record.citizen.model || 'an unknown model'))].join(', ');
  const note = `Agent Arbiter: agent type "${summary.name}" on ${models} is detained in this project for breaking: ${rules}. This run was started on ${choice.model} instead. The person can review or release it in /arbiter rules.`;
  const prompt = typeof input.prompt === 'string' ? `${input.prompt}\n\n[Agent Arbiter notice: an earlier "${summary.name}" agent was detained for breaking these project rules: ${rules}. Do not attempt those actions; if the task seems to need one, stop and report to the lead.]` : input.prompt;
  if (typeof input.tool_use_id === 'string') spawnNotes.set(input.tool_use_id, note);
  return { input: { ...input, model: choice.model, prompt },
    replacement, note };
}

export function takeSpawnNote(toolUseId) {
  const note = spawnNotes.get(toolUseId) ?? null;
  spawnNotes.delete(toolUseId);
  return note;
}

// Newest first, for the rules pane and /arbiter docket.
export function docket(state, limit = 50) {
  return [...state.violations].sort((left, right) => right.at - left.at).slice(0, limit).map(record => ({
    id: record.id, at: record.at, who: record.citizen ? `${record.citizen.name}${record.citizen.model ? `@${record.citizen.model}` : ''}` :
      record.agentId ? 'agent' : 'main', sanction: record.sanction, reason: record.reason,
    ruleIds: record.ruleIds, points: record.points, status: record.status, releaseReason: record.releaseReason ?? null }));
}


export function replacementAllowed(policy,actual){
  if(!policy?.blockedModels)return true;
  if(!resolvedModelId(actual))return false;
  return policy.blockedModels.every(model=>typeof model==='string' && actual!==model && (!modelFamily(model) || modelFamily(actual)!==modelFamily(model)));
}
export function rejectReplacement(ctx,agentId,toolUseId){
  if(typeof agentId==='string')rejectedRuns.add(runKey(ctx.sessionId,agentId));
  if(typeof toolUseId==='string')spawnNotes.set(toolUseId,'Agent Arbiter: replacement rejected; actual model is missing, unresolved or still detained. The child is held and a stop was requested. Start a new agent on a different model after checking /arbiter docket.');
}
export function replacementHeld(state,ctx,agentId){return rejectedRuns.has(runKey(ctx.sessionId,agentId)) || state.rejected?.has(runKey(ctx.sessionId,agentId)) || false;}

const pendingKey=ctx=>ctx.projectId+':'+ctx.sessionId;
export function beginReplacement(ctx,attempt){
 const key=pendingKey(ctx);if(!pendingReplacements.has(key))pendingReplacements.set(key,new Set());pendingReplacements.get(key).add(attempt);
}
export function endReplacement(ctx,attempt){
 if(!ctx)return;const key=pendingKey(ctx),pending=pendingReplacements.get(key);pending?.delete(attempt);if(!pending?.size)pendingReplacements.delete(key);
}
export function replacementPending(ctx){return !!pendingReplacements.get(pendingKey(ctx))?.size;}

export function docketText(state, limit = 30) {
  const records = docket(state, limit);
  if (!records.length) return t('cmd.docketNone');
  const rule = id => id.startsWith('user:') ? id : t(`rule.${id}`);
  return [t('cmd.docketHead'), ...records.map(record => t('cmd.docketLine', { id: record.id.slice(0, 12),
    when: new Date(record.at).toISOString().slice(0, 16).replace('T', ' '), who: record.who, sanction: t(`sanction.${record.sanction}`),
    points: record.points, rules: record.ruleIds.map(rule).join(', '),
    status: record.status === 'released' && record.releaseReason ? t('cmd.releasedReason', { reason: record.releaseReason }) : t(`status.${record.status}`) }))].join('\n');
}
