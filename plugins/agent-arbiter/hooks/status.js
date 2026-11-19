// What needs the person, per project: detained agents and review decisions.
// The band above the prompt draws it; a toast says when something new arrives.
import { disciplineState } from './discipline.js';
import { readProject } from './events.js';
import { reduceReviews, PENDING_DAYS } from './judge.js';
import { loadProjectSettings } from './project-rules.js';
import { t } from './i18n.js';
import {replay} from './ledger.js';
import {courtDisabled} from './control-state.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// A detention this recent still flashes in the band.
export const PULSE_MS = 8000;

export async function diagnostics($,ctx,failures=0) {
  const read=await readProject($,ctx),state=replay(read.events),settings=await loadProjectSettings($,ctx);
  return {mode:courtDisabled()?'off':settings.mode,events:state.eventCount,runs:state.runs.length,calls:state.toolCalls.length,
    invalid:read.invalid.length,conflicts:state.conflicts.length,parts:read.parts.length,
    ...statusCounts(await disciplineState($,ctx,true),reduceReviews(read.events,ctx.projectId)),failures};
}

// decided counts the decisions made on reviews still in their waiting window,
// so pending and decided share one total: the reviews that asked for a decision.
export function statusCounts(discipline, reviews, now = Date.now()) {
  const recent = reviews.filter(review => now - review.at < PENDING_DAYS * DAY_MS);
  const held = discipline.violations.filter(record => record.sanction === 'detain' && record.status === 'active');
  return { detainee: held.at(-1)?.citizen?.name ?? null, detained: new Set(discipline.violations.filter(record => record.sanction === 'detain' && record.status === 'active')
      .map(record => `${record.sessionId}:${record.agentId}`)).size,
    pending: reviews.reduce((sum, review) => sum + review.findings.filter(finding => finding.state === 'open').length +
      (review.exemplar.state === 'candidate' ? 1 : 0), 0),
    decided: recent.reduce((sum, review) => sum + review.findings.filter(finding => ['confirmed', 'dismissed'].includes(finding.state)).length +
      (['approved', 'rejected'].includes(review.exemplar.state) ? 1 : 0), 0) };
}

const snapshots = new Map();
const keyOf = ctx => `${ctx.archiveRoot}:${ctx.projectId}`;

// The band's numbers for this project; null until first counted.
export function bandSnapshot(ctx) { return snapshots.get(keyOf(ctx)) ?? null; }
export function forgetSnapshots() { snapshots.clear(); }

// Counts again, redraws the band, and says so once when something new waits.
// Returns the one-line summary, or null when nothing waits. Never throws.
export async function refreshStatus($, ctx) {
  try {
    const settings = await loadProjectSettings($, ctx);
    const active = settings.mode !== 'off' && !courtDisabled();
    const counts = active ? statusCounts(await disciplineState($, ctx, true), reduceReviews((await readProject($, ctx)).events, ctx.projectId))
      : { detained: 0, pending: 0, decided: 0 };
    const previous = snapshots.get(keyOf(ctx)), now = Date.now();
    const detainedAt = previous && counts.detained > previous.detained ? now : previous?.detainedAt ?? 0;
    snapshots.set(keyOf(ctx), { ...counts, detainedAt, hidden: previous?.hidden && counts.detained <= previous.detained && counts.pending <= previous.pending });
    if (previous) {
      try {
        if (counts.detained > previous.detained) $.ui.toast(t('toast.detained', { count: counts.detained }));
        else if (counts.pending > previous.pending) $.ui.toast(t('toast.pending', { count: counts.pending }));
      } catch { /* A toast is a courtesy. */ }
    }
    try { $.ui.status(undefined); } catch { /* The band replaced the status line. */ }
    try { $.ui.invalidate('ui.render'); } catch { /* Redrawn at the next frame anyway. */ }
    return counts.detained || counts.pending ? t('statusline', counts) : null;
  } catch { return null; }
}

// The person closed the band: it stays closed until something new waits.
export function hideBand($, ctx) {
  const snapshot = snapshots.get(keyOf(ctx));
  if (snapshot) snapshots.set(keyOf(ctx), { ...snapshot, hidden: true });
  try { $.ui.invalidate('ui.render'); } catch { /* Best effort. */ }
}
