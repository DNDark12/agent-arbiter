// One status line entry while something needs the person: detained agents and
// review findings waiting for a decision. It disappears when there is none.
import { disciplineState } from './discipline.js';
import { readProject } from './events.js';
import { reduceReviews } from './judge.js';
import { loadProjectSettings } from './project-rules.js';
import { t } from './i18n.js';
import {replay} from './ledger.js';
import {courtDisabled} from './control-state.js';

export async function diagnostics($,ctx,failures=0) {
  const read=await readProject($,ctx),state=replay(read.events),settings=await loadProjectSettings($,ctx);
  return {mode:courtDisabled()?'off':settings.mode,events:state.eventCount,runs:state.runs.length,calls:state.toolCalls.length,
    invalid:read.invalid.length,conflicts:state.conflicts.length,parts:read.parts.length,
    ...statusCounts(await disciplineState($,ctx,true),reduceReviews(read.events,ctx.projectId)),failures};
}

export function statusCounts(discipline, reviews) {
  return { detained: new Set(discipline.violations.filter(record => record.sanction === 'detain' && record.status === 'active')
      .map(record => `${record.sessionId}:${record.agentId}`)).size,
    pending: reviews.reduce((sum, review) => sum + review.findings.filter(finding => finding.state === 'open').length +
      (review.exemplar.state === 'candidate' ? 1 : 0), 0) };
}

// Never throws: the status line is a convenience.
export async function refreshStatus($, ctx) {
  try {
    const settings = await loadProjectSettings($, ctx);
    let text;
    if (settings.mode !== 'off' && !courtDisabled()) {
      const counts = statusCounts(await disciplineState($, ctx, true), reduceReviews((await readProject($, ctx)).events, ctx.projectId));
      if (counts.detained || counts.pending) text = t('statusline', counts);
    }
    $.ui.status(text);
    return text ?? null;
  } catch { return null; }
}
