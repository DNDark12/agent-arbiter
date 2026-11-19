// What happened in a session, as a timeline: the main agent's thread and a
// branch for every subagent it sent, read from evidence the ledger already
// holds (spawn requests and results, tool calls, turn ends, violations and
// judge reviews). Nothing here is written; it is a view.
import { roleOf } from './roles.js';
import { digest } from './ledger.js';

// A run with no recorded end this long after its last sign of life is not
// shown as running: its session most likely ended without saying so.
const STALE_MS = 30 * 60 * 1000;
const byTime = (left, right) => left.occurredAt - right.occurredAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

const PACKAGE_TASK = /^(?:npm|pnpm|yarn|bun) (?:run )?(test|typecheck|check-types|type-check|lint|build)(?=[:\s]|$)/;
const CHECKS = [
  ['test', /^(?:(?:[\w./-]+\/)?(?:pytest|phpunit|pest)\b|(?:node --test|php artisan test|go test|cargo test|composer test|make test)\b)/],
  ['typecheck', /^(?:(?:[\w./-]+\/)?tsc\b|(?:npx|pnpm exec|bunx) tsc\b)/],
  ['lint', /^(?:(?:[\w./-]+\/)?(?:eslint|ruff|phpstan)\b|cargo clippy\b)/],
  ['build', /^(?:go|cargo|make|dotnet) build\b/],
];

export async function verificationCheck(command, scope) {
  const text = typeof command === 'string' ? command.trim() : '';
  const task = PACKAGE_TASK.exec(text)?.[1];
  const kind = task ? (task.includes('type') ? 'typecheck' : task) : CHECKS.find(([, pattern]) => pattern.test(text))?.[0];
  if (!kind) return null;
  // Quoting, interpolation and compound shell commands cannot prove which check returned.
  const simple = text.length <= 4096 && /^[\w ./=:@,%+\t-]+$/.test(text);
  return { kind, key: simple ? await digest(JSON.stringify([scope, text.replace(/[ \t]+/g, ' ')])) : null };
}

export function verificationOutcome(check, reply) {
  const result = reply?.result;
  if (!check.key || !result || result.interrupted || result.backgroundTaskId || result.timedOutAfterMs) return 'unknown';
  if (Number.isInteger(result.exitCode)) {
    if (result.exitCode !== 0) return 'failed';
    return reply.isError ? 'unknown' : 'passed';
  }
  if (reply.isError) {
    const message = typeof result === 'string' ? result : reply.text;
    return typeof message === 'string' && /^Exit code [1-9]\d*\b/.test(message.trimStart().slice(0, 80)) ? 'failed' : 'unknown';
  }
  return result.interrupted === false && typeof result.stdout === 'string' && typeof result.stderr === 'string' ? 'passed' : 'unknown';
}

export function verificationHistory(events) {
  const attention = [], pending = new Map();
  for (const event of events) {
    if (event.kind !== 'progress.check' || !event.data) continue;
    const { kind, key, outcome } = event.data;
    if (!CHECKS.some(([label]) => label === kind)) continue;
    if (outcome === 'passed' && key) {
      for (const row of pending.get(key) ?? []) row.resolvedAt = event.occurredAt;
      pending.delete(key);
    } else if (outcome === 'failed' || outcome === 'unknown') {
      const row = { id: event.id, kind, outcome, at: event.occurredAt, resolvedAt: null };
      attention.push(row);
      if (key && outcome === 'failed') {
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key).push(row);
      }
    }
  }
  return attention.slice(-20).reverse();
}

function mergedIntervals(intervals) {
  const merged = [];
  for (const [start, end] of intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a).sort((a, b) => a[0] - b[0])) {
    const tail = merged.at(-1);
    if (tail && start <= tail[1]) tail[1] = Math.max(tail[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function sessionMetrics(events) {
  if (!events.length) return null;
  const turns = events.filter(event => event.kind === 'turn.complete');
  const measured = turns.filter(event => Number.isFinite(event.data.durationMs) && event.data.durationMs >= 0);
  const spans = mergedIntervals(measured.map(({ occurredAt, data }) => [occurredAt - data.durationMs, occurredAt]));
  const waits = mergedIntervals(events.filter(event => event.kind === 'progress.wait').map(({ data }) => [data.startedAt, data.endedAt]));
  const waitMs = waits.reduce((sum, [start, end]) => sum + end - start, 0);
  let workMs = 0, waitIndex = 0;
  for (const [start, end] of spans) {
    workMs += end - start;
    while (waits[waitIndex]?.[1] <= start) waitIndex++;
    for (let index = waitIndex; index < waits.length && waits[index][0] < end; index++) {
      workMs -= Math.min(end, waits[index][1]) - Math.max(start, waits[index][0]);
    }
  }
  function total(keys) {
    const reported = turns.flatMap(({ data }) => keys.map(key => data.usage?.[key]).filter(value => Number.isFinite(value) && value >= 0));
    return reported.length ? reported.reduce((sum, value) => sum + value, 0) : null;
  }
  return { elapsedMs: events.at(-1).occurredAt - events[0].occurredAt, workMs: spans.length ? workMs : null,
    waitMs: waits.length || events[0].data.progress === 1 ? waitMs : null,
    input: total(['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']),
    cached: total(['cache_read_input_tokens']), output: total(['output_tokens']),
    partial: events[0].data.progress !== 1 || measured.length !== turns.length ||
      turns.some(({ data }) => !Number.isFinite(data.usage?.input_tokens) || !Number.isFinite(data.usage?.output_tokens)) };
}

const topTools = calls => Object.entries(calls.reduce((counts, event) => {
  const tool = typeof event.data?.tool === 'string' ? event.data.tool : '?';
  counts[tool] = (counts[tool] ?? 0) + 1;
  return counts;
}, {})).sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1)).map(([tool, count]) => ({ tool, count }));

// discipline: the reduced discipline state (or null); reviews: reduceReviews output.
export function sessionTimeline(events, projectId, sessionId, { discipline = null, reviews = [], now = Date.now(), includeProgress = true } = {}) {
  const list = (Array.isArray(events) ? events : []).filter(event => event?.projectId === projectId && event.sessionId === sessionId && event.data).sort(byTime);
  if (!list.length) return null;
  const requests = new Map(list.filter(event => event.kind === 'spawn.request').map(event => [event.data.spawnAttemptId, event]));
  const spawns = list.filter(event => event.kind === 'spawn.result' && event.data.status === 'started' && typeof event.data.childAgentId === 'string');
  const agents = spawns.map(spawn => {
    const agentId = spawn.data.childAgentId, own = list.filter(event => event.agentId === agentId);
    const request = requests.get(spawn.data.spawnAttemptId), end = own.find(event => event.kind === 'turn.complete');
    const calls = own.filter(event => event.kind === 'tool.request');
    const name = spawn.data.citizen?.name ?? request?.data.agentType ?? 'agent';
    const violations = (discipline?.violations ?? []).filter(record => record.sessionId === sessionId && record.agentId === agentId);
    const review = reviews.find(item => item.sessionId === sessionId && item.agentId === agentId) ?? null;
    const startedAt = request?.occurredAt ?? spawn.occurredAt, lastSeen = own.at(-1)?.occurredAt ?? spawn.occurredAt;
    const status = end ? (end.data.isAborted || (end.data.reason && end.data.reason !== 'answer') ? 'stopped' : 'done')
      : now - lastSeen < STALE_MS ? 'running' : 'unfinished';
    return {
      agentId, name, startedAt, endedAt: end?.occurredAt ?? null, status,
      model: end?.data.model ?? spawn.data.citizen?.resolvedModel ?? null,
      role: spawn.data.profile?.runRole ?? roleOf(name), difficulty: spawn.data.profile?.difficulty ?? null,
      durationMs: Number.isFinite(end?.data.durationMs) ? end.data.durationMs : end ? end.occurredAt - startedAt : null,
      calls: calls.length, tools: topTools(calls),
      files: [...new Set(calls.map(event => event.data.file?.path).filter(path => typeof path === 'string'))].length,
      violations: violations.map(record => ({ id: record.id, sanction: record.sanction, status: record.status, ruleIds: record.ruleIds ?? [] })),
      detained: violations.some(record => record.sanction === 'detain' && record.status === 'active'),
      quality: review?.quality ?? null, reviewId: review?.id ?? null,
      findings: review ? review.findings.filter(finding => ['open', 'confirmed'].includes(finding.state)).map(finding => ({ ref: finding.ref, state: finding.state, severity: finding.severity, claim: finding.claim })) : [],
    };
  });
  // An agent that starts before an earlier one has ended runs beside it, on the next free lane.
  const lanes = [];
  for (const agent of agents) {
    let lane = lanes.findIndex(end => end !== null && end <= agent.startedAt);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = agent.endedAt ?? (agent.status === 'running' ? null : agent.startedAt);
    agent.lane = lane;
    agent.parallel = agents.some(other => other !== agent && other.startedAt < (agent.endedAt ?? Infinity) && agent.startedAt < (other.endedAt ?? Infinity));
  }
  const main = list.filter(event => event.agentId === null);
  const start = list.find(event => event.kind === 'session.start');
  return {
    sessionId, startedAt: list[0].occurredAt, endedAt: list.at(-1).occurredAt,
    main: { model: start?.data.model ?? main.findLast(event => event.kind === 'turn.complete')?.data.model ?? null,
      turns: main.filter(event => event.kind === 'turn.complete').length, calls: main.filter(event => event.kind === 'tool.request').length },
    agents, lanes: Math.max(1, lanes.length),
    ...(includeProgress ? { metrics: sessionMetrics(list), checks: verificationHistory(list) } : {}),
  };
}

// The project's sessions, newest first, with how many agents each sent.
export function recentSessions(events, projectId, limit = 20) {
  const sessions = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.projectId !== projectId || typeof event.sessionId !== 'string') continue;
    const entry = sessions.get(event.sessionId) ?? { sessionId: event.sessionId, startedAt: event.occurredAt, endedAt: event.occurredAt, agents: 0, calls: 0 };
    entry.startedAt = Math.min(entry.startedAt, event.occurredAt);
    entry.endedAt = Math.max(entry.endedAt, event.occurredAt);
    if (event.kind === 'spawn.result' && event.data?.status === 'started') entry.agents += 1;
    if (event.kind === 'tool.request') entry.calls += 1;
    sessions.set(event.sessionId, entry);
  }
  return [...sessions.values()].sort((left, right) => right.endedAt - left.endedAt).slice(0, limit);
}

export function durationText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
