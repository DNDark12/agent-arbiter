import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical } from '../plugins/agent-arbiter/hooks/ledger.js';
import * as statutes from '../plugins/agent-arbiter/hooks/statutes.js';

const sha256 = value => createHash('sha256').update(canonical(value)).digest('hex');
const unversioned = ({ version, ...rule }) => rule;
// Frozen Phase 2/3 catalog: its order and metadata are part of the old hash.
const legacySource = ['git.commit', 'git.push', 'git.reset', 'db.migrate', 'db.seed',
  'package.add', 'source.write', 'fs.delete', 'cache.flush'].map(action => ({
  id: `builtin.${action}`, action, target: null, environment: null, effect: 'approval',
  group: ['git.reset', 'fs.delete', 'cache.flush'].includes(action) ? 'destructive' : 'ordinary',
  source: { kind: 'builtin', id: 'agent-court.phase2' }, priority: 0,
}));
const legacyVersion = 'c888dab741ee5f6551e14f0b2fdcf4e9a90828b0a4843fdd1fa350b4dc8db1d5';

test('compiled builtin versions hash each rule instead of the surrounding catalog', async () => {
  const compiled = await statutes.compileRules();
  assert.equal(compiled.rules.length, statutes.ACTIONS.length);
  assert.equal(new Set(compiled.rules.map(rule => rule.id)).size, compiled.rules.length);
  assert.equal(new Set(compiled.rules.map(rule => rule.version)).size, compiled.rules.length);
  for (const rule of compiled.rules) {
    assert.equal(rule.version, sha256(unversioned(rule)));
    assert.match(rule.version, /^[a-f0-9]{64}$/);
    assert.deepEqual(statutes.normalizeRule(rule), rule);
  }
  assert.equal(compiled.version, sha256(compiled.rules));
});

test('standalone builtin versions survive catalog extension and reordering', async () => {
  assert.equal(typeof statutes.builtinRuleVersion, 'function');
  const original = await statutes.compileRules();
  const added = { ...unversioned(original.rules[0]), id: 'builtin.future.action', action: 'future.action' };
  const extended = [added, ...original.rules.toReversed()];
  const versions = new Map(await Promise.all(extended.map(async rule =>
    [rule.id, await statutes.builtinRuleVersion(rule)])));
  for (const rule of original.rules) assert.equal(versions.get(rule.id), rule.version);
  assert.equal(versions.get(added.id), sha256(added));
  const rule = original.rules[0];
  assert.equal(await statutes.builtinRuleVersion({ ...rule, version: legacyVersion }), rule.version);
  assert.equal(await statutes.builtinRuleVersion({ priority: rule.priority, source: rule.source,
    group: rule.group, effect: rule.effect, environment: rule.environment, target: rule.target,
    action: rule.action, id: rule.id }), rule.version);
  assert.notEqual(await statutes.builtinRuleVersion({ ...rule, priority: 1 }), rule.version);
});

test('builtin history contains only current rules and exact frozen Phase 2/3 aliases', async () => {
  assert.equal(typeof statutes.builtinHistory, 'function');
  assert.equal(sha256(legacySource), legacyVersion);
  const current = (await statutes.compileRules()).rules;
  const aliases = legacySource.map(rule => ({ ...rule, version: legacyVersion }));
  const history = await statutes.builtinHistory();
  assert.equal(history.length, current.length + aliases.length);
  const key = rule => `${rule.id}:${rule.version}`;
  assert.equal(new Set(history.map(key)).size, history.length);
  assert.deepEqual(history.toSorted((a, b) => key(a).localeCompare(key(b))),
    [...current, ...aliases].toSorted((a, b) => key(a).localeCompare(key(b))));
  for (const alias of aliases) assert.deepEqual(statutes.normalizeRule(alias), alias);
  history[0].source.id = 'mutated';
  assert.deepEqual(await statutes.builtinHistory(), [...current, ...aliases]);
});

test('active rules retain approval evaluation and custom priority without history aliases', async () => {
  const request = { action: 'git.commit', target: 'feature', environment: 'local', requestedApproval: false };
  const context = { projectId: 'project', sessionId: 'session' };
  const custom = { id: 'protected', action: request.action, target: request.target,
    environment: request.environment, effect: 'deny', group: 'always-deny',
    source: { kind: 'project', id: 'project-rules' }, version: 'approved-v1', priority: 100 };
  const { rules } = await statutes.compileRules();
  assert.equal(statutes.evaluate(request, [], rules, context, 1000).reason, 'approval-required');
  assert.equal(statutes.evaluate({ ...request, requestedApproval: true }, [], rules, context, 1000).outcome, 'ask');
  const compiled = await statutes.compileRules([custom]);
  assert.deepEqual(compiled.rules[0], custom);
  assert.equal(new Set(compiled.rules.map(rule => rule.id)).size, compiled.rules.length);
  assert.equal(statutes.evaluate(request, [], compiled.rules, context, 1000).lawId, custom.id);
  assert.equal(statutes.evaluate(request, [], compiled.rules, context, 1000).reason, 'always-denied');
  await assert.rejects(statutes.compileRules([rules[0]]), /rule/i);
});
