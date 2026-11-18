import test from 'node:test';
import assert from 'node:assert/strict';
import { updatePlugin } from '../extension/hooks/update.js';
import { handleCourt } from '../extension/hooks/controls.js';
import { setLanguage } from '../extension/hooks/i18n.js';

const CONFIG = '/home/me/.claude';
const ROOT = `${CONFIG}/plugins/cache/agent-arbiter/agent-arbiter/1.2.0`;
const INSTALLED = `${CONFIG}/plugins/installed_plugins.json`;

function host({ root = ROOT, scope = 'user', projectPath, exit = {}, next = '1.2.1' } = {}) {
  const entry = version => ({ scope, installPath: `${CONFIG}/plugins/cache/agent-arbiter/agent-arbiter/${version}`, version, ...(projectPath ? { projectPath } : {}) });
  let installed = { version: 2, plugins: { 'agent-arbiter@agent-arbiter': [entry('1.2.0')], 'other@elsewhere': [{ scope: 'user', installPath: '/x', version: '9' }] } };
  const runs = [];
  const $ = {
    plugin: { root, name: 'agent-arbiter' },
    env: { get: async key => ({ CLAUDE_CONFIG_DIR: CONFIG, CLAUDE_CODE_EXECPATH: '/app/claude' })[key] },
    fs: { read: async path => { if (path !== INSTALLED) throw new Error('missing'); return JSON.stringify(installed); } },
    process: { run: async (argv, init) => {
      runs.push({ argv, init });
      const step = argv.slice(1, 3).join(' ');
      if (exit[step]) return { exitCode: exit[step], stdout: '', stderr: 'network down' };
      if (step === 'plugin update') installed = { ...installed, plugins: { ...installed.plugins, 'agent-arbiter@agent-arbiter': [entry(next)] } };
      return { exitCode: 0, stdout: '', stderr: '' };
    } },
  };
  return { $, runs };
}

test('update refreshes the marketplace, then updates this install through the session CLI', async () => {
  setLanguage('en');
  const { $, runs } = host();
  assert.equal(await updatePlugin($), 'Agent Arbiter updated from 1.2.0 to 1.2.1. Restart Claude Code to load it.');
  assert.deepEqual(runs.map(run => run.argv), [
    ['/app/claude', 'plugin', 'marketplace', 'update', 'agent-arbiter'],
    ['/app/claude', 'plugin', 'update', 'agent-arbiter@agent-arbiter', '--scope', 'user'],
  ]);
  assert.ok(runs.every(run => run.init.timeoutMs === 120000 && run.init.cwd === undefined));
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

test('only a person can run update: a plugin or SDK origin is refused', async () => {
  setLanguage('en');
  const { $, runs } = host();
  const { text } = await handleCourt($, { args: 'update', origin: { kind: 'plugin', name: 'other' } });
  assert.match(text, /Human composer\/bridge approval required/);
  assert.equal(runs.length, 0);
});
