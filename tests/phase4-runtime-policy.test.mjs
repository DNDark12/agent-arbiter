import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../extension/hooks/runtime-policy.js';

const roots = { configRoot: '/Users/operator/.claude', pluginRoot: '/opt/agent-arbiter', projectRoot: '/work/project', home: '/Users/operator' };
const paths = ['/Users/operator/.claude', '/opt/agent-arbiter', '/work/project/.claude', '/Users/operator/.claude.json'];

test('protected paths cover config, extension, project settings, and home settings', () => {
  assert.equal(typeof policy.protectedPaths, 'function');
  assert.deepEqual(policy.protectedPaths(roots), paths);
});

test('protected paths canonicalize separators, preserve spaces, and remove duplicates', () => {
  assert.deepEqual(policy.protectedPaths({ configRoot: '/work//project/.claude/', pluginRoot: '/opt/my court/', projectRoot: '/work/project/', home: '/Users/operator/' }),
    ['/work/project/.claude', '/opt/my court', '/Users/operator/.claude.json']);
  assert.deepEqual(policy.protectedPaths({ ...roots, home: undefined }), paths.slice(0, 3));
});

test('protected paths reject missing roots, traversal, controls, and unescapable rule metacharacters', () => {
  for (const value of [undefined, null, '', 'relative', '~/arbiter', '/a/../b', '/a/./b', '/a\u0000b', '/a\nb', '/a\u007fb', '/a\u2028b', '/a*b', '/a?b', '/a[b', '/a]b', '/a(b', '/a)b', '/a{b,c}', '/a\\b']) {
    for (const key of ['configRoot', 'pluginRoot', 'projectRoot']) assert.throws(() => policy.protectedPaths({ ...roots, [key]: value }), /path/i);
    if (value !== undefined) assert.throws(() => policy.protectedPaths({ ...roots, home: value }), /path/i);
  }
});

test('strict profile fences native file tools and every sandbox subprocess', () => {
  assert.equal(typeof policy.strictProfile, 'function');
  const profile = policy.strictProfile(paths, 'anchor-v1', '/keys/court.key');
  assert.deepEqual(profile, {
    permissions: { ask: ['*'], deny: ['Grep','Glob','ToolSearch','mcp__*',...paths.flatMap(path => [`Read(/${path})`, `Read(/${path}/**)`, `Edit(/${path})`, `Edit(/${path}/**)`])], disableBypassPermissionsMode: 'disable' },
    sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, failIfUnavailable: true, excludedCommands: [], filesystem: { denyRead: paths, denyWrite: paths } },
    env: { AGENT_ARBITER_ANCHOR: 'anchor-v1', AGENT_ARBITER_KEY_FILE: '/keys/court.key' },
  });
  assert.deepEqual(policy.strictProfile(paths).env, {});
  assert.deepEqual(policy.strictProfile(paths, 'anchor-v1').env, {});
  profile.sandbox.filesystem.denyRead.push('/other');
  assert.deepEqual(paths, ['/Users/operator/.claude', '/opt/agent-arbiter', '/work/project/.claude', '/Users/operator/.claude.json']);
  assert.deepEqual(policy.strictProfile(paths).sandbox.filesystem.denyRead, paths);
});

test('strict profile rejects empty and unsafe path lists and deduplicates canonical paths', () => {
  for (const invalid of [null, undefined, [], '/arbiter', ['/arbiter', '../escape'], ['/court(*)']]) assert.throws(() => policy.strictProfile(invalid), /path/i);
  assert.deepEqual(policy.strictProfile(['/arbiter/', '/arbiter']).sandbox.filesystem.denyWrite, ['/arbiter']);
});

test('inspection accepts the complete strict profile without requiring env secrets', () => {
  assert.equal(typeof policy.inspectProfile, 'function');
  assert.deepEqual(policy.inspectProfile(policy.strictProfile(paths), paths), { ready: true, issues: [] });
  const profile = policy.strictProfile(paths);
  profile.permissions.allow = ['*'];
  profile.permissions.deny.push('*');
  assert.deepEqual(policy.inspectProfile(profile, paths), { ready: true, issues: [] });
});

test('inspection refuses every omitted engine and sandbox protection', () => {
  const fields = [
    ['permissions', 'ask'], ['permissions', 'deny'], ['permissions', 'disableBypassPermissionsMode'],
    ['sandbox', 'enabled'], ['sandbox', 'autoAllowBashIfSandboxed'], ['sandbox', 'allowUnsandboxedCommands'],
    ['sandbox', 'failIfUnavailable'], ['sandbox', 'excludedCommands'],
    ['sandbox', 'filesystem', 'denyRead'], ['sandbox', 'filesystem', 'denyWrite'],
  ];
  for (const keys of fields) {
    const profile = policy.strictProfile(paths);
    const target = keys.slice(0, -1).reduce((value, key) => value[key], profile);
    delete target[keys.at(-1)];
    const result = policy.inspectProfile(profile, paths);
    assert.equal(result.ready, false, keys.join('.'));
    assert.ok(result.issues.some(issue => issue.includes(keys.join('.'))), keys.join('.'));
  }
});

test('inspection refuses relaxed flags, bypass modes, and disabled filesystem isolation', () => {
  for (const [keys, value] of [
    [['permissions', 'ask'], ['Bash']], [['permissions', 'disableBypassPermissionsMode'], 'enable'],
    [['permissions', 'defaultMode'], 'bypassPermissions'], [['permissions', 'defaultMode'], 'auto'],
    [['permissions', 'defaultMode'], 'acceptEdits'], [['permissions', 'defaultMode'], 'unknown'],
    [['sandbox', 'enabled'], false], [['sandbox', 'autoAllowBashIfSandboxed'], true],
    [['sandbox', 'allowUnsandboxedCommands'], true], [['sandbox', 'failIfUnavailable'], false],
    [['sandbox', 'excludedCommands'], ['docker *']], [['sandbox', 'filesystem', 'disabled'], true],
    [['sandbox', 'enableWeakerNestedSandbox'], true], [['sandbox', 'allowNestedUserNamespaces'], true],
  ]) {
    const profile = policy.strictProfile(paths);
    const target = keys.slice(0, -1).reduce((value, key) => value[key], profile);
    target[keys.at(-1)] = value;
    assert.equal(policy.inspectProfile(profile, paths).ready, false, keys.join('.') + '=' + JSON.stringify(value));
  }
});

test('inspection requires exact and descendant denies for every protected path and tool', () => {
  const original = policy.strictProfile(paths);
  for (let i = 0; i < original.permissions.deny.length; i++) {
    const profile = structuredClone(original);
    const [missing] = profile.permissions.deny.splice(i, 1);
    assert.equal(policy.inspectProfile(profile, paths).ready, false, missing);
  }
  for (const kind of ['denyRead', 'denyWrite']) {
    const profile = structuredClone(original);
    profile.sandbox.filesystem[kind].pop();
    assert.equal(policy.inspectProfile(profile, paths).ready, false, kind);
  }
});

test('inspection returns diagnostics rather than throwing on malformed or absent settings', () => {
  for (const settings of [undefined, null, {}, [], { permissions: true }, { sandbox: { filesystem: false } }]) {
    const result = policy.inspectProfile(settings, paths);
    assert.equal(result.ready, false);
    assert.ok(result.issues.length > 0);
  }
  for (const invalid of [undefined, null, [], ['/safe', '/escape/*']]) assert.equal(policy.inspectProfile(policy.strictProfile(paths), invalid).ready, false);
});
test('strict protected runtime disables host search tools whose path exclusions are best effort',()=>{
 const paths=policy.protectedPaths({configRoot:'/cfg',pluginRoot:'/plugin',projectRoot:'/work'}),profile=policy.strictProfile(paths);
 assert.ok(profile.permissions.deny.includes('Grep'));assert.ok(profile.permissions.deny.includes('Glob'));
 for(const tool of ['Grep','Glob']){const changed=structuredClone(profile);changed.permissions.deny=changed.permissions.deny.filter(rule=>rule!==tool);assert.equal(policy.inspectProfile(changed,paths).ready,false);}
});
test('strict profile prevents model-triggered lazy external tool discovery',()=>{
 const profile=policy.strictProfile(paths);assert.ok(profile.permissions.deny.includes('ToolSearch'));
 profile.permissions.deny=profile.permissions.deny.filter(rule=>rule!=='ToolSearch');assert.equal(policy.inspectProfile(profile,paths).ready,false);
});
