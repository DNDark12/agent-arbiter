// This is a deliberately incomplete semantic classifier, never a shell sandbox.
// Context authority is supplied by the caller, never read from tool arguments.
const unknown = reason => ({ kind: 'unknown', reason });
const text = value => typeof value === 'string' && value.length > 0 && value.length < 512 &&
  value === value.trim() && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029*]/u.test(value) &&
  !value.includes('[REDACTED]');
const environment = value => text(value) && !['unknown', 'unspecified'].includes(value.toLowerCase());
const pathParts = value => text(value) && !value.includes('\\') &&
  value.split('/').every(part => part && part !== '.' && part !== '..');
const rootPath = value => value === '/' || (typeof value === 'string' && value.startsWith('/') && pathParts(value.slice(1)));
const branch = value => text(value) && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
  !['HEAD', 'unknown', 'unspecified'].includes(value) && !value.includes('..') && !value.includes('//') &&
  value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));

export function classifyTool(event, context = {}) {
  if (!event || typeof event !== 'object') return unknown('missing-tool');
  if (['Read', 'Glob', 'Grep'].includes(event.tool)) return { kind: 'read', reason: 'direct-read-tool' };
  if (!context || !environment(context.environment)) return unknown('trusted-environment-unavailable');
  const root = context.projectRoot ?? context.root;
  if (!rootPath(root)) return unknown('trusted-project-root-unavailable');
  if ((event.agentId != null && !text(event.agentId)) ||
      (event.tool_use_id != null && !text(event.tool_use_id))) return unknown('invalid-tool-identity');
  const classified = (action, target) => ({ kind: 'action', request: { action, target,
    environment: context.environment, requestedApproval: false, agentId: event.agentId ?? null,
    toolCallId: event.tool_use_id ?? null }, reason: 'exact-direct-action' });

  if (['Write', 'Edit', 'NotebookEdit'].includes(event.tool)) {
    const file = context.file;
    const inputPath = event.tool === 'NotebookEdit' ? event.notebook_path : event.file_path;
    if (file?.scope !== 'project' || !['realpath', 'parent-realpath'].includes(file.pathResolution) ||
        !pathParts(file.path) || file.path.startsWith('sha256:')) return unknown('unproven-project-file');
    const base = context.sessionRoot ?? root;
    if (!rootPath(base) || typeof inputPath !== 'string') return unknown('unproven-input-file');
    const absolute = inputPath.startsWith('/') ? inputPath : `${base === '/' ? '' : base}/${inputPath}`;
    if (!rootPath(absolute) || absolute !== `${root === '/' ? '' : root}/${file.path}`) {
      return unknown('file-metadata-mismatch');
    }
    return classified('source.write', file.path);
  }

  if (event.tool !== 'Bash' || typeof event.command !== 'string') return unknown('unsupported-tool');
  // Single spaces, literal unquoted tokens, and no shell operators/expansion.
  // Unknown shell commands remain for the native permission engine to decide.
  if (!/^[A-Za-z0-9_./-]+(?: [A-Za-z0-9_./-]+)*$/.test(event.command)) return unknown('unsupported-shell-syntax');
  const words = event.command.split(' ');
  if (words[0] !== 'git') return unknown('unsupported-command');
  const [,, ...args] = words;
  if (words[1] === 'push' && args.length === 2 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args[0]) && branch(args[1])) {
    return classified('git.push', args[1]);
  }
  if (!branch(context.branch)) return unknown('trusted-branch-unavailable');
  if (words[1] === 'commit' && (args.length === 0 ||
      (args.length === 2 && ['-m', '--message'].includes(args[0]) && !args[1].startsWith('-')))) {
    return classified('git.commit', context.branch);
  }
  if (words[1] === 'reset' && ['--hard', '--mixed', '--soft'].includes(args[0]) &&
      (args.length === 1 || (args.length === 2 && args[1] === 'HEAD'))) {
    return classified('git.reset', context.branch);
  }
  return unknown('unsupported-git-command');
}

export function gateFallback(event, next, armed = true) {
  if (next.called || !armed || classifyTool(event, {}).kind === 'read') return next(event);
  return { deny: 'Agent Arbiter gate unavailable; permission required.' };
}
