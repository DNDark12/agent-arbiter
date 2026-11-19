// What happened in a session, as a timeline: the main agent's thread and a
// branch for every subagent it sent, read from evidence the ledger already
// holds (spawn requests and results, tool calls, turn ends, violations and
// judge reviews). Nothing here is written; it is a view.
import { roleOf } from './roles.js';

// A run with no recorded end this long after its last sign of life is not
// shown as running: its session most likely ended without saying so.
const STALE_MS = 30 * 60 * 1000;
const byTime = (left, right) => left.occurredAt - right.occurredAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

const topTools = calls => Object.entries(calls.reduce((counts, event) => {
  const tool = typeof event.data?.tool === 'string' ? event.data.tool : '?';
  counts[tool] = (counts[tool] ?? 0) + 1;
  return counts;
}, {})).sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1)).map(([tool, count]) => ({ tool, count }));

// discipline: the reduced discipline state (or null); reviews: reduceReviews output.
export function sessionTimeline(events, projectId, sessionId, { discipline = null, reviews = [], now = Date.now() } = {}) {
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
