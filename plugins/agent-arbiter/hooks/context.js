import { digest } from './ledger.js';
import { loadAuthentication } from './runtime.js';
import { loadProjectSettings } from './project-rules.js';

function pluginDirectory($) {
  try { return $.plugin.root; } catch { return null; }
}

export async function configRoot($) {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR');
  const path = configured || `${await $.env.get('HOME') || ''}/.claude`;
  if (!path.startsWith('/') || path.includes('\0') || path === '/.claude') throw new Error('Absolute Claude config directory unavailable');
  return path.replace(/\/+$/, '');
}

// Arbiter relies on POSIX paths and on /bin/ln, /bin/mv and /bin/rm for atomic
// publication: macOS and Linux. Elsewhere it stays inactive instead of half working.
export async function platformSupported($) {
  try {
    if (/windows/i.test(String(await $.env.get('OS') ?? ''))) return false;
    await configRoot($);
    return true;
  } catch { return false; }
}

export async function storageRoot($) {
  return `${await configRoot($)}/plugins/data/agent-arbiter/v1`;
}

export async function realPath($, path) {
  try { return (await $.fs.stat(path, { resolve: true })).realPath || path; }
  catch { return path; }
}

export async function observationContext($, options = {}) {
  const sessionRoot = await $.session.root();
  const root = await realPath($, sessionRoot);
  let projectRoot = root;
  try { const repo = await $.session.repo(); if (repo?.root) projectRoot = await realPath($, repo.root); }
  catch { /* Repo unavailable: explicitly fall back to directory scope. */ }
  const configuredRoot=await configRoot($);
  const ctx={root,sessionRoot,projectRoot,sessionId:await $.session.id(),configRoot:configuredRoot,home:await $.env.get('HOME') || null,pluginRoot:pluginDirectory($),
    projectId:await digest(projectRoot),checkoutId:await digest(root),archiveRoot:await storageRoot($)};
  let preferences;
  try{preferences=await loadProjectSettings($,ctx);}
  catch(error){if(!options.recoverPreferences)throw error;preferences={hardened:false,mode:'observe'};}
  const auth=preferences.hardened && preferences.mode==='enforce' || options.authentication ? await loadAuthentication($,ctx) : {signer:null,anchor:null,configured:false,authError:false,authReason:null};
  return {...ctx,preferences,signer:auth.signer,anchor:auth.anchor,authConfigured:auth.configured,authError:auth.authError,authReason:auth.authReason,
    dataRoot:auth.anchor?`${configuredRoot}/plugins/data/agent-arbiter/v2/${auth.anchor}`:ctx.archiveRoot};
}
