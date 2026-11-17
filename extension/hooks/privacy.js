import { digest } from './ledger.js';

// Masking is best effort: it catches common secret shapes, not every secret.
function maskLine(text) {
  return text
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, '$1 [REDACTED]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|secret|password|passwd|pwd|token|auth(?:orization)?|credentials?)["']?\s*[=:]\s*["']?)[^\s,;"'&]+/gi, '$1[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|sk-[A-Za-z0-9_-]{12,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
}

// Metadata only. Prompts, commands, source, results and transcripts are never logged.
export function redact(value) {
  return maskLine(String(value ?? '').replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')).slice(0, 512);
}

// A whole text, such as a file sent to the judge: key blocks first, then line by line.
export function maskText(value) {
  return String(value ?? '').replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .split('\n').map(line => maskLine(line.length > 2000 ? `${line.slice(0, 2000)}…` : line)).join('\n');
}

// Files the judge never reads: credentials, keys, keystores, infrastructure state.
export const SECRET_FILE = /(^|\/)(\.env[^/]*|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.htpasswd|\.git-credentials|\.dockercfg|auth\.json|kubeconfig[^/]*|[^/]*\.(pem|key|p8|p12|pfx|jks|keystore|kdbx|asc|gpg|ovpn|tfvars|tfstate)|id_[a-z0-9]+|[^/]*credentials[^/]*|[^/]*secrets?[^/]*|service[-_]?account[^/]*\.json)$|(^|\/)\.(ssh|aws|gnupg|docker)\//i;

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
