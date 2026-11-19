// What needs the person, per project: detained agents and review decisions.
// The band above the prompt draws it; a toast says when something new arrives.
import { disciplineState } from './discipline.js';
import { readProjectShared } from './events.js';
import { reduceReviews, judgeUsage, PENDING_DAYS } from './judge.js';
import { loadProjectSettings } from './project-rules.js';
import { t } from './i18n.js';
import { sessionTimeline } from './history.js';
import {replay} from './ledger.js';
import {courtDisabled} from './control-state.js';
import { checklistOf } from './checklist.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// A detention this recent still flashes in the band.
export const PULSE_MS = 8000;

export async function diagnostics($,ctx,failures=0) {
  const read=await readProjectShared($,ctx),state=replay(read.events),settings=await loadProjectSettings($,ctx);
  return {mode:courtDisabled()?'off':settings.mode,events:state.eventCount,runs:state.runs.length,calls:state.toolCalls.length,
    invalid:read.invalid.length,conflicts:state.conflicts.length,parts:read.parts.length,
    ...statusCounts(await disciplineState($,ctx,true,true),reduceReviews(read.events,ctx.projectId)),failures};
}

// decided counts the decisions made on reviews still in their waiting window,
// so pending and decided share one total: the reviews that asked for a decision.
export function statusCounts(discipline, reviews, now = Date.now()) {
  const recent = reviews.filter(review => now - review.at < PENDING_DAYS * DAY_MS);
  const held = discipline.violations.filter(record => record.sanction === 'detain' && record.status === 'active');
  return { detainee: held.at(-1)?.citizen?.name ?? null, detained: new Set(discipline.violations.filter(record => record.sanction === 'detain' && record.status === 'active')
      .map(record => `${record.sessionId}:${record.agentId}`)).size,
    // An exemplar candidate is a suggestion the person may take or leave: it never counts as a wait.
    pending: reviews.reduce((sum, review) => sum + review.findings.filter(finding => finding.state === 'open').length, 0),
    decided: recent.reduce((sum, review) => sum + review.findings.filter(finding => ['confirmed', 'dismissed'].includes(finding.state)).length +
      (['approved', 'rejected'].includes(review.exemplar.state) ? 1 : 0), 0) };
}

// A short sound when something new waits; the person turns it off in /config.
let soundsOn = true;
export function setSounds(enabled) { soundsOn = enabled !== false; }
export function chime($, name) {
  if (!soundsOn) return;
  try { void $.audio.play({ asset: `sounds/${name}.wav` }).catch(() => {}); } catch { /* Sound is a courtesy. */ }
}

// This session's subagents worth a strip: those at work, those held, and the
// ones that ended a moment ago, oldest first.
export const RECENT_AGENT_MS = 2 * 60 * 1000;
export function bandAgents(timeline, now = Date.now()) {
  return (timeline?.agents ?? []).filter(agent => agent.status === 'running' || agent.detained ||
    (agent.endedAt !== null && now - agent.endedAt < RECENT_AGENT_MS));
}

const snapshots = new Map();
const keyOf = ctx => JSON.stringify([ctx.archiveRoot, ctx.projectId, ctx.sessionId]);

// The band's numbers for this project; null until first counted.
export function bandSnapshot(ctx) { return snapshots.get(keyOf(ctx)) ?? null; }
export function forgetSnapshots() { snapshots.clear(); }

// Counts again, redraws the band, and says so once when something new waits.
// Returns the one-line summary, or null when nothing waits. Never throws.
export async function refreshStatus($, ctx) {
  try {
    const settings = await loadProjectSettings($, ctx);
    const active = settings.mode !== 'off' && !courtDisabled();
    let counts = { detained: 0, pending: 0, decided: 0, detainee: null, judgedToday: 0, violations: 0 };
    let recentReviews = [], detainedRecords = [], agents = [], checklist = null;
    if (active) {
      const events = (await readProjectShared($, ctx)).events, discipline = await disciplineState($, ctx, true, true);
      const now = Date.now(), reviews = reduceReviews(events, ctx.projectId, now);
      recentReviews = reviews.filter(review => now - review.at < PENDING_DAYS * DAY_MS);
      detainedRecords = discipline.violations.filter(record => record.sanction === 'detain' && record.status === 'active');
      agents = sessionTimeline(events, ctx.projectId, ctx.sessionId, { discipline, reviews, now, includeProgress: false })?.agents ?? [];
      if (settings.checklist) checklist = checklistOf(events, ctx.sessionId, now);
      counts = { ...statusCounts(discipline, reviews, now), judgedToday: judgeUsage(events, ctx.projectId, now).today,
        violations: discipline.violations.filter(record => record.status === 'active').length };
    }
    const previous = snapshots.get(keyOf(ctx)), now = Date.now();
    const detainedAt = previous && counts.detained > previous.detained ? now : previous?.detainedAt ?? 0;
    snapshots.set(keyOf(ctx), { ...counts, recentReviews, detainedRecords, agents, checklist, active, detainedAt,
      expanded: previous?.expanded ?? false, selected: previous?.selected ?? null,
      hidden: previous?.hidden && counts.detained <= previous.detained && counts.pending <= previous.pending });
    if (snapshots.size > 40) snapshots.delete(snapshots.keys().next().value);
    if (previous) {
      try {
        if (counts.detained > previous.detained) { $.ui.toast(t('toast.detained', { count: counts.detained })); chime($, 'detained'); }
        else if (counts.pending > previous.pending) { $.ui.toast(t('toast.pending', { count: counts.pending })); chime($, 'review'); }
      } catch { /* A toast is a courtesy. */ }
    }
    try { $.ui.status(undefined); } catch { /* The band replaced the status line. */ }
    try { $.ui.invalidate('ui.render'); } catch { /* Redrawn at the next frame anyway. */ }
    return counts.detained || counts.pending ? t('statusline', counts) : null;
  } catch { return null; }
}

// The band's list of every bar, or only the one that matters most.
export function setBandExpanded($, ctx, expanded) {
  const snapshot = snapshots.get(keyOf(ctx));
  if (snapshot) snapshots.set(keyOf(ctx), { ...snapshot, expanded, selected: null });
  try { $.ui.invalidate('ui.render'); } catch { /* Best effort. */ }
}

export function selectBandProgress($, ctx, key) {
  const snapshot = snapshots.get(keyOf(ctx));
  if (snapshot) snapshots.set(keyOf(ctx), { ...snapshot, selected: snapshot.selected === key ? null : key });
  try { $.ui.invalidate('ui.render'); } catch { /* Best effort. */ }
}

// The person closed the band: it stays closed until something new waits.
export function hideBand($, ctx) {
  const snapshot = snapshots.get(keyOf(ctx));
  if (snapshot) snapshots.set(keyOf(ctx), { ...snapshot, hidden: true });
  try { $.ui.invalidate('ui.render'); } catch { /* Best effort. */ }
}
