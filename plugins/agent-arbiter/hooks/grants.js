import { canonical } from './ledger.js';

export const ACTIONS = Object.freeze(['git.commit', 'git.push', 'git.reset', 'db.migrate',
  'db.seed', 'package.add', 'source.write', 'fs.delete', 'cache.flush']);

const text = (value, limit = 256) => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= limit && !/[\0\r\n]/.test(value);
const exactTarget = value => text(value, 4096) && !value.includes('*');
const environment = value => text(value, 128) && !value.includes('*') &&
  !['unknown', 'unspecified'].includes(value.toLowerCase());
const sourceValid = source => source && ['command', 'ui'].includes(source.kind) &&
  ['composer', 'bridge'].includes(source.origin) && text(source.id);
const contextValid = context => context && text(context.projectId) && text(context.sessionId);

// This accepts structured human input only. It does not infer approval from chat text.
export function normalizeGrant(input, context, provenance, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !contextValid(context) ||
      !sourceValid(provenance) || !Number.isFinite(now) || !text(input.id) ||
      !ACTIONS.includes(input.action) || !exactTarget(input.target) || !environment(input.environment) ||
      !Number.isFinite(input.expiresAt) || input.expiresAt <= now ||
      (input.projectId !== undefined && input.projectId !== context.projectId) ||
      (input.sessionId !== undefined && input.sessionId !== context.sessionId) ||
      (input.agentId != null && !text(input.agentId)) ||
      !input.scope || !['session', 'task', 'command'].includes(input.scope.kind) || !text(input.scope.id) ||
      (input.scope.kind === 'session' && input.scope.id !== context.sessionId)) return null;
  return { id: input.id, action: input.action, target: input.target, environment: input.environment,
    scope: { kind: input.scope.kind, id: input.scope.id }, projectId: context.projectId,
    sessionId: context.sessionId, agentId: input.agentId ?? null, expiresAt: input.expiresAt,
    source: { kind: provenance.kind, origin: provenance.origin, id: provenance.id } };
}

export function grantMatches(grant, request, context, now) {
  if (!grant || grant.revoked || !request) return false;
  const valid = normalizeGrant(grant, context, grant.source, now);
  if (!valid || valid.action !== request.action || valid.target !== request.target ||
      valid.environment !== request.environment ||
      (valid.agentId !== null && valid.agentId !== request.agentId)) return false;
  return valid.scope.id === (valid.scope.kind === 'session' ? context.sessionId :
    valid.scope.kind === 'task' ? request.taskId : request.toolCallId);
}

// Revocation wins regardless of event order; a grant ID can never be reissued.
export function reduceGrants(events) {
  const variants = new Map();
  const revoked = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (!contextValid(event) || !event.data) continue;
    const key = id => canonical([event.projectId, event.sessionId, id]);
    if (event.kind === 'grant.revoked' && text(event.data.grantId) && sourceValid(event.data.source)) {
      revoked.add(key(event.data.grantId));
    }
    if (event.kind !== 'grant.created') continue;
    const input = event.data.grant;
    const grant = normalizeGrant(input, event, input?.source, Number.isFinite(event.occurredAt) ? event.occurredAt : 0);
    if (!grant) continue;
    const id = key(grant.id);
    if (!variants.has(id)) variants.set(id, new Map());
    variants.get(id).set(canonical(grant), grant);
  }
  return [...variants.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([id, values]) => ({ ...[...values.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)[0][1],
      revoked: revoked.has(id) || values.size !== 1 }));
}
