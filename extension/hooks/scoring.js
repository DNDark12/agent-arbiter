// Citizen scorecard: one row per agent type, definition and model in a project.
// It is built only from what the ledger holds (runs, turn usage, violations),
// so it measures conduct under the project's rules, not the quality of the work.
import { t } from './i18n.js';
import { citizenSummary } from './discipline.js';
import { roleOf } from './roles.js';
import { readProject } from './events.js';
import { reduceDiscipline } from './discipline.js';
import { reduceReviews } from './judge.js';

const runKey = (sessionId, agentId) => `${sessionId}:${agentId}`;
const BASE_TRUST = 100;

// discipline: the state from reduceDiscipline. overrides: roles the person set.
// reviews: the judge's reviews from reduceReviews; a review with a dismissed
// finding is withdrawn and does not count toward quality.
export function reduceScores(events, projectId, discipline, overrides = {}, reviews = []) {
  const rows = new Map(), runs = new Map();
  const rowFor = summary => {
    const key = `${summary.definition}\u0000${summary.model ?? ''}`;
    if (!rows.has(key)) rows.set(key, { name: summary.name, model: summary.model, role: roleOf(summary.name, overrides),
      runs: 0, cleanRuns: 0, fines: 0, detentions: 0, points: 0, detained: false, outputTokens: 0, durationMs: 0,
      reviews: 0, qualitySum: 0, openFindings: 0, hardTasks: 0 });
    return rows.get(key);
  };
  const list = (Array.isArray(events) ? events : []).filter(event => event && event.projectId === projectId &&
    event.data && typeof event.data === 'object');
  for (const event of list) {
    if (event.kind !== 'spawn.result' || event.data.status !== 'started' || typeof event.data.childAgentId !== 'string') continue;
    const summary = citizenSummary(event.data.citizen), key = runKey(event.sessionId, event.data.childAgentId);
    // A resumed agent reports again under the same id: still one run.
    if (!summary || runs.has(key)) continue;
    const row = rowFor(summary);
    row.runs += 1;
    runs.set(key, { row, strikes: 0 });
  }
  for (const event of list) {
    const run = event.kind === 'turn.complete' && event.agentId ? runs.get(runKey(event.sessionId, event.agentId)) : null;
    if (!run) continue;
    if (Number.isFinite(event.data.durationMs)) run.row.durationMs += event.data.durationMs;
    if (Number.isFinite(event.data.usage?.output_tokens)) run.row.outputTokens += event.data.usage.output_tokens;
  }
  for (const record of discipline?.violations ?? []) {
    if (record.status === 'released' || !record.agentId) continue;
    const run = runs.get(runKey(record.sessionId, record.agentId));
    const row = run?.row ?? (record.citizen?.definition ? rowFor(record.citizen) : null);
    if (!row) continue;
    if (run) run.strikes += 1;
    row.points += record.points;
    if (record.sanction === 'fine') row.fines += 1;
    if (record.sanction === 'detain') { row.detentions += 1; if (record.status === 'active') row.detained = true; }
  }
  for (const run of runs.values()) if (!run.strikes) run.row.cleanRuns += 1;
  for (const review of reviews) {
    const row = review.citizen?.definition ? rowFor(review.citizen) : null;
    if (!row) continue;
    row.openFindings += review.findings.filter(finding => finding.state === 'open').length;
    if (review.disputed || review.quality === null) continue;
    row.reviews += 1;
    row.qualitySum += review.quality;
    if (review.difficulty === 'hard') row.hardTasks += 1;
  }
  return [...rows.values()].map(({ qualitySum, ...row }) => ({ ...row, trust: Math.max(0, BASE_TRUST - row.points),
    quality: row.reviews ? Math.round(qualitySum / row.reviews) : null }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 :
      (left.model ?? '') < (right.model ?? '') ? -1 : 1);
}

export function scoreTable(rows) {
  if (!rows.length) return t('tbl.scoresNone');
  return [t('tbl.scoresHead'), ...rows.map(row =>
    t('tbl.scoreRow', { who: `${row.name}${row.model ? `@${row.model}` : ''}`, role: row.role, trust: row.trust, runs: row.runs,
      clean: row.cleanRuns, fines: row.fines, detentions: row.detentions }) + (row.detained ? t('tbl.detained') : '') +
    (row.reviews ? t('tbl.quality', { quality: row.quality, reviews: row.reviews, hard: row.hardTasks }) : t('tbl.qualityNone')) +
    (row.openFindings ? t('tbl.findingsOpen', { count: row.openFindings }) : '') +
    (row.outputTokens ? t('tbl.tokens', { tokens: row.outputTokens }) : ''))].join('\n');
}

// One row per agent type and model across every project on this machine.
export async function allProjectScoreRows($, ctx) {
  const base = `${ctx.archiveRoot}/events`, merged = new Map();
  let projects = 0;
  if (await $.fs.exists(base)) {
    for (const entry of await $.fs.list(base)) {
      if (entry.kind !== 'dir' || entry.isLink || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      let events;
      try { events = (await readProject($, { ...ctx, projectId: entry.name, dataRoot: ctx.archiveRoot, signer: null, authConfigured: false, authError: false })).events; }
      catch { continue; }
      const rows = reduceScores(events, entry.name, reduceDiscipline(events, entry.name), {}, reduceReviews(events, entry.name));
      if (rows.length) projects += 1;
      for (const row of rows) {
        const key = `${row.name}\u0000${row.model ?? ''}`, total = merged.get(key) ?? { ...row, runs: 0, cleanRuns: 0, fines: 0, detentions: 0,
          points: 0, outputTokens: 0, durationMs: 0, reviews: 0, hardTasks: 0, openFindings: 0, qualityTotal: 0, detained: false };
        for (const field of ['runs', 'cleanRuns', 'fines', 'detentions', 'points', 'outputTokens', 'durationMs', 'reviews', 'hardTasks', 'openFindings']) total[field] += row[field];
        total.qualityTotal += (row.quality ?? 0) * row.reviews;
        total.detained ||= row.detained;
        merged.set(key, total);
      }
    }
  }
  const rows = [...merged.values()].map(({ qualityTotal, ...row }) => ({ ...row, trust: Math.max(0, BASE_TRUST - row.points),
    quality: row.reviews ? Math.round(qualityTotal / row.reviews) : null }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : (left.model ?? '') < (right.model ?? '') ? -1 : 1);
  return {rows,projects};
}

export async function allProjectScores($,ctx) {
  const {rows,projects}=await allProjectScoreRows($,ctx);
  return rows.length ? `${t('tbl.scoresAllHead', { projects })}\n${scoreTable(rows).split('\n').slice(1).join('\n')}` : t('tbl.scoresNone');
}
