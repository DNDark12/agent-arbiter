// Scorecards combine recorded activity, rule violations, and advisory reviews.
import { t } from './i18n.js';
import { citizenSummary, reduceDiscipline } from './discipline.js';
import { mainCitizen, unboundCitizen } from './citizens.js';
import { roleOf } from './roles.js';
import { readProject } from './events.js';
import { reduceReviews } from './judge.js';

const runKey = (sessionId, agentId) => `${sessionId}:${agentId}`;
const BASE_TRUST = 100;
const USAGE = { inputTokens: 'input_tokens', outputTokens: 'output_tokens',
  cacheReadTokens: 'cache_read_input_tokens', cacheWriteTokens: 'cache_creation_input_tokens' };
const COUNTERS = ['runs', 'cleanRuns', 'interruptedRuns', 'warnings', 'fines', 'detentions', 'points',
  ...Object.keys(USAGE), 'usageTurns', 'durationMs', 'reviews', 'openFindings'];
const emptyCounters = () => Object.fromEntries(COUNTERS.map(field => [field, 0]));
const scoreAverage = (sum, count) => count ? Math.round(sum / count) : null;
const sortRows = (left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind) ||
  (left.model ?? '').localeCompare(right.model ?? '');

function completeTurn(row, data) {
  if (data.isAborted === true || data.reason === 'aborted') row.interruptedRuns += 1;
  if (Number.isFinite(data.durationMs) && data.durationMs >= 0) row.durationMs += data.durationMs;
  let hasUsage = false;
  for (const [field, token] of Object.entries(USAGE)) {
    const value = data.usage?.[token];
    if (Number.isFinite(value) && value >= 0) {
      row[field] += value;
      hasUsage = true;
    }
  }
  if (hasUsage) row.usageTurns += 1;
}

function addQualityGroup(groups, role, difficulty, reviews, sum) {
  const key = `${role}:${difficulty}`;
  const group = groups.get(key) ?? {role, difficulty, reviews:0, sum:0};
  group.reviews += reviews;
  group.sum += sum;
  groups.set(key, group);
}

function finishRow({ groups, ...row }) {
  const qualityGroups = [...groups.values()].map(group => ({ ...group, quality: scoreAverage(group.sum, group.reviews) }));
  qualityGroups.sort((left, right) => left.role.localeCompare(right.role) ||
    ['easy','medium','hard'].indexOf(left.difficulty) - ['easy','medium','hard'].indexOf(right.difficulty));
  return { ...row, trust: Math.max(0, BASE_TRUST - row.points), qualityGroups };
}

// discipline: the state from reduceDiscipline. overrides: roles the person set.
// reviews: the judge's reviews from reduceReviews; a review with a dismissed
// finding is withdrawn and does not count toward quality.
export function reduceScores(events, projectId, discipline, overrides = {}, reviews = []) {
  const rows = new Map(), runs = new Map(), mainTurns = new Map(), requests = new Map(), sessionMain = new Map();
  const rowFor = summary => {
    const kind = summary.kind === 'main' ? 'main' : 'subagent';
    const key = `${kind}\u0000${summary.definition}\u0000${summary.model ?? ''}`;
    if (!rows.has(key)) rows.set(key, { kind, name: summary.name, model: summary.model, role: roleOf(summary.name, overrides),
      ...emptyCounters(), detained: false, groups: new Map() });
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
    if (event.kind === 'tool.request' && event.agentId === null && typeof event.data.turnId === 'string') {
      requests.set(event.id, runKey(event.sessionId, event.data.turnId));
    }
    if (event.kind !== 'turn.complete') continue;
    if (event.agentId === null) {
      const key = runKey(event.sessionId, event.data.turnId || event.id);
      if (mainTurns.has(key)) continue;
      const row = rowFor(mainCitizen(event.data.model));
      row.runs += 1;
      completeTurn(row, event.data);
      mainTurns.set(key, row);
      const last = sessionMain.get(event.sessionId);
      if (!last || event.occurredAt >= last.at) sessionMain.set(event.sessionId, { row, at: event.occurredAt });
    } else {
      if (typeof event.agentId !== 'string' || !event.agentId) continue;
      const key = runKey(event.sessionId, event.agentId);
      let run = runs.get(key);
      if (!run) {
        const row = rowFor(unboundCitizen(event.data.model));
        row.runs += 1;
        run = { row, strikes: 0, incomplete: true };
        runs.set(key, run);
      }
      completeTurn(run.row, event.data);
    }
  }
  for (const record of discipline?.violations ?? []) {
    if (record.status === 'released') continue;
    if (record.agentId === null && record.sanction === 'warning') {
      // No known turn (an older record, or a turn that never completed): the
      // session's latest main turn names the model better than no row at all.
      const row = mainTurns.get(requests.get(record.requestId)) ?? sessionMain.get(record.sessionId)?.row ??
        rowFor(mainCitizen(null));
      row.warnings += 1;
      continue;
    }
    if (!record.agentId) continue;
    const run = runs.get(runKey(record.sessionId, record.agentId));
    const row = run?.row ?? (record.citizen?.definition ? rowFor(record.citizen) : null);
    if (!row) continue;
    if (run) run.strikes += 1;
    row.points += record.points;
    if (record.sanction === 'fine') row.fines += 1;
    if (record.sanction === 'detain') { row.detentions += 1; if (record.status === 'active') row.detained = true; }
  }
  for (const run of runs.values()) if (!run.strikes && !run.incomplete) run.row.cleanRuns += 1;
  for (const review of reviews) {
    const row = (review.citizen?.kind === 'main' && review.turnId ? mainTurns.get(runKey(review.sessionId, review.turnId)) : null) ??
      (review.citizen?.definition ? rowFor(review.citizen) : null);
    if (!row) continue;
    row.openFindings += review.findings.filter(finding => finding.state === 'open').length;
    if (review.disputed || review.quality === null) continue;
    row.reviews += 1;
    addQualityGroup(row.groups, review.role, review.difficulty, 1, review.quality);
  }
  return [...rows.values()].map(finishRow).sort(sortRows);
}

export function scoreUsage(row) {
  const seconds = (row.durationMs / 1000).toFixed(1);
  return t(row.usageTurns ? 'tbl.usage' : 'tbl.usageNone', { ...row, seconds });
}

export function scoreQuality(row) {
  return row.qualityGroups.map(group => t('tbl.qualityGroup', {
    ...group, role: t('role.' + group.role), difficulty: t('difficulty.' + group.difficulty),
  }));
}

export function scoreTable(rows) {
  if (!rows.length) return t('tbl.scoresNone');
  return [t('tbl.scoresHead'), ...rows.map(row => {
    const who = `${row.name}${row.model ? `@${row.model}` : ''}`;
    const line = row.kind === 'main' ? `${who} · ${t('pane.mainScore', row)}` :
      t('tbl.scoreRow', { ...row, who, clean: row.cleanRuns }) + (row.detained ? t('tbl.detained') : '');
    const quality = scoreQuality(row);
    return `${line}${row.openFindings ? t('tbl.findingsOpen', { count: row.openFindings }) : ''}\n  ` +
      [scoreUsage(row), ...(quality.length ? quality : [t('pane.qualityNone')])].join('\n  ');
  })].join('\n');
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
        const key = `${row.kind}\u0000${row.name}\u0000${row.model ?? ''}`;
        const total = merged.get(key) ?? { kind: row.kind, name: row.name, model: row.model, role: row.role,
          ...emptyCounters(), detained: false, groups: new Map() };
        for (const field of COUNTERS) total[field] += row[field];
        for (const group of row.qualityGroups) addQualityGroup(total.groups, group.role, group.difficulty, group.reviews, group.sum);
        total.detained ||= row.detained;
        merged.set(key, total);
      }
    }
  }
  const rows = [...merged.values()].map(finishRow).sort(sortRows);
  return {rows,projects};
}

export async function allProjectScores($,ctx) {
  const {rows,projects}=await allProjectScoreRows($,ctx);
  return rows.length ? `${t('tbl.scoresAllHead', { projects })}\n${scoreTable(rows).split('\n').slice(1).join('\n')}` : t('tbl.scoresNone');
}
