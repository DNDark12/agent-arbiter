import { canonical, digest } from './ledger.js';
import { configRoot } from './context.js';
import { redact } from './privacy.js';

function declaredName(text) {
  const front = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!front) return null;
  const matches = [...front[1].matchAll(/^name:\s*(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))\s*(?:#.*)?$/gm)];
  return matches.length === 1 ? matches[0][1] || matches[0][2] || matches[0][3] : null;
}

export async function bindCitizen(identity, projectId, resolvedModel) {
  const model = resolvedModelId(resolvedModel);
  const binding = identity.definitionHash || (identity.source === 'built-in' ? identity.engineVersion : null);
  return { ...identity, resolvedModel: model ? redact(model) : null,
    id: binding && model ? await digest(canonical([projectId, identity.name, identity.source,
      identity.provider, identity.identityStrength, binding, model])) : null };
}

export async function citizen($, root, engineVersion, input, offer, resolvedModel) {
  const name = input.subagentType || 'unknown';
  const provider = input.provider || null;
  const source = offer?.source || 'unknown';
  let definitionHash = null;
  if (/^[A-Za-z0-9_-]+$/.test(name) && ['projectSettings', 'userSettings'].includes(source)) {
    try {
      const directory = source === 'projectSettings' ? `${root}/.claude/agents` : `${await configRoot($)}/agents`;
      const candidates = [];
      // The declared name is authority; filenames can differ. Ambiguous matches stay unknown.
      for (const file of await $.fs.list(directory)) {
        if (file.kind !== 'file' || file.isLink || !/^[^/]+\.md$/.test(file.name)) continue;
        const text = await $.fs.read(`${directory}/${file.name}`);
        if (declaredName(text) === name) candidates.push(text);
      }
      if (candidates.length === 1) definitionHash = await digest(candidates[0]);
    } catch { /* Missing or unreadable definition must stay unknown. */ }
  }
  const strength = definitionHash ? 'definition-file' : source === 'built-in' && engineVersion ? 'engine-version' : 'unknown';
  const identity = { id: null, name: redact(name), source: redact(source),
    provider: provider ? { plugin: redact(provider.plugin), tier: redact(provider.tier) } : null,
    definitionHash, definitionStatus: definitionHash ? 'file-observed' : 'unavailable',
    resolvedModel: null, engineVersion: redact(engineVersion), role: 'unclassified', identityStrength: strength,
    definitionBinding: definitionHash ? 'filesystem-at-spawn' : strength === 'engine-version' ? 'engine-version-only' : 'unknown',
    unavailableReason: source === 'plugin' && !definitionHash ? 'loaded-plugin-version-unavailable' : null };
  return bindCitizen(identity, await digest(root), resolvedModel);
}

export function resolvedModelId(value){
  return typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,255}$/.test(value) && !/^(?:unknown(?:[-_:].*)?|unspecified|haiku|sonnet|opus|fable|inherit|default|auto|latest)$/i.test(value)?value:null;
}
