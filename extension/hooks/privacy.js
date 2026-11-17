import { digest } from './ledger.js';

// Metadata only. Prompts, commands, source, results and transcripts are never logged.
export function redact(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .slice(0, 512);
}

function normalize(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return '/' + parts.join('/');
}

export async function fileMetadata(root, path, $, sessionRoot = root) {
  const base = normalize(root);
  let absolute = normalize(path.startsWith('/') ? path : `${sessionRoot}/${path}`);
  let resolution = 'lexical';
  {
    try {
      const info = await $.fs.stat(absolute, { resolve: true });
      if (info.realPath) { absolute = normalize(info.realPath); resolution = 'realpath'; }
    } catch {
      // New Write files do not exist yet; resolve their parent directory.
      const slash = absolute.lastIndexOf('/');
      try {
        const parent = await $.fs.stat(absolute.slice(0, slash) || '/', { resolve: true });
        if (parent.realPath) { absolute = normalize(parent.realPath + '/' + absolute.slice(slash + 1)); resolution = 'parent-realpath'; }
      } catch { /* Keep explicit lexical fallback. */ }
    }
  }
  const inside = absolute === base || absolute.startsWith(base === '/' ? '/' : base + '/');
  return {
    scope: inside ? 'project' : 'external',
    path: inside ? redact(absolute.slice(base === '/' ? 1 : base.length + 1) || '.') : `sha256:${await digest(absolute)}`,
    // Lexical path scope is not an authorization check (symlinks can escape).
    pathResolution: resolution,
  };
}
