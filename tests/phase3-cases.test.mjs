import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, digest } from '../plugins/agent-arbiter/hooks/ledger.js';

import { caseId, normalizeJudgment, reduceCases as replayCases } from '../plugins/agent-arbiter/hooks/cases.js';
const id = number => number.toString(16).padStart(64, '0');
const projectId = id(1);
const citizenId = id(2);
const source = { kind: 'command', origin: 'composer', id: 'human-command' };
const empty = { trustDelta: 0, restrictions: [], lessonIds: [] };
const judgment = (extra = {}) => ({ caseId: id(10), citizenId,
  actor: { sessionId: 'session', agentId: 'agent' }, law: { id: 'approval', version: id(3) },
  evidenceIds: [id(4)], dependencyIds:[id(7),id(8)], outcome: 'guilty', reason: 'Reviewed the exact tool evidence.',
  effects: { trustDelta: -3, restrictions: ['fine', 'probation'], lessonIds: [id(5)] },
  anchorAt: 100, ...extra });
const event = (number, kind, data, occurredAt = number) => ({ schemaVersion: 1,
  id: id(number), projectId, sessionId: 'session', agentId: null, kind, occurredAt, data });
const verdict = (number = 100, value = judgment()) => event(number, 'verdict.recorded', { judgment: value, source });
const decision = (number, decision, target = id(10), provenance = source) => event(number,
  'appeal.decided', { caseId: target, decision, reason: 'Reviewed appeal.', source: provenance });
const pardon = number => event(number, 'case.pardoned', { caseId: id(10), reason: 'Human pardon.', source });
// Shared actual evidence records for the synthetic judgment fixtures.
const support = [{...event(4,'tool.request',{toolCallId:'call-a',tool:'Write',file:{path:'a.js'},environment:'local'},10),agentId:'agent'},
  {...event(6,'tool.request',{toolCallId:'call-b',tool:'Write',file:{path:'a.js'},environment:'local'},11),agentId:'agent'},
  event(9,'tool.request',{toolCallId:'call-main',tool:'Write',file:{path:'a.js'},environment:'local'},12),
  event(7,'laws.approved',{source,rules:[{id:'approval',version:id(3),action:'source.write',target:'a.js',environment:'local',effect:'approval',group:'ordinary',source:{kind:'project',id:'rules'},priority:30}]}),
  event(8,'spawn.result',{status:'started',childAgentId:'agent',citizen:{id:citizenId}})];
const reduceCases = (events,project) => replayCases([...support,...events],project);


test('case identity hashes the canonical law/version and sorted unique evidence', async () => {
  assert.equal(typeof caseId, 'function');
  assert.equal(await caseId('approval', id(3), [id(6), id(4), id(6)]),
    await digest(canonical(['approval', id(3), [id(4), id(6)]])));
  await assert.rejects(caseId('approval', id(3), []), /invalid/i);
});

test('judgments normalize sets, keep explicit effects and never infer trust points', () => {
  const input = judgment({ evidenceIds: [id(6), id(4), id(6)],
    effects: { restrictions: ['probation', 'fine', 'fine'], lessonIds: [id(7), id(5), id(7)] } });
  const before = structuredClone(input);
  const value = normalizeJudgment(input);
  assert.deepEqual(value.evidenceIds, [id(4), id(6)]);
  assert.deepEqual(value.effects, { trustDelta: 0, restrictions: ['fine', 'probation'], lessonIds: [id(5), id(7)] });
  assert.deepEqual(input, before);
});

test('invalid judgments and forbidden consequences fail closed', () => {
  for (const extra of [{ caseId: 'invalid' }, { citizenId: null }, { evidenceIds: [] },
    { law: { id: '', version: id(3) } }, { anchorAt: Infinity }, { reason: 'x'.repeat(4097) },
    { effects: { ...empty, trustDelta: 1 } }, { effects: { ...empty, trustDelta: -0.5 } },
    { effects: { ...empty, restrictions: ['ban'] } },
    { effects: { ...empty, lessonIds: ['invalid'] } },
    { actor: { sessionId: '', agentId: 'agent' } }]) assert.equal(normalizeJudgment(judgment(extra)), null);
  for (const outcome of ['not-guilty', 'unknown']) {
    assert.equal(normalizeJudgment(judgment({ outcome })), null);
    assert.deepEqual(normalizeJudgment(judgment({ outcome, citizenId: null, effects: empty })).effects, empty);
  }
  const actor = { sessionId: 'session', agentId: null };
  assert.equal(normalizeJudgment(judgment({ actor })), null);
  assert.deepEqual(normalizeJudgment(judgment({ actor, citizenId: null, effects: { ...empty, restrictions: ['warning'] } })).effects,
    { ...empty, restrictions: ['warning'] });
});

test('overturn removes every effect from its case and preserves another case', () => {
  const other = judgment({ caseId: id(11), evidenceIds: [id(6)],
    effects: { trustDelta: -2, restrictions: ['warning'], lessonIds: [id(7)] } });
  const result = reduceCases([verdict(), verdict(101, other), decision(102, 'overturn')], projectId);
  assert.equal(result.cases[0].status, 'cleared');
  assert.equal(result.cases[0].currentOutcome, 'not-guilty');
  assert.deepEqual(result.cases[0].effects, empty);
  assert.deepEqual(result.citizens, [{ citizenId, caseIds: [id(11)], trustDelta: -2,
    restrictions: ['warning'], lessonIds: [id(7)] }]);
});

test('pardon removes all linked effects and later appeal cannot reimpose them', () => {
  const result = reduceCases([verdict(), pardon(102), decision(103, 'uphold')], projectId);
  assert.equal(result.cases[0].status, 'pardoned');
  assert.deepEqual(result.cases[0].effects, empty);
  assert.deepEqual(result.citizens[0], { citizenId, caseIds: [], ...empty });
  const other = judgment({ caseId: id(11), evidenceIds: [id(6)],
    effects: { trustDelta: -2, restrictions: ['warning'], lessonIds: [id(7)] } });
  const together = reduceCases([verdict(), verdict(101, other), pardon(102), decision(103, 'uphold')], projectId);
  assert.deepEqual(together.citizens[0], { citizenId, caseIds: [id(11)], trustDelta: -2,
    restrictions: ['warning'], lessonIds: [id(7)] });
});

test('main actor warning can have no citizen and never creates a citizen aggregate', () => {
  const main = judgment({ evidenceIds:[id(9)],citizenId: null, actor: { sessionId: 'session', agentId: null },
    effects: { ...empty, restrictions: ['warning'] } });
  const result = reduceCases([verdict(100, main)], projectId);
  assert.equal(result.cases[0].status, 'active');
  assert.deepEqual(result.citizens, []);
});

test('unknown and acquittal judgments project no effects', () => {
  for (const outcome of ['not-guilty', 'unknown']) {
    const result = reduceCases([verdict(100, judgment({ outcome, effects: empty }))], projectId);
    assert.equal(result.cases[0].status, outcome === 'unknown' ? 'unknown' : 'cleared');
    assert.deepEqual(result.cases[0].effects, empty);
    assert.deepEqual(result.citizens[0], { citizenId, caseIds: [], ...empty });
  }
});

test('appeal requests only set pending and latest trusted decision controls outcome', () => {
  const request = event(104, 'appeal.requested', { caseId: id(10), reason: 'Please review.',
    source: { kind: 'command', origin: 'sdk', id: 'sdk' } });
  const pending = reduceCases([verdict(), request], projectId).cases[0];
  assert.equal(pending.appealStatus, 'pending'); assert.equal(pending.status, 'active');
  const events = [verdict(), decision(101, 'overturn'), decision(102, 'uphold'), decision(103, 'unknown'), request];
  const result = reduceCases(events, projectId).cases[0];
  assert.equal(result.appealStatus, 'pending'); assert.equal(result.status, 'unknown');
  assert.deepEqual(result.effects, empty);
});

test('SDK/plugin/unknown sources cannot issue verdicts, resolve or pardon', () => {
  for (const origin of ['sdk', 'plugin', 'asUser', 'unknown']) {
    const untrusted = { ...source, origin };
    assert.deepEqual(reduceCases([{ ...verdict(), data: { judgment: judgment(), source: untrusted } }], projectId).cases, []);
    const events = [verdict(), decision(101, 'overturn', id(10), untrusted),
      { ...pardon(102), data: { ...pardon(102).data, source: untrusted } }];
    assert.equal(reduceCases(events, projectId).cases[0].status, 'active');
  }
});

test('replay is deterministic for reversed, shuffled and duplicated events without mutation', () => {
  const events = [verdict(), decision(101, 'overturn'), decision(102, 'uphold'), pardon(103)];
  const before = structuredClone(events);
  const expected = reduceCases(events, projectId);
  assert.deepEqual(reduceCases(events.toReversed(), projectId), expected);
  assert.deepEqual(reduceCases([events[2], events[0], events[3], events[1], ...events], projectId), expected);
  assert.deepEqual(events, before);
  assert.deepEqual(reduceCases(events, id(900)), { cases: [], citizens: [], conflicts: [] });
});

test('identical normalized judgments coalesce while divergent judgments dispute the case', () => {
  const duplicate = judgment({ evidenceIds: [id(4), id(4)], effects: {
    trustDelta: -3, restrictions: ['probation', 'fine', 'fine'], lessonIds: [id(5), id(5)] } });
  const same = reduceCases([verdict(), verdict(101, duplicate)], projectId);
  assert.equal(same.cases.length, 1); assert.equal(same.citizens[0].trustDelta, -3);
  const events = [verdict(), verdict(101, judgment({ reason: 'Conflicting human judgment.' }))];
  const result = reduceCases(events, projectId);
  assert.equal(result.cases[0].status, 'disputed'); assert.deepEqual(result.cases[0].effects, empty);
  assert.ok(result.conflicts.length); assert.deepEqual(reduceCases(events.toReversed(), projectId), result);
});

test('contradictory event IDs invalidate all referenced cases including rejected resolutions', () => {
  const first = decision(102, 'overturn');
  const second = { ...first, data: { ...first.data, decision: 'uphold' } };
  const events = [verdict(), first, second];
  const result = reduceCases(events, projectId);
  assert.equal(result.cases[0].status, 'disputed'); assert.deepEqual(result.cases[0].effects, empty);
  assert.deepEqual(reduceCases(events.toReversed(), projectId), result);
  const verdictVariants = [verdict(), { ...verdict(), data: { judgment: judgment({ caseId: id(11) }), source } }];
  const disputed = reduceCases(verdictVariants, projectId);
  assert.equal(disputed.cases.length, 2);
  assert.ok(disputed.cases.every(item => item.status === 'disputed'));
});

test('persisted ledger and case conflicts invalidate evidence or event effects conservatively', () => {
  for (const marker of [event(103, 'ledger.conflict', { targetId: id(4) }),
    event(103, 'ledger.conflict', { targetId: id(100) }),
    event(103, 'case.conflicted', { caseId: id(10) })]) {
    const result = reduceCases([verdict(), marker], projectId);
    assert.equal(result.cases[0].status, 'disputed'); assert.deepEqual(result.cases[0].effects, empty);
    assert.ok(result.conflicts.length);
  }
});

test('conflicting persisted conflict markers cannot restore either affected case', () => {
  const other = judgment({ caseId: id(11), evidenceIds: [id(6)] });
  const marker = event(103, 'ledger.conflict', { targetId: id(4) });
  const variant = { ...marker, data: { targetId: id(6) } };
  const result = reduceCases([verdict(), verdict(101, other), marker, variant], projectId);
  assert.ok(result.cases.every(value => value.status === 'disputed'));
  assert.deepEqual(result.citizens[0], { citizenId, caseIds: [], ...empty });
});

test('a lesson shared with a pardoned case is withdrawn while independent sanctions remain',()=>{
 const other=judgment({caseId:id(11),evidenceIds:[id(6)],effects:{trustDelta:-2,restrictions:['warning'],lessonIds:[id(5)]}});
 const result=reduceCases([verdict(),verdict(101,other),pardon(102)],projectId);
 assert.equal(result.citizens[0].trustDelta,-2);
 assert.deepEqual(result.citizens[0].restrictions,['warning']);
 assert.deepEqual(result.citizens[0].lessonIds,[]);
});
test('unrepresentable aggregate trust delta is unknown instead of rounded',()=>{
 const effects={trustDelta:Number.MIN_SAFE_INTEGER,restrictions:[],lessonIds:[]};
 const other=judgment({caseId:id(11),evidenceIds:[id(6)],effects});
 const result=reduceCases([verdict(100,judgment({effects})),verdict(101,other)],projectId);
 assert.equal(result.citizens[0].trustDelta,null);
 assert.equal(result.citizens[0].scoreIncomplete,true);
});

test('legacy guilty records without explicit provenance remain visible but have no effects',()=>{
 const result=reduceCases([verdict(100,judgment({dependencyIds:[]}))],projectId);
 assert.equal(result.cases[0].status,'disputed');
 assert.equal(result.citizens[0].trustDelta,0);
 assert.deepEqual(result.citizens[0].restrictions,[]);
});
