import { canonical, digest } from './ledger.js';
import { ACTIONS, grantMatches } from './grants.js';

export { ACTIONS } from './grants.js';

const text = value => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= 4096 && !/[\0\r\n]/.test(value);
const exact = value => text(value) && !value.includes('*');
const knownEnvironment = value => exact(value) && !['unknown', 'unspecified'].includes(value.toLowerCase());
const sourceId = 'agent-court.phase2';
const builtinSource = ACTIONS.map(action => ({ id: `builtin.${action}`, action, target: null,
  environment: null, effect: 'approval', group: ['git.reset', 'fs.delete', 'cache.flush'].includes(action)
    ? 'destructive' : 'ordinary', source: { kind: 'builtin', id: sourceId }, priority: 0 }));

// Phase 2/3 used one hash for this exact ordered catalog. Keep its metadata
// independent of the current catalog so later additions cannot rewrite history.
const legacyBuiltinSource = ['git.commit', 'git.push', 'git.reset', 'db.migrate',
  'db.seed', 'package.add', 'source.write', 'fs.delete', 'cache.flush'].map(action => ({
  id: `builtin.${action}`, action, target: null, environment: null, effect: 'approval',
  group: ['git.reset', 'fs.delete', 'cache.flush'].includes(action) ? 'destructive' : 'ordinary',
  source: { kind: 'builtin', id: 'agent-court.phase2' }, priority: 0 }));

// Hash the canonical rule content, never its prior version or surrounding catalog.
export async function builtinRuleVersion({ version, ...rule }) {
  return digest(canonical(rule));
}

export async function builtinHistory() {
  const { rules } = await compileRules();
  const version = await digest(canonical(legacyBuiltinSource));
  return [...rules, ...legacyBuiltinSource.map(rule =>
    ({ ...rule, source: { ...rule.source }, version }))];
}

export function normalizeRule(input) {
  if (!input || !text(input.id) || !ACTIONS.includes(input.action) ||
      !['approval', 'deny'].includes(input.effect) ||
      !['ordinary', 'destructive', 'always-deny'].includes(input.group) ||
      !input.source || !['builtin', 'global', 'project', 'user'].includes(input.source.kind) ||
      !text(input.source.id) || !text(input.version) || !Number.isSafeInteger(input.priority) ||
      (input.group === 'always-deny' && input.effect !== 'deny')) return null;
  const builtin = input.source.kind === 'builtin' && input.source.id === sourceId &&
    input.id === `builtin.${input.action}` && input.effect === 'approval' && input.priority === 0 &&
    input.group === builtinSource.find(rule => rule.action === input.action).group &&
    input.target === null && input.environment === null && /^[a-f0-9]{64}$/.test(input.version);
  if (!builtin && (!exact(input.target) || !knownEnvironment(input.environment))) return null;
  return { id: input.id, action: input.action, target: input.target, environment: input.environment,
    effect: input.effect, group: input.group, source: { kind: input.source.kind, id: input.source.id },
    version: input.version, priority: input.priority };
}

export async function compileRules(customRules = []) {
  if (!Array.isArray(customRules)) throw new TypeError('Invalid rules array');
  const rules = await Promise.all(builtinSource.map(async rule =>
    ({ ...rule, source: { ...rule.source }, version: await builtinRuleVersion(rule) })));
  const ids = new Set(rules.map(rule => rule.id));
  for (const input of customRules) {
    const rule = normalizeRule(input);
    // User rules are exact; only the fixed builtins may have template selectors.
    if (!rule || rule.source.kind === 'builtin' || ids.has(rule.id)) throw new TypeError('Invalid or duplicate rule');
    ids.add(rule.id);
    rules.push(rule);
  }
  rules.sort((left, right) => right.priority - left.priority || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { rules, version: await digest(canonical(rules)) };
}

const decision = (outcome, reason, lawId = null, grantId = null, violation = false) =>
  ({ outcome, reason, grantId, lawId, violation });

// Observe-only: this calculates a decision, and never changes engine permissions.
export function evaluate(request, grants, rules, context, now) {
  if (!request || !ACTIONS.includes(request.action) || !exact(request.target) ||
      !knownEnvironment(request.environment) || typeof request.requestedApproval !== 'boolean' ||
      !context || !text(context.projectId) || !text(context.sessionId) || !Number.isFinite(now) ||
      !Array.isArray(grants) || !Array.isArray(rules)) return decision('unknown', 'incomplete-classification');
  const normalized = rules.map(normalizeRule);
  if (normalized.some(rule => !rule) || new Set(normalized.map(rule => rule.id)).size !== normalized.length) {
    return decision('unknown', 'invalid-laws');
  }
  const matching = normalized.filter(rule => rule.action === request.action &&
    (rule.target === null || rule.target === request.target) &&
    (rule.environment === null || rule.environment === request.environment))
    .sort((left, right) => right.priority - left.priority || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  // Resolve competing laws by approved source priority first. Grants never change a law.
  const selected = matching.filter(rule => rule.priority === matching[0]?.priority);
  const deny = selected.find(rule => rule.effect === 'deny');
  if (deny) return decision('deny', 'always-denied', deny.id, null, true);
  const law = selected.find(rule => rule.effect === 'approval');
  if (!law) return decision('unknown', 'no-applicable-law');
  const valid = grants.filter(grant => grantMatches(grant, request, context, now))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)[0];
  if (valid) return decision('allow', 'matching-grant', law.id, valid.id);
  return request.requestedApproval ? decision('ask', 'approval-requested', law.id) :
    decision('deny', 'approval-required', law.id, null, true);
}
