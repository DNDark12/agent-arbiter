import test from 'node:test';
import assert from 'node:assert/strict';
import * as live from '../plugins/agent-arbiter/hooks/notes.js';
import * as history from '../plugins/agent-arbiter/hooks/history.js';
import { prunable } from '../plugins/agent-arbiter/hooks/retention.js';
import * as tasks from '../plugins/agent-arbiter/hooks/checklist.js';
import { world } from './fixtures.mjs';
import { observationContext } from '../plugins/agent-arbiter/hooks/context.js';
import { readProject } from '../plugins/agent-arbiter/hooks/events.js';
import { register } from '../plugins/agent-arbiter/hooks/register.js';
import { saveProjectSettings } from '../plugins/agent-arbiter/hooks/project-rules.js';

const context = { projectId: 'p', sessionId: 's', archiveRoot: '/fixture' };
const $ = { ui: { invalidate() {} } };

test('live calls are isolated by session and actor and fall back after overlapping calls', () => {
  const older = live.beginActivity($, context, 'agent', 'one', 'tool', 'Read', 100);
  const newer = live.beginActivity($, context, 'agent', 'two', 'tool', 'Bash', 110);
  assert.equal(live.currentActivity(context, 'agent').label, 'Bash');
  assert.equal(live.currentActivity({ ...context, sessionId: 'other' }, 'agent'), null);
  newer(120);
  assert.equal(live.currentActivity(context, 'agent').label, 'Read');
  live.endActorActivity($, context, 'agent', 130);
  assert.equal(live.currentActivity(context, 'agent'), null);
  assert.equal(older(140), null);
});

test('overlapping prompt intervals yield one wait duration and partial history is visible', () => {
  const events = [
    { kind: 'session.start', occurredAt: 0, data: {} },
    { kind: 'progress.wait', occurredAt: 80, data: { startedAt: 30, endedAt: 80 } },
    { kind: 'progress.wait', occurredAt: 100, data: { startedAt: 70, endedAt: 100 } },
    { kind: 'turn.complete', occurredAt: 120, data: { durationMs: 120, usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 } } },
  ];
  assert.deepEqual(history.sessionMetrics(events), { elapsedMs: 120, workMs: 50, waitMs: 70, input: 30, cached: 20, output: 5, partial: true });
  events[0].data.progress = 1;
  assert.equal(history.sessionMetrics(events).partial, false);
});

test('a failed check is only resolved by a reported pass of the same check', async () => {
  const { verificationCheck, verificationHistory } = history;
  const first = await verificationCheck('npm test -- tests/a.test.mjs', 'checkout');
  const other = await verificationCheck('npm test -- tests/b.test.mjs', 'checkout');
  const compound = await verificationCheck('npm test || true', 'checkout');
  assert.equal(first.kind, 'test');
  assert.match(first.key, /^[a-f0-9]{64}$/);
  assert.notEqual(first.key, other.key);
  assert.equal(compound.key, null);
  assert.equal(history.verificationOutcome(first, { isError:true, result:'Exit code 1' }), 'failed');
  assert.equal(history.verificationOutcome(first, { result:{ stdout:'ok', stderr:'', interrupted:false } }), 'passed');
  assert.equal(history.verificationOutcome(first, { result:{ stdout:'', stderr:'', interrupted:false, backgroundTaskId:'pending' } }), 'unknown');
  assert.equal(history.verificationOutcome(compound, { result:{ exitCode:0 } }), 'unknown');
  assert.equal(await verificationCheck('grep hello world', 'checkout'), null);
  const events = [first, other, first, first].map((check, i) => ({ kind: 'progress.check', id: String(i), occurredAt: i,
    data: { ...check, outcome: ['failed', 'passed', 'unknown', 'passed'][i] } }));
  assert.equal(verificationHistory(events.slice(0, 3)).find(row => row.outcome === 'failed').resolvedAt, null);
  assert.equal(verificationHistory(events).find(row => row.outcome === 'failed').resolvedAt, 3);
  assert.equal(prunable(events.map(event => ({ ...event, agentId: null })), 40 * 86400_000).length, 4);
});

test('task updates survive a fresh replay by stable ID, including reorder, retry and clear', async t => {
  const { $ } = await world(t);
  const ctx = await observationContext($);
  const save = (key, input) => tasks.saveChecklist($, ctx, key, tasks.reportedOperation(input));
  await save('create', { tasks: [{ id: 'a', label: 'Read', status: 'in_progress' }, { id: 'b', label: 'Verify' }] });
  await save('done', { task: { id: 'b', status: 'completed' } });
  await Promise.all([
    save('revise', { tasks: [{ id: 'b', label: 'Verify' }, { id: 'a', label: 'Read' }] }),
    save('retry', { task: { id: 'b', status: 'in_progress' } }),
  ]);
  const { events } = await readProject($, ctx);
  assert.deepEqual(tasks.checklistOf(events, ctx.sessionId).tasks.map(task => [task.id, task.status]), [['report:b', 'in_progress'], ['report:a', 'in_progress']]);
  assert.equal(tasks.checklistOf(events, 'another').tasks.length, 0);
  const corrupt = { kind: 'progress.tasks', sessionId: ctx.sessionId, agentId: null, occurredAt: Date.now(),
    id: 'invalid-operation', data: { revision: 900, operation: { type: 'replace', source: 'report' } } };
  assert.equal(tasks.checklistOf([...events, corrupt], ctx.sessionId).tasks.length, 2);
  assert.throws(() => tasks.reportedOperation({ tasks: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }), /duplicate/i);
  await assert.rejects(save('missing', { task: { id: 'missing', status: 'completed' } }), /unknown/i);
  assert.equal((await save('clear', { clear: true })).tasks.length, 0);
});

test('reported checklist access stays opt-in and scoped to the main engine thread', async t => {
  const { $ } = await world(t), ctx = await observationContext($);
  $.plugin.name = 'agent-arbiter';
  const hooks = new Map();
  register((event, config, handler) => {
    if (typeof config === 'function') hooks.set(event, config);
    return { catch() {} };
  });
  const call = hooks.get('tool.call'), event = { tool: tasks.CHECKLIST_TOOL, tool_use_id: 'report-fixture',
    tasks: [{ id: 'check', label: 'Verify test' }] };
  const next = Object.assign(async () => { throw new Error('report must stay local'); }, { origin: { plugin: 'engine' } });
  assert.match((await call($, event, next)).deny, /no main-thread/);
  await saveProjectSettings($, ctx, { mode: 'observe', checklist: true });
  assert.match((await call($, { ...event, agentId: 'agent' }, next)).deny, /no main-thread/);
  assert.equal((await call($, event, next)).result, '0/1');
  assert.deepEqual(tasks.checklistOf((await readProject($, ctx)).events, ctx.sessionId).tasks.map(task => task.label), ['Verify test']);
});

test('native checklist reads structured tool results and keeps stable todo IDs across reordering', async () => {
  const todo = (content, status = 'pending') => ({ content, status });
  const make = async (newTodos) => tasks.nativeOperation({ tool: 'TodoWrite' }, { result: { newTodos } });
  const first = await make([todo('Verify'), todo('Review')]);
  const later = await make([todo('Review', 'completed'), todo('Verify')]);
  assert.equal(first.tasks[0].id, later.tasks[1].id);
  assert.equal(later.tasks[0].status, 'completed');
  assert.equal(await tasks.nativeOperation({ tool: 'TaskUpdate', status: 'completed' }, { result: { success: false } }), null);
});
