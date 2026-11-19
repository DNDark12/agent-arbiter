// Pure construction and inspection of a strict native-runtime settings fragment.
function absolutePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\u0000-\u001f\u007f-\u009f\u2028\u2029*?\[\](){}\\]/u.test(value)
      || value.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid protected path');
  return value.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

export function protectedPaths({ configRoot, pluginRoot, projectRoot, home, hostRoots = [] }) {
  const roots = [absolutePath(configRoot), absolutePath(pluginRoot), absolutePath(`${absolutePath(projectRoot)}/.claude`)];
  if (!Array.isArray(hostRoots)) throw new Error('Invalid host roots');
  roots.push(...hostRoots.map(absolutePath));
  if (home !== undefined) roots.push(absolutePath(`${absolutePath(home)}/.claude.json`));
  return [...new Set(roots)];
}

function canonicalPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('Protected paths required');
  return [...new Set(paths.map(absolutePath))];
}

function fileRules(paths) {
  return paths.flatMap(path => [`Read(/${path})`, `Read(/${path}/**)`, `Edit(/${path})`, `Edit(/${path}/**)`]);
}

export function strictProfile(paths, anchor = null, keyFile = null) {
  const protectedRoots = canonicalPaths(paths);
  return {
    permissions: { ask: ['*'], deny: ['Grep','Glob','ToolSearch','mcp__*',...fileRules(protectedRoots)], disableBypassPermissionsMode: 'disable' },
    sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
      failIfUnavailable: true, excludedCommands: [],
      filesystem: { denyRead: [...protectedRoots], denyWrite: [...protectedRoots] } },
    env: anchor && keyFile ? { AGENT_ARBITER_ANCHOR: anchor, AGENT_ARBITER_KEY_FILE: keyFile } : {},
  };
}

export function inspectProfile(settings, paths) {
  const issues = [];
  let protectedRoots;
  try { protectedRoots = canonicalPaths(paths); }
  catch { return { ready: false, issues: ['Invalid protected paths'] }; }
  const permissions = settings?.permissions;
  const sandbox = settings?.sandbox;
  const filesystem = sandbox?.filesystem;
  const check = (condition, field) => { if (!condition) issues.push(`${field} is not strict`); };
  const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
  check(strings(permissions?.ask) && permissions.ask.includes('*'), 'permissions.ask');
  check(strings(permissions?.deny) && fileRules(protectedRoots).every(rule => permissions.deny.includes(rule)), 'permissions.deny');
  check(strings(permissions?.deny) && ['Grep','Glob','ToolSearch','mcp__*'].every(tool=>permissions.deny.includes(tool)), 'permissions.deny.searchTools');
  check(permissions?.disableBypassPermissionsMode === 'disable', 'permissions.disableBypassPermissionsMode');
  check(permissions?.defaultMode === undefined || ['default', 'plan'].includes(permissions.defaultMode), 'permissions.defaultMode');
  check(sandbox?.enabled === true, 'sandbox.enabled');
  check(sandbox?.autoAllowBashIfSandboxed === false, 'sandbox.autoAllowBashIfSandboxed');
  check(sandbox?.allowUnsandboxedCommands === false, 'sandbox.allowUnsandboxedCommands');
  check(sandbox?.failIfUnavailable === true, 'sandbox.failIfUnavailable');
  check(Array.isArray(sandbox?.excludedCommands) && sandbox.excludedCommands.length === 0, 'sandbox.excludedCommands');
  for (const field of ['denyRead', 'denyWrite']) {
    check(strings(filesystem?.[field]) && protectedRoots.every(path => filesystem[field].includes(path)), `sandbox.filesystem.${field}`);
  }
  for (const field of ['enableWeakerNestedSandbox', 'allowNestedUserNamespaces']) {
    check(sandbox?.[field] === undefined || sandbox[field] === false, `sandbox.${field}`);
  }
  check(filesystem?.disabled === undefined || filesystem.disabled === false, 'sandbox.filesystem.disabled');
  return { ready: issues.length === 0, issues };
}
