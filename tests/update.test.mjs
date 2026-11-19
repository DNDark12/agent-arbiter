import test from 'node:test';
import assert from 'node:assert/strict';
import { updatePlugin } from '../plugins/agent-arbiter/hooks/update.js';
import { handleCourt } from '../plugins/agent-arbiter/hooks/controls.js';
import { setLanguage } from '../plugins/agent-arbiter/hooks/i18n.js';

const CONFIG = '/home/me/.claude';
const ROOT = `${CONFIG}/plugins/cache/agent-arbiter/agent-arbiter/1.2.0`;
const INSTALLED = `${CONFIG}/plugins/installed_plugins.json`;
const DESKTOP = '/Apps/Claude/claude-code/2.1.326/claude.app/Contents/MacOS/claude';

// execPath: CLAUDE_CODE_EXECPATH, unset in the engine's own environment on the
// desktop app. parent: what the engine's executable reads as. onPath: whether
// a bare `claude` starts.
function host({ root = ROOT, scope = 'user', projectPath, exit = {}, next = '1.2.1',
  execPath, parent = DESKTOP, onPath = false } = {}) {
  const entry = version => ({ scope, installPath: `${CONFIG}/plugins/cache/agent-arbiter/agent-arbiter/${version}`, version, ...(projectPath ? { projectPath } : {}) });
  let installed = { version: 2, plugins: { 'agent-arbiter@agent-arbiter': [entry('1.2.0')], 'other@elsewhere': [{ scope: 'user', installPath: '/x', version: '9' }] } };
  const runs = [];
  const $ = {
    plugin: { root, name: 'agent-arbiter' },
    env: { get: async key => ({ CLAUDE_CONFIG_DIR: CONFIG, CLAUDE_CODE_EXECPATH: execPath })[key] },
    fs: { read: async path => { if (path !== INSTALLED) throw new Error('missing'); return JSON.stringify(installed); },
      stat: async path => { if (path !== parent) throw new Error('ENOENT'); return { kind: 'file', realPath: parent }; } },
    process: { run: async (argv, init) => {
      if (argv[0] === '/bin/sh') return { exitCode: 0, stdout: '4242\n', stderr: '' };
      if (argv[0] === '/bin/ps') return { exitCode: 0, stdout: argv.at(-1) === '4242' ? `${parent}\n` : '', stderr: '' };
      if (argv[0] === 'claude' && !onPath) throw new Error('ENOENT: Executable not found in $PATH: "claude"');
      runs.push({ argv, init });
      const step = argv.slice(1, 3).join(' ');
      if (exit[step]) return { exitCode: exit[step], stdout: '', stderr: 'network down' };
      if (step === 'plugin update') installed = { ...installed, plugins: { ...installed.plugins, 'agent-arbiter@agent-arbiter': [entry(next)] } };
      return { exitCode: 0, stdout: '', stderr: '' };
    } },
  };
  return { $, runs };
}

test('on the desktop app, update runs the engine\'s own CLI: no claude on PATH, no CLAUDE_CODE_EXECPATH', async () => {
  setLanguage('en');
  const { $, runs } = host();
  assert.equal(await updatePlugin($), 'Agent Arbiter updated from 1.2.0 to 1.2.1. Restart Claude Code to load it.');
  assert.deepEqual(runs.map(run => run.argv), [
    [DESKTOP, 'plugin', 'marketplace', 'update', 'agent-arbiter'],
    [DESKTOP, 'plugin', 'update', 'agent-arbiter@agent-arbiter', '--scope', 'user'],
  ]);
  assert.ok(runs.every(run => run.init.timeoutMs === 120000 && run.init.cwd === undefined));
});

test('CLAUDE_CODE_EXECPATH comes first when the engine has it', async () => {
  const { $, runs } = host({ execPath: '/opt/claude' });
  await updatePlugin($);
  assert.ok(runs.every(run => run.argv[0] === '/opt/claude'));
});

test('a CLI run by node is not taken for the engine: claude on PATH is used', async () => {
  const { $, runs } = host({ parent: '/usr/local/bin/node', onPath: true });
  await updatePlugin($);
  assert.ok(runs.length === 2 && runs.every(run => run.argv[0] === 'claude'));
});

test('with no CLI to start, update says so instead of a raw error', async () => {
  setLanguage('en');
  const { $, runs } = host({ parent: '/usr/local/bin/node' });
  assert.match(await updatePlugin($), /^Agent Arbiter could not find the Claude Code CLI\. .*ENOENT/);
  assert.equal(runs.length, 0);
});

test('update says when the newest version is already installed', async () => {
  setLanguage('en');
  const { $ } = host({ next: '1.2.0' });
  assert.equal(await updatePlugin($), 'Agent Arbiter 1.2.0 is already the newest version in the agent-arbiter marketplace.');
});

test('a local install is updated from its project folder', async () => {
  const { $, runs } = host({ scope: 'local', projectPath: '/work/app' });
  await updatePlugin($);
  assert.deepEqual(runs[1].argv.slice(-2), ['--scope', 'local']);
  assert.ok(runs.every(run => run.init.cwd === '/work/app'));
});

test('a failed marketplace refresh stops before the plugin is touched', async () => {
  setLanguage('en');
  const { $, runs } = host({ exit: { 'plugin marketplace': 1 } });
  assert.equal(await updatePlugin($), 'Agent Arbiter update stopped at marketplace update (exit 1): network down');
  assert.equal(runs.length, 1);
});

test('a copy loaded from a source folder is not updated', async () => {
  setLanguage('en');
  const { $, runs } = host({ root: '/src/agent-arbiter/extension' });
  assert.match(await updatePlugin($), /not installed from a marketplace/);
  assert.equal(runs.length, 0);
});

test('opt-in update check respects traffic restrictions and only reads the official manifest', async () => {
  const { updateAvailability } = await import('../plugins/agent-arbiter/hooks/update.js');
  const { $, runs } = host();
  let reads = 0, restricted = '1';
  const env = $.env.get;
  $.env.get = async key => key === 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' ? restricted : env(key);
  $.http = { fetch: async url => {
    reads++;
    assert.equal(url, 'https://raw.githubusercontent.com/DNDark12/agent-arbiter/main/plugins/agent-arbiter/.claude-plugin/plugin.json');
    return { ok:true, text:'{"name":"agent-arbiter","version":"1.10.0"}' };
  } };
  assert.equal((await updateAvailability($)).status, 'disabled');
  assert.equal(reads, 0);
  restricted = '';
  assert.deepEqual(await updateAvailability($), { status:'available', version:'1.10.0' });
  assert.equal(reads, 1);
  assert.equal(runs.length, 0);
});

test('only a person can run update: a plugin or SDK origin is refused', async () => {
  setLanguage('en');
  const { $, runs } = host();
  const { text } = await handleCourt($, { args: 'update', origin: { kind: 'plugin', name: 'other' } });
  assert.match(text, /Human composer\/bridge approval required/);
  assert.equal(runs.length, 0);
});

test('the engine is found with absolute tools only, and must be a file named claude', async () => {
  const seen = [];
  const { $ } = host({ parent: '/Apps/claude-wrapper/claude' });
  const run = $.process.run;
  $.process.run = async (argv, init) => { seen.push(argv[0]); return run(argv, init); };
  $.fs.stat = async () => { throw new Error('ENOENT'); };
  const { executables } = await import('../plugins/agent-arbiter/hooks/update.js');
  assert.deepEqual(await executables($), ['claude']);
  assert.ok(seen.every(path => path.startsWith('/')));
});
