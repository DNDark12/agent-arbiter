import { emit } from './events.js';
import { redact } from './privacy.js';

// What Arbiter decided about each tool call it stopped to look at, for the
// short note drawn under that call's row. Process memory only: a row from an
// earlier session draws without one.
const MAX_NOTES = 500;
const notes = new Map();
const ASK_OUTCOMES = new Set(['approved', 'session-allow', 'refused', 'unanswered']);

export function noteDecision(toolUseId, ruleIds, outcome) {
  if (typeof toolUseId !== 'string' || !toolUseId || !Array.isArray(ruleIds) || !ruleIds.length) return;
  notes.delete(toolUseId);
  notes.set(toolUseId, { ruleIds: [...ruleIds], outcome });
  while (notes.size > MAX_NOTES) notes.delete(notes.keys().next().value);
}

export function decisionNote(toolUseId) { return notes.get(toolUseId) ?? null; }
export function forgetNotes() { notes.clear(); }

export function approvalNotes() {
  return [...notes.entries()].filter(([, note]) => ASK_OUTCOMES.has(note.outcome));
}

// This session's approval asks so far: how many, and how many were allowed.
export function sessionAsks() {
  let asked = 0, allowed = 0;
  for (const [, note] of approvalNotes()) {
    asked += 1;
    if (note.outcome === 'approved' || note.outcome === 'session-allow') allowed += 1;
  }
  return { asked, allowed };
}

const active = new Map();
const speeds = new Map();
const waitTicks = new Map();
const activityScope = ctx => JSON.stringify([ctx.archiveRoot, ctx.projectId, ctx.sessionId]);

export function redrawActivity($) {
  try { $.ui.invalidate('ui.render'); } catch { /* Best effort. */ }
}

function activities(ctx) {
  const scope = activityScope(ctx);
  return [...active.values()].filter(item => item.scope === scope);
}

function syncWaitTick($, ctx) {
  const scope = activityScope(ctx);
  const ticker = waitTicks.get(scope);
  if (!pendingWaits(ctx).length) {
    try { ticker?.cancel(); } catch { /* Best effort. */ }
    waitTicks.delete(scope);
  } else if (!ticker) {
    try { waitTicks.set(scope, $.clock.every(5000, () => redrawActivity($))); } catch { /* Best effort. */ }
  }
}

export function currentActivity(ctx, actor) {
  return activities(ctx).findLast(item => item.actor === actor && item.kind === 'tool') ?? null;
}

export function pendingWaits(ctx) {
  return activities(ctx).filter(item => item.kind !== 'tool');
}

export function outputRate(ctx, now = Date.now()) {
  const sample = speeds.get(activityScope(ctx));
  return sample && now - sample.at < 60000 ? sample.rate : null;
}

export function recordOutputRate($, ctx, tokens, ms) {
  if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(ms) || ms < 100) return;
  speeds.set(activityScope(ctx), { rate: tokens * 1000 / ms, at: Date.now() });
  if (speeds.size > 40) speeds.delete(speeds.keys().next().value);
  redrawActivity($);
}

export function beginActivity($, ctx, actor, id, kind, label, startedAt = Date.now()) {
  const scope = activityScope(ctx), key = JSON.stringify([scope, actor, kind, id]);
  const item = { scope, actor, id, kind, label: redact(label).slice(0, 70), startedAt, key,
    episode: kind === 'tool' ? null : crypto.randomUUID() };
  active.delete(key);
  active.set(key, item);
  if (active.size > 512) {
    const oldest = active.keys().next().value, scope = active.get(oldest).scope;
    active.delete(oldest);
    if (![...active.values()].some(entry => entry.scope === scope && entry.kind !== 'tool')) {
      try { waitTicks.get(scope)?.cancel(); } catch { /* Best effort. */ }
      waitTicks.delete(scope);
    }
  }
  redrawActivity($);
  return (endedAt = Date.now()) => {
    if (active.get(key) !== item) return null;
    active.delete(key);
    redrawActivity($);
    return { kind, startedAt, endedAt: Math.max(startedAt, endedAt), episode: item.episode };
  };
}

async function saveWait($, ctx, actor, id, wait) {
  if (!wait || wait.kind === 'tool') return;
  const { episode, ...interval } = wait;
  try { await emit($, ctx, actor, 'progress.wait', `${wait.kind}:${id}:${episode}`, interval); }
  catch { /* Progress evidence cannot change an approval or tool result. */ }
  redrawActivity($);
}

export function beginWait($, ctx, actor, id, kind) {
  const finish = beginActivity($, ctx, actor, id, kind, '');
  syncWaitTick($, ctx);
  return () => {
    const wait = finish();
    syncWaitTick($, ctx);
    return saveWait($, ctx, actor, id, wait);
  };
}

export function endActorActivity($, ctx, actor, now = Date.now()) {
  const saves = [];
  for (const item of activities(ctx)) {
    if (item.actor !== actor) continue;
    active.delete(item.key);
    if (item.episode) saves.push(saveWait($, ctx, actor, item.id, { kind: item.kind, startedAt: item.startedAt,
      endedAt: Math.max(item.startedAt, now), episode: item.episode }));
  }
  syncWaitTick($, ctx);
  redrawActivity($);
  return Promise.all(saves);
}

export function forgetActivity(ctx, all = false) {
  const matches = scope => {
    if (all) return true;
    const [archive, project] = JSON.parse(scope);
    return archive === ctx.archiveRoot && project === ctx.projectId;
  };
  for (const [key, item] of active) {
    if (matches(item.scope)) active.delete(key);
  }
  for (const scope of speeds.keys()) if (matches(scope)) speeds.delete(scope);
  for (const [scope, ticker] of waitTicks) {
    if (!matches(scope)) continue;
    try { ticker.cancel(); } catch { /* Best effort. */ }
    waitTicks.delete(scope);
  }
}
