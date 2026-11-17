import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as action from '../extension/hooks/action.js';

const ctx = { root: '/project', environment: 'local', branch: 'feature/gate' };
const event = (tool, fields = {}) => ({ tool, agentId: 'agent-one', tool_use_id: 'tool-one', ...fields });
const bash = command => event('Bash', { command });
const fileContext = overrides => ({ ...ctx, file: { scope: 'project', path: 'src/main.js',
  pathResolution: 'realpath', ...overrides } });

test('exposes a pure classifier and fallback', () => {
  assert.equal(typeof action.classifyTool, 'function');
  assert.equal(typeof action.gateFallback, 'function');
});

test('only explicit read tools are classified as reads', () => {
  for (const tool of ['Read', 'Glob', 'Grep']) {
    assert.equal(action.classifyTool(event(tool), {}).kind, 'read');
  }
  for (const tool of ['ToolSearch', 'AskUserQuestion', 'TaskOutput', 'mcp__read', 'read', '', null]) {
    const result = action.classifyTool(event(tool), ctx);
    assert.equal(result.kind, 'unknown');
    assert.equal(result.request, undefined);
  }
  assert.equal(action.classifyTool(null).kind, 'unknown');
});

test('direct file writes require exact resolved in-project metadata', () => {
  for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
    const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
    for (const path of ['src/main.js', '/project/src/main.js']) {
      for (const pathResolution of ['realpath', 'parent-realpath']) {
        const result = action.classifyTool(event(tool, { [field]: path }), fileContext({ pathResolution }));
        assert.equal(result.kind, 'action');
        assert.deepEqual(result.request, { action: 'source.write', target: 'src/main.js', environment: 'local',
          requestedApproval: false, agentId: 'agent-one', toolCallId: 'tool-one' });
        assert.equal(typeof result.reason, 'string');
      }
    }
  }
});

test('unresolved, external, mismatched or redacted file metadata remains unknown', () => {
  for (const metadata of [{ scope: 'external' }, { pathResolution: 'lexical' }, { pathResolution: null },
    { path: 'src/other.js' }, { path: '../main.js' }, { path: '/project/src/main.js' },
    { path: 'src/[REDACTED].js' }, { path: 'sha256:abc' }, { path: 'src/*.js' }, { path: '.' }]) {
    const result = action.classifyTool(event('Write', { file_path: 'src/main.js' }), fileContext(metadata));
    assert.equal(result.kind, 'unknown');
    assert.equal(result.request, undefined);
  }
  for (const path of ['/elsewhere/src/main.js', '../src/main.js', 'src/../main.js', 'src/main.js\n']) {
    assert.equal(action.classifyTool(event('Write', { file_path: path }), fileContext()).kind, 'unknown');
  }
  assert.equal(action.classifyTool(event('Write', { file_path: 'src/main.js' }), ctx).kind, 'unknown');
});

test('environment and project authority come only from trusted context', () => {
  for (const environment of [undefined, null, '', 'unknown', 'UNKNOWN', 'unspecified', '*', 'local*', ' local', 'local\n']) {
    const result = action.classifyTool(event('Write', { file_path: 'src/main.js', environment: 'production' }),
      { ...fileContext(), environment });
    assert.equal(result.kind, 'unknown');
  }
  for (const root of [undefined, null, '', 'project', '/project/../other']) {
    assert.equal(action.classifyTool(bash('git commit'), { ...ctx, root }).kind, 'unknown');
  }
  assert.equal(action.classifyTool(bash('git commit'), { ...ctx, projectRoot: '/project', root: undefined }).kind, 'action');
  assert.equal(action.classifyTool(event('Write', { file_path: 'src/main.js', environment: 'production' }),
    fileContext()).request.environment, 'local');
});

test('plain git commit and reset use the trusted current branch', () => {
  for (const command of ['git commit', 'git commit -m message', 'git commit --message message']) {
    assert.equal(action.classifyTool(bash(command), ctx).request?.action, 'git.commit');
    assert.equal(action.classifyTool(bash(command), ctx).request?.target, 'feature/gate');
  }
  for (const command of ['git reset --hard', 'git reset --mixed HEAD', 'git reset --soft HEAD']) {
    assert.equal(action.classifyTool(bash(command), ctx).request?.action, 'git.reset');
    assert.equal(action.classifyTool(bash(command), ctx).request?.target, 'feature/gate');
  }
  for (const branch of [undefined, null, '', 'unknown', '*', '-branch', 'main:other', 'main..other', 'main.lock']) {
    assert.equal(action.classifyTool(bash('git commit'), { ...ctx, branch }).kind, 'unknown');
  }
});

test('plain push requires one unambiguous remote name and explicit branch', () => {
  const result = action.classifyTool(bash('git push origin release/next'), ctx);
  assert.deepEqual(result.request, { action: 'git.push', target: 'release/next', environment: 'local',
    requestedApproval: false, agentId: 'agent-one', toolCallId: 'tool-one' });
  for (const command of ['git push', 'git push origin', 'git push origin HEAD', 'git push origin main:other',
    'git push origin :main', 'git push origin --all', 'git push --force origin main',
    'git push https://example.com/repo main', 'git push -option main', 'git push origin main other']) {
    assert.equal(action.classifyTool(bash(command), ctx).kind, 'unknown', command);
  }
});

test('shell syntax, scripts, configuration and unknown flags never receive an action request', () => {
  for (const command of ['git commit && rm file', 'git commit; rm file', 'git commit\nrm file',
    'git commit $(touch file)', 'git commit `touch file`', 'git commit > file', 'git commit | cat',
    'git commit # comment', 'git commit -m "message"', "sh -c 'git commit'", 'env git commit',
    'X=1 git commit', 'git -C /elsewhere commit', 'git -c alias.push=evil push origin main',
    'git commit --config-env=x=y', 'git commit --message --amend', 'git commit --allow-empty',
    'git reset --hard other', 'git reset --hard HEAD -- file', 'rm -- file', 'npm install pkg',
    'php artisan migrate', 'git status', 'cat file', 'git\tcommit', ' git commit', 'git commit ']) {
    const result = action.classifyTool(bash(command), ctx);
    assert.equal(result.kind, 'unknown', command);
    assert.equal(result.request, undefined, command);
  }
});

test('fallback replays an already called next without creating a denial', async () => {
  const value = event('Write');
  let count = 0;
  const next = async e => { assert.equal(e, value); count++; return { result: 'original' }; };
  next.called = true;
  assert.deepEqual(await action.gateFallback(value, next), { result: 'original' });
  assert.equal(count, 1);
});

test('fallback permits reads or an unarmed gate through next and defaults to denying unknown', async () => {
  let count = 0;
  const next = async e => { count++; return { result: e.tool }; };
  for (const tool of ['Read', 'Glob', 'Grep']) {
    assert.deepEqual(await action.gateFallback(event(tool), next), { result: tool });
  }
  assert.deepEqual(await action.gateFallback(event('Write'), next, false), { result: 'Write' });
  assert.equal(count, 4);
  for (const tool of ['Bash', 'Write', 'ToolSearch']) {
    assert.deepEqual(await action.gateFallback(event(tool), next),
      { deny: 'Agent Arbiter gate unavailable; permission required.' });
  }
  assert.equal(count, 4);
});
