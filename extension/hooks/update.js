// /arbiter update: refresh the marketplace this copy was installed from, then
// update it with the Claude Code CLI. The new version loads after a restart.
import { t } from './i18n.js';
import { configRoot } from './context.js';

const TIMEOUT_MS = 120000;
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

const tail = result => String(result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 400);

export async function updatePlugin($) {
  const install = await currentInstall($);
  if (!install) return t('update.notInstalled');
  const marketplace = install.id.slice(install.id.indexOf('@') + 1);
  const executable = await $.env.get('CLAUDE_CODE_EXECPATH') || 'claude';
  // A project or local install is updated from its own project folder.
  const init = { timeoutMs: TIMEOUT_MS, ...(install.scope !== 'user' && install.projectPath ? { cwd: install.projectPath } : {}) };
  const steps = [
    ['marketplace update', ['plugin', 'marketplace', 'update', marketplace]],
    ['plugin update', ['plugin', 'update', install.id, ...(install.scope ? ['--scope', install.scope] : [])]],
  ];
  for (const [step, args] of steps) {
    let result;
    try { result = await $.process.run([executable, ...args], init); }
    catch (error) { return t('update.failed', { step, code: '-', detail: String(error?.message || error).slice(0, 400) }); }
    if (result.exitCode !== 0) return t('update.failed', { step, code: result.exitCode, detail: tail(result) });
  }
  let after = null;
  try { after = (await installations($)).find(entry => sameInstall(entry, install)) ?? null; } catch { /* Report what is known. */ }
  const version = after?.version ?? install.version;
  return version === install.version ? t('update.current', { version, marketplace }) : t('update.done', { from: install.version, to: version });
}
