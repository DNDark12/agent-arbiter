// The checklist is display data. All operations use stable IDs and are replayable
// from the routine ledger; no task state participates in policy or scoring.
import { emit, readProjectShared } from './events.js';
import { digest, canonical } from './ledger.js';
import { redact } from './privacy.js';
import { RETENTION_DAYS } from './retention.js';
import { redrawActivity } from './notes.js';

const LIMIT = 40;
const STATES = ['pending', 'in_progress', 'completed', 'skipped', 'failed'];
const queues = new Map();
export const CHECKLIST_TOOL = 'mcp__agent-arbiter__session_progress';
export const NATIVE_TASKS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TodoWrite']);

function label(value) {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Use short, plain task labels.');
  return [...redact(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()].slice(0, 120).join('');
}

function taskOf(value, source, required = false) {
  if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id)) throw new Error('Invalid task ID.');
  const task = { id: source + ':' + value.id };
  if (required || value.label !== undefined) {
    task.label = label(value.label);
    if (!task.label) throw new Error('A new task needs a label.');
  }
  if (value.stage !== undefined) task.stage = label(value.stage);
  if (value.status !== undefined) {
    if (!STATES.includes(value.status) && !(source === 'native' && value.status === 'deleted')) throw new Error('Invalid task status.');
    task.status = value.status;
  }
  return task;
}

function replaceTasks(input, source) {
  if (!Array.isArray(input) || input.length > LIMIT) throw new Error('Use at most 40 tasks.');
  const tasks = input.map(value => taskOf(value, source, true));
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('Duplicate task ID.');
  return { type: 'replace', source, tasks };
}

export function reportedOperation(input) {
  if ([input.tasks !== undefined, input.task !== undefined, input.clear === true].filter(Boolean).length !== 1) {
    throw new Error('Send one of tasks, task or clear.');
  }
  if (input.clear === true) return { type: 'clear', source: 'report' };
  if (input.tasks !== undefined) return replaceTasks(input.tasks, 'report');
  return { type: 'patch', source: 'report', task: taskOf(input.task, 'report') };
}

export async function nativeOperation(input, reply) {
  const result = reply?.result;
  if (reply?.deny !== undefined || reply?.isError || !result) return null;
  if (input.tool === 'TaskCreate' && result.task) {
    return { type: 'patch', source: 'native', task: taskOf({ id: result.task.id, label: result.task.subject, status: 'pending' }, 'native', true) };
  }
  if (input.tool === 'TaskUpdate' && result.success === true && result.updatedFields?.length) {
    const status = result.statusChange?.to ?? (result.updatedFields.includes('status') ? input.status : undefined);
    const subject = result.updatedFields.includes('subject') ? input.subject : undefined;
    if (!status && subject === undefined) return null;
    return { type: 'patch', source: 'native', task: taskOf({ id: result.taskId, label: subject, status }, 'native') };
  }
  if (input.tool === 'TaskList' && Array.isArray(result.tasks)) {
    return replaceTasks(result.tasks.slice(0, LIMIT).map(task => ({ id: task.id, label: task.subject, status: task.status })), 'native');
  }
  if (input.tool === 'TodoWrite' && Array.isArray(result.newTodos)) {
    const ids = new Map(), todos = [];
    for (const todo of result.newTodos.slice(0, LIMIT)) {
      const subject = label(todo.content), key = (await digest(subject)).slice(0, 32);
      const position = (ids.get(key) ?? 0) + 1;
      ids.set(key, position);
      todos.push({ id: key + '-' + position, label: subject, status: todo.status });
    }
    return replaceTasks(todos, 'native');
  }
  return null;
}

const done = status => status === 'completed' || status === 'skipped';

function withTask(previous, patch, at) {
  const status = patch.status ?? previous?.status ?? 'pending';
  const changed = status !== previous?.status;
  const startedAt = changed && status === 'in_progress' ? at : previous?.startedAt ?? null;
  const endedAt = done(status) || status === 'failed' ? (changed ? at : previous?.endedAt ?? at) : null;
  return { ...previous, ...patch, status, startedAt, endedAt };
}

function apply(state, operation, at) {
  if (operation.type === 'clear') return { ...state, tasks: [], source: null };
  const tasks = state.source === operation.source ? state.tasks : [];
  if (operation.type === 'replace') {
    const previous = new Map(tasks.map(task => [task.id, task]));
    return { ...state, source: operation.source, tasks: operation.tasks.map(task => withTask(previous.get(task.id), task, at)) };
  }
  if (operation.type !== 'patch' || !operation.task) return state;
  const patch = operation.task, existing = tasks.find(task => task.id === patch.id);
  if (patch.status === 'deleted') return { ...state, tasks: tasks.filter(task => task.id !== patch.id) };
  if (!existing && (!patch.label || tasks.length >= LIMIT)) return state;
  const task = withTask(existing, patch, at);
  return { ...state, source: operation.source, tasks: existing ? tasks.map(row => row.id === task.id ? task : row) : [...tasks, task] };
}

function validStoredOperation(operation) {
  if (!operation || !['native', 'report'].includes(operation.source)) return false;
  if (operation.type === 'clear') return true;
  const taskIsValid = (task, requiredLabel) => task && typeof task.id === 'string' &&
    task.id.startsWith(operation.source + ':') && /^[\w-]{1,64}$/.test(task.id.split(':')[1]) &&
    (!requiredLabel && task.label === undefined || typeof task.label === 'string' && task.label.length > 0 && task.label.length <= 240) &&
    (task.stage === undefined || typeof task.stage === 'string' && task.stage.length <= 240) &&
    (task.status === undefined || STATES.includes(task.status) || operation.source === 'native' && task.status === 'deleted');
  if (operation.type === 'patch') return Boolean(taskIsValid(operation.task, false));
  return operation.type === 'replace' && Array.isArray(operation.tasks) &&
    operation.tasks.length <= LIMIT && operation.tasks.every(task => taskIsValid(task, true)) &&
    new Set(operation.tasks.map(task => task.id)).size === operation.tasks.length;
}

export function checklistOf(events, sessionId, now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * 86400_000;
  const changes = events.filter(event => event.kind === 'progress.tasks' && event.sessionId === sessionId &&
    event.agentId === null && event.occurredAt >= cutoff && Number.isSafeInteger(event.data?.revision) &&
    event.data.revision > 0 && validStoredOperation(event.data.operation));
  changes.sort((a, b) => a.data.revision - b.data.revision || a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
  return changes.reduce((state, { data, occurredAt }) => ({ ...apply(state, data.operation, occurredAt), revision: data.revision }),
    { tasks: [], source: null, revision: 0 });
}

export function checklistSummary(state) {
  const tasks = state?.tasks ?? [], completed = tasks.filter(task => done(task.status)).length;
  return { total: tasks.length, completed, current: tasks.find(task => task.status === 'in_progress') ?? null,
    failed: tasks.find(task => task.status === 'failed') ?? null,
    endedAt: completed && completed === tasks.length ? Math.max(...tasks.map(task => task.endedAt ?? 0)) : null };
}

export function saveChecklist($, ctx, id, operation) {
  const scope = canonical([ctx.archiveRoot, ctx.projectId, ctx.sessionId]);
  const previous = queues.get(scope);
  const next = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
    const { events } = await readProjectShared($, ctx), state = checklistOf(events, ctx.sessionId);
    const operationId = await digest(id);
    if (events.some(event => event.kind === 'progress.tasks' && event.sessionId === ctx.sessionId && event.data.operationId === operationId)) return state;
    if (operation.type === 'patch' && operation.source === 'report' && !operation.task.label &&
        !state.tasks.some(task => task.id === operation.task.id)) throw new Error('Unknown task ID.');
    const updated = apply(state, operation, Date.now());
    if (canonical(updated) === canonical(state)) return state;
    const revision = state.revision + 1;
    await emit($, ctx, null, 'progress.tasks', operationId, { revision, operationId, operation });
    redrawActivity($);
    const before = checklistSummary(state), after = checklistSummary(updated);
    const chime = after.endedAt !== null && before.endedAt === null ? 'checklist-done' :
      after.failed && !before.failed ? 'check-failed' : null;
    return { ...updated, revision, chime };
  });
  queues.set(scope, next);
  return next.finally(() => { if (queues.get(scope) === next) queues.delete(scope); });
}

export async function registerChecklistTool($) {
  const tools = await $.tool.list();
  if (tools.some(tool => NATIVE_TASKS.has(tool.name))) return;
  const task = { type: 'object', required: ['id'], additionalProperties: false, properties: {
    id: { type: 'string', description: 'Stable ID, reused when the plan changes.' },
    label: { type: 'string', description: 'Short task label. Keep code, credentials and raw tool output out of labels.' },
    stage: { type: 'string' }, status: { type: 'string', enum: STATES },
  } };
  return $.tool.register({ name: 'session_progress',
    description: 'Optional session checklist for the main conversation. If enabled, send tasks to declare or revise the list, task to update an item, or clear to reset. Use it to report progress when native task tools are unavailable.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      tasks: { type: 'array', maxItems: LIMIT, items: { ...task, required: ['id', 'label'] } },
      task, clear: { type: 'boolean' },
    } },
  });
}
