// /arbiter update: refresh the marketplace this copy was installed from, then
// update it with the Claude Code CLI. The new version loads after a restart.
import { t } from './i18n.js';
import { configRoot } from './context.js';

const TIMEOUT_MS = 120000;
const OFFICIAL_PLUGIN = 'agent-arbiter@agent-arbiter';
const MANIFEST = 'https://raw.githubusercontent.com/DNDark12/agent-arbiter/main/plugins/agent-arbiter/.claude-plugin/plugin.json';
const versionParts = value => typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value) ? value.split('.').map(Number) : null;
const trim = path => typeof path === 'string' ? path.replace(/\/+$/, '') : '';

async function installations($) {
  const data = JSON.parse(await $.fs.read(`${await configRoot($)}/plugins/installed_plugins.json`));
  const plugins = data?.plugins && typeof data.plugins === 'object' ? data.plugins : {};
  return Object.entries(plugins).flatMap(([id, list]) => Array.isArray(list) ? list.map(entry => ({ ...entry, id })) : []);
}

const sameInstall = (left, right) => left.id === right.id && left.scope === right.scope &&
  (left.scope === 'user' || left.projectPath === right.projectPath);

// The installation whose files are running now: a copy loaded from a source
// folder has none, and is updated from that source instead.
export async function currentInstall($) {
  const root = trim($.plugin.root);
  try {
    return (await installations($)).find(entry => trim(entry.installPath) === root && /^[^@\s]+@[^@\s]+$/.test(entry.id)) ?? null;
  } catch { return null; }
}

export async function loadedVersion($) {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`));
    if (manifest.name === 'agent-arbiter' && versionParts(manifest.version)) return manifest.version;
  } catch { /* Fall back to the installation registry. */ }
  return (await currentInstall($))?.version ?? null;
}

// A read-only check. Use a fixed public URL and never send credentials or session data.
export async function updateAvailability($) {
  try {
    if (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) return { status: 'disabled' };
    const install = await currentInstall($);
    const installed = versionParts(install?.version);
    if (install?.id !== OFFICIAL_PLUGIN || !installed) return { status: 'unsupported' };
    const response = await $.http.fetch(MANIFEST);
    if (!response.ok || typeof response.text !== 'string' || response.text.length > 20000) return { status: 'failed' };
    const manifest = JSON.parse(response.text), remote = versionParts(manifest.version);
    if (manifest.name !== 'agent-arbiter' || !remote) return { status: 'failed' };
    const different = remote.findIndex((part, index) => part !== installed[index]);
    return { status: different >= 0 && remote[different] > installed[different] ? 'available' : 'current', version: manifest.version };
  } catch { return { status: 'failed' }; }
}

// Where the Claude Code CLI may be, best first. The desktop app runs its own
// copy that is not on PATH and sets CLAUDE_CODE_EXECPATH only for its children,
// so the engine's own executable is asked for as well.
export async function executables($) {
  const found = [];
  const add = path => { if (typeof path === 'string' && path && !found.includes(path)) found.push(path); };
  add(await $.env.get('CLAUDE_CODE_EXECPATH'));
  add(await engineExecutable($));
  add('claude');
  return found;
}

// The engine's own executable: the parent of a command it starts. Only the
// shell's own $PPID and absolute tools are used, so nothing on PATH runs, and
// the answer must be a real file named claude.
async function engineExecutable($) {
  try {
    const shell = await $.process.run(['/bin/sh', '-c', 'echo "$PPID"'], { timeoutMs: 5000 });
    const pid = String(shell.stdout ?? '').trim();
    if (shell.exitCode !== 0 || !/^[1-9][0-9]*$/.test(pid)) return null;
    let path = null;
    try { path = (await $.fs.stat(`/proc/${pid}/exe`, { resolve: true })).realPath ?? null; } catch { /* Not Linux. */ }
    if (!path) {
      const ps = await $.process.run(['/bin/ps', '-o', 'comm=', '-p', pid], { timeoutMs: 5000 });
      path = ps.exitCode === 0 ? String(ps.stdout ?? '').trim() : null;
    }
    if (!path?.startsWith('/') || path.split('/').at(-1) !== 'claude') return null;
    const file = await $.fs.stat(path, { resolve: true });
    return file.kind === 'file' ? file.realPath || path : null;
  } catch { return null; }
}

const tail = result => String(result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 400);

export async function updatePlugin($) {
  const install = await currentInstall($);
  if (!install) return t('update.notInstalled');
  const marketplace = install.id.slice(install.id.indexOf('@') + 1);
  // A project or local install is updated from its own project folder.
  const init = { timeoutMs: TIMEOUT_MS, ...(install.scope !== 'user' && install.projectPath ? { cwd: install.projectPath } : {}) };
  const steps = [
    ['marketplace update', ['plugin', 'marketplace', 'update', marketplace]],
    ['plugin update', ['plugin', 'update', install.id, ...(install.scope ? ['--scope', install.scope] : [])]],
  ];
  let candidates = await executables($), failure = '';
  for (const [step, args] of steps) {
    let result = null;
    // The first step keeps the first executable that starts; the second reuses it.
    while (!result && candidates.length) {
      try { result = await $.process.run([candidates[0], ...args], init); }
      catch (error) { failure = String(error?.message || error).slice(0, 400); candidates = candidates.slice(1); }
    }
    if (!result) return t(step === steps[0][0] ? 'update.noCli' : 'update.failed', { step, code: '-', detail: failure });
    candidates = candidates.slice(0, 1);
    if (result.exitCode !== 0) return t('update.failed', { step, code: result.exitCode, detail: tail(result) });
  }
  let after = null;
  try { after = (await installations($)).find(entry => sameInstall(entry, install)) ?? null; } catch { /* Report what is known. */ }
  const version = after?.version ?? install.version;
  return version === install.version ? t('update.current', { version, marketplace }) : t('update.done', { from: install.version, to: version });
}
