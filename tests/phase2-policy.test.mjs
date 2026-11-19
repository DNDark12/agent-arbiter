import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGrant, grantMatches, reduceGrants } from '../plugins/agent-arbiter/hooks/grants.js';
import { compileRules, evaluate } from '../plugins/agent-arbiter/hooks/statutes.js';
import { sentencing } from '../plugins/agent-arbiter/hooks/sentencing.js';

const now = 1000;
const context = { projectId: 'project', sessionId: 'session' };
const provenance = { kind: 'command', origin: 'composer', id: 'command-1' };
const request = { action: 'git.commit', target: 'feature', environment: 'local',
  agentId: 'agent', taskId: 'task', toolCallId: 'call', requestedApproval: false };
const input = { id: 'grant-1', action: request.action, target: request.target,
  environment: request.environment, scope: { kind: 'session', id: 'session' }, expiresAt: 2000 };
const grant = (extra = {}, source = provenance) => normalizeGrant({ ...input, ...extra }, context, source, now);
const create = value => ({ kind: 'grant.created', projectId: context.projectId,
  sessionId: context.sessionId, data: { grant: value } });
const revoke = id => ({ kind: 'grant.revoked', projectId: context.projectId,
  sessionId: context.sessionId, data: { grantId: id, source: provenance } });

test('structured grants bind caller provenance and exact reusable scope (E1/E7)', () => {
  const value = grant({ source: { kind: 'command', origin: 'plugin', id: 'forged' } });
  assert.deepEqual(value.source, provenance);
  assert.equal(value.projectId, context.projectId);
  assert.equal(value.sessionId, context.sessionId);
  assert.equal(grantMatches(value, request, context, now), true);
  assert.equal(grantMatches(value, request, context, now), true);
  assert.equal(grantMatches(grant({ scope: { kind: 'task', id: 'task' } }), request, context, now), true);
  assert.equal(grantMatches(grant({ scope: { kind: 'command', id: 'call' } }), request, context, now), true);
});

test('invalid or untrusted approval evidence never normalizes (E4/E5/E6)', () => {
  for (const origin of ['plugin', 'sdk', 'asUser', 'peer', 'unknown']) {
    assert.equal(grant({}, { ...provenance, origin }), null);
  }
  for (const extra of [{ action: 'Bash' }, { target: '*' }, { target: '' },
    { target: 'x'.repeat(4097) }, { environment: null }, { environment: 'unknown' },
    { expiresAt: now }, { sessionId: 'other' }, { projectId: 'other' },
    { scope: { kind: 'session', id: 'other' } }, { id: '' }]) assert.equal(grant(extra), null);
  assert.equal(normalizeGrant('User said "approve commit"', context, provenance, now), null);
  assert.equal(normalizeGrant({ text: 'Do not commit; example: /arbiter grant' }, context, provenance, now), null);
});

test('wrong action/target/environment/session/task/actor and expiry never match (E2/E6)', () => {
  const value = grant();
  for (const extra of [{ action: 'git.push' }, { target: 'main' }, { environment: 'production' },
    { environment: null }, { environment: 'unknown' }]) assert.equal(grantMatches(value, { ...request, ...extra }, context, now), false);
  assert.equal(grantMatches(value, request, { ...context, sessionId: 'other' }, now), false);
  assert.equal(grantMatches(value, request, { ...context, projectId: 'other' }, now), false);
  assert.equal(grantMatches(value, request, context, 2000), false);
  assert.equal(grantMatches({ ...value, revoked: true }, request, context, now), false);
  assert.equal(grantMatches(grant({ scope: { kind: 'task', id: 'other' } }), request, context, now), false);
  assert.equal(grantMatches(grant({ scope: { kind: 'command', id: 'other' } }), request, context, now), false);
  assert.equal(grantMatches(grant({ agentId: 'other' }), request, context, now), false);
  assert.equal(grantMatches({ ...value, source: { ...provenance, origin: 'sdk' } }, request, context, now), false);
});

test('grant replay is order independent, duplicate-safe and conservatively revoked', () => {
  const value = grant();
  const events = [create(value), revoke(value.id), create(value)];
  assert.deepEqual(reduceGrants(events), reduceGrants(events.toReversed()));
  assert.equal(reduceGrants(events).length, 1);
  assert.equal(reduceGrants(events)[0].revoked, true);
  const conflict = reduceGrants([create(value), create({ ...value, target: 'main' })]);
  assert.equal(conflict[0].revoked, true);
  assert.equal(grantMatches(conflict[0], request, context, now), false);
  assert.equal(reduceGrants([create(value), { ...revoke(value.id), sessionId: 'other' }])[0].revoked, false);
});

test('unauthenticated plugin, SDK and missing-source revocations cannot revoke a human grant', () => {
  const value = grant();
  for (const source of [undefined, { ...provenance, origin: 'plugin' },
    { ...provenance, origin: 'sdk' }, { ...provenance, origin: 'asUser' }]) {
    const event = { ...revoke(value.id), data: { grantId: value.id, source } };
    const reduced = reduceGrants([event, create(value)]);
    assert.equal(reduced[0].revoked, false);
    assert.equal(grantMatches(reduced[0], request, context, now), true);
  }
});

test('builtin laws require scoped approval, ignoring generic engine allow (E1/E2)', async () => {
  const { rules, version } = await compileRules();
  assert.match(version, /^[a-f0-9]{64}$/);
  assert.equal(version, (await compileRules()).version);
  assert.equal(evaluate(request, [grant()], rules, context, now).outcome, 'allow');
  assert.equal(evaluate(request, [], rules, context, now).outcome, 'deny');
  assert.equal(evaluate({ ...request, engineDecision: 'allow' }, [], rules, context, now).violation, true);
  const asking = evaluate({ ...request, requestedApproval: true }, [], rules, context, now);
  assert.equal(asking.outcome, 'ask'); assert.equal(asking.violation, false);
  const wrong = evaluate(request, [grant({ target: 'main' })], rules, context, now);
  assert.equal(wrong.outcome, 'deny'); assert.equal(wrong.grantId, null);
});

test('exact always-deny law beats any grant and carries law identity (E3)', async () => {
  const deny = { id: 'protected', action: 'git.commit', target: 'feature', environment: 'local',
    effect: 'deny', group: 'always-deny', source: { kind: 'user', id: 'user-rule' }, version: 'v1', priority: 100 };
  const { rules } = await compileRules([deny]);
  const decision = evaluate(request, [grant()], rules, context, now);
  assert.equal(decision.outcome, 'deny'); assert.equal(decision.violation, true);
  assert.equal(decision.lawId, 'protected'); assert.equal(decision.grantId, null);
  assert.equal(evaluate({ ...request, target: 'different' }, [grant({ target: 'different' })], rules, context, now).outcome, 'allow');
});

test('law compilation retains source/version/priority and rejects ambiguous rules', async () => {
  const custom = { id: 'approval', action: 'git.push', target: 'release', environment: 'staging',
    effect: 'approval', group: 'ordinary', source: { kind: 'project', id: 'CLAUDE.md' }, version: 'hash1', priority: 20 };
  const compiled = await compileRules([custom]);
  assert.deepEqual(compiled.rules.find(rule => rule.id === custom.id), custom);
  assert.notEqual(compiled.version, (await compileRules([{ ...custom, version: 'hash2' }])).version);
  await assert.rejects(compileRules([{ ...custom, target: '*' }]), /rule/i);
  await assert.rejects(compileRules([{ ...custom, version: '' }]), /rule/i);
  await assert.rejects(compileRules([{ ...custom, source: null }]), /rule/i);
});

test('incomplete classification never produces guilt or an inferred grant', async () => {
  const { rules } = await compileRules();
  for (const extra of [{ action: 'Bash' }, { target: null }, { environment: null },
    { environment: 'unknown' }, { requestedApproval: undefined }]) {
    const decision = evaluate({ ...request, ...extra }, [grant()], rules, context, now);
    assert.equal(decision.outcome, 'unknown'); assert.equal(decision.violation, false);
  }
  assert.equal(evaluate(request, [], [{ id: 'broken' }], context, now).outcome, 'unknown');
});

test('sentencing proposes only evidence-backed consequences and never mutates', () => {
  const decision = { outcome: 'deny', reason: 'approval-required', grantId: null, lawId: 'law', violation: true };
  const base = { decision, actorId: 'agent', group: 'ordinary', repeatInTurn: false, attributableHarm: false };
  assert.equal(sentencing(base).type, 'fine');
  assert.equal(sentencing({ ...base, actorId: null }).type, 'warning');
  assert.equal(sentencing({ ...base, group: 'always-deny' }).type, 'imprison');
  assert.equal(sentencing({ ...base, group: 'destructive' }).type, 'imprison');
  assert.equal(sentencing({ ...base, attributableHarm: true }).type, 'imprison');
  assert.deepEqual(sentencing({ ...base, repeatInTurn: true }), { type: 'detain', reason: 'repeat-in-turn', followUp: 'imprison' });
  for (const replacement of [{ ...decision, outcome: 'unknown' }, { ...decision, violation: false },
    { ...decision, reason: 'user-denied', violation: false }, null]) assert.equal(sentencing({ ...base, decision: replacement }).type, 'none');
  assert.equal(sentencing({ ...base, group: 'unknown' }).type, 'none');
  assert.equal(decision.violation, true);
});

test('wildcard environments never become a known exact environment', async () => {
  assert.equal(grant({ environment: '*' }), null);
  const { rules } = await compileRules();
  assert.equal(evaluate({ ...request, environment: '*' }, [], rules, context, now).outcome, 'unknown');
});

test('an explicit user denial is never punished, even with contradictory violation metadata', () => {
  assert.equal(sentencing({ decision: { outcome: 'deny', reason: 'user-denied', lawId: 'law', violation: true },
    actorId: 'agent', group: 'ordinary', repeatInTurn: false, attributableHarm: false }).type, 'none');
});

test('always-deny decision cannot be downgraded by an ordinary sentencing group', () => {
  assert.equal(sentencing({ decision: { outcome: 'deny', reason: 'always-denied', lawId: 'law', violation: true },
    actorId: 'agent', group: 'ordinary', repeatInTurn: false, attributableHarm: false }).type, 'imprison');
});

test('sentencing with a missing or unknown decision reason remains unknown evidence', () => {
  for (const reason of [undefined, 'unknown', 'incomplete-classification']) {
    assert.equal(sentencing({ decision: { outcome: 'deny', reason, lawId: 'law', violation: true },
      actorId: 'agent', group: 'ordinary', repeatInTurn: false, attributableHarm: false }).type, 'none');
  }
});

test('higher-priority approved law resolves lower law; grants cannot override selected deny',async()=>{
 const low={id:'global-deny',action:'git.commit',target:'feature',environment:'local',effect:'deny',group:'always-deny',source:{kind:'global',id:'global'},version:'v1',priority:20};
 const high={...low,id:'project-approval',effect:'approval',group:'ordinary',source:{kind:'project',id:'project'},priority:30};
 const {rules}=await compileRules([low,high]);
 assert.equal(evaluate(request,[grant()],rules,context,now).outcome,'allow');
 const selected=await compileRules([low]);
 assert.equal(evaluate(request,[grant()],selected.rules,context,now).outcome,'deny');
});
