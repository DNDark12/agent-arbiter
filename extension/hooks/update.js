// /arbiter update: refresh the marketplace this copy was installed from, then
// update it with the Claude Code CLI. The new version loads after a restart.
import { t } from './i18n.js';
import { configRoot } from './context.js';

const TIMEOUT_MS = 120000;
// The parent of a command the engine starts is the engine itself.
const PARENT = 'readlink "/proc/$PPID/exe" 2>/dev/null || ps -o comm= -p "$PPID"';
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

// Where the Claude Code CLI may be, best first. The desktop app runs its own
// copy that is not on PATH and sets CLAUDE_CODE_EXECPATH only for its children,
// so the engine's own executable is asked for as well.
export async function executables($) {
  const found = [];
  const add = path => { if (typeof path === 'string' && path && !found.includes(path)) found.push(path); };
  add(await $.env.get('CLAUDE_CODE_EXECPATH'));
  try {
    const parent = await $.process.run(['/bin/sh', '-c', PARENT], { timeoutMs: 5000 });
    const path = parent.exitCode === 0 ? String(parent.stdout ?? '').trim() : '';
    if (path.startsWith('/') && path.split('/').at(-1) === 'claude') add(path);
  } catch { /* PATH remains. */ }
  add('claude');
  return found;
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
