// Runtime-neutral ESM: Claude function hooks provide the filesystem and process API.
export function canonical(value) {
  return encodeJSON(value, new Set());
}

function encodeJSON(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError('Value is not JSON');
  if (ancestors.has(value)) throw new TypeError('JSON cannot contain cyclic values');
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) throw new TypeError('Expected a JSON object');
  ancestors.add(value);
  let result;
  if (array) {
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      items.push(encodeJSON(value[index], ancestors));
    }
    result = `[${items.join(',')}]`;
  } else {
    result = `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${encodeJSON(value[key], ancestors)}`).join(',')}}`;
  }
  ancestors.delete(value);
  return result;
}

export async function digest(text) {
  if (typeof text !== 'string') throw new TypeError('Digest input must be text');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

const ID = /^[a-f0-9]{64}$/;
const FINAL = /^[a-f0-9]{64}\.json$/;
const PART = /^\.part-[a-f0-9]{64}-[a-f0-9]{32}$/;

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      event.schemaVersion !== 1 || typeof event.id !== 'string' || !ID.test(event.id) ||
      typeof event.projectId !== 'string' || !ID.test(event.projectId) ||
      typeof event.sessionId !== 'string' || !event.sessionId ||
      !(event.agentId === null || (typeof event.agentId === 'string' && event.agentId)) ||
      typeof event.kind !== 'string' || !event.kind || !Number.isFinite(event.occurredAt) ||
      !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
    throw new TypeError('Invalid ledger event schema');
  }
  canonical(event);
}

function pathIn(directory, name) {
  if (typeof directory !== 'string' || !directory || directory.includes('\0')) {
    throw new TypeError('Invalid ledger directory');
  }
  // Prefix relative paths so argv paths cannot become command options.
  const base = directory.startsWith('/') ? directory : `./${directory}`;
  return `${base.replace(/\/+$/, '')}/${name}`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEvents(left, right) {
  return left.occurredAt - right.occurredAt || compareText(left.id, right.id);
}

async function removePart($, path) {
  const result = await $.process.run(['/bin/rm', '-f', path]);
  if (result.exitCode !== 0) throw new Error(`Private-part cleanup failed (exit ${result.exitCode})`);
}

// A hard link publishes a fully written inode without overwriting an existing final.
// This supplies process-crash atomicity, not power-loss durability: fsync is unavailable.
export async function publish($, directory, event, signer = null) {
  validateEvent(event);
  const body = canonical(event);
  const envelope = { id: event.id, sha256: await digest(body), body };
  if (signer) envelope.auth = await signer.sign(body);
  const text = canonical(envelope);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  const part = pathIn(directory, `.part-${event.id}-${nonce}`);
  const final = pathIn(directory, `${event.id}.json`);
  let failure;
  try {
    await $.fs.write(part, text);
    if (await $.fs.read(part) !== text) throw new Error('Ledger private-part readback mismatch');
    if (await $.fs.exists(final)) {
      const info = await $.fs.stat(final);
      if (info.kind !== 'file' || info.isLink) return 'conflict';
    }
    const result = await $.process.run(['/bin/ln', part, final]);
    if (result.exitCode === 0) return 'published';
    if (!await $.fs.exists(final)) {
      throw new Error(`Ledger publish link failed (exit ${result.exitCode}; final absent)`);
    }
    const info = await $.fs.stat(final);
    if (info.kind !== 'file' || info.isLink) return 'conflict';
    return await $.fs.read(final) === text ? 'duplicate' : 'conflict';
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      if (await $.fs.exists(part)) await removePart($, part);
    } catch (cleanupError) {
      if (!failure) throw cleanupError;
      throw new AggregateError([failure, cleanupError], 'Ledger publish and private-part cleanup failed');
    }
  }
}

function parseEnvelope(text, name) {
  const envelope = JSON.parse(text);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      envelope.id !== name.slice(0, -5) || typeof envelope.sha256 !== 'string' ||
      !ID.test(envelope.sha256) || typeof envelope.body !== 'string') {
    throw new TypeError('Invalid ledger envelope or filename identity');
  }
  const event = JSON.parse(envelope.body);
  validateEvent(event);
  if (event.id !== envelope.id) throw new TypeError('Envelope and event identity differ');
  if (canonical(event) !== envelope.body) throw new TypeError('Event body is not canonical JSON');
  return { envelope, event };
}

// A verified final is reused while its listed metadata is unchanged, for at most this long;
// after it the content is read and checked again.
const LEASE_MS = 30 * 1000;

export async function readLedger($, directory, signer = null, cache = null) {
  const result = { events: [], invalid: [], parts: [] };
  if (!await $.fs.exists(directory)) return result;
  const entries = await $.fs.list(directory);
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    if (PART.test(entry.name)) {
      result.parts.push({ name: entry.name, kind: entry.kind,
        isLink: entry.isLink, mtimeMs: entry.mtimeMs });
      continue;
    }
    if (!FINAL.test(entry.name)) continue;
    if (entry.kind !== 'file' || entry.isLink) {
      result.invalid.push({ name: entry.name, reason: 'Final entry is not a regular file' });
      continue;
    }
    // Immutable finals are indexed by fresh metadata, including cross-process appends.
    // Missing metadata disables reuse; a short lease bounds stale host metadata.
    const path = pathIn(directory, entry.name);
    // The listing was just taken, so its metadata is as fresh as a stat: one call for the
    // directory instead of one per file. A host that lists no times is stat'ed.
    const info = cache && !Number.isFinite(entry.mtimeMs) ? await $.fs.stat(path) : entry;
    if (info.kind !== 'file' || info.isLink) {
      result.invalid.push({ name: entry.name, reason: 'Final entry is not a regular file' });
      continue;
    }
    const stamp = Number.isFinite(info.mtimeMs) ? JSON.stringify([
      info.mtimeMs, info.ctimeMs ?? null, info.size ?? null, info.ino ?? null,
      info.realPath ?? null]) : null;
    const cached = cache?.get(path);
    if (stamp && cached?.stamp === stamp && Date.now() - cached.verifiedAt < LEASE_MS) {
      result.events.push(JSON.parse(cached.body));
      continue;
    }
    // Expired or changed evidence must not leave an older verification reusable.
    if (cache) cache.delete(path);
    // I/O errors propagate; only malformed evidence is classified as invalid.
    const text = await $.fs.read(path);
    let parsed;
    try {
      parsed = parseEnvelope(text, entry.name);
    } catch (error) {
      result.invalid.push({ name: entry.name, reason: error.message });
      continue;
    }
    if (await digest(parsed.envelope.body) !== parsed.envelope.sha256) {
      result.invalid.push({ name: entry.name, reason: 'Event checksum mismatch' });
      continue;
    }
    if (signer && !await signer.verify(parsed.envelope.body, parsed.envelope.auth)) {
      result.invalid.push({ name: entry.name, reason: 'Event authentication unavailable or invalid' });
      continue;
    }
    result.events.push(parsed.event);
    if (cache && stamp && cache.size < 4096) {
      cache.set(path, { stamp, body: parsed.envelope.body, verifiedAt: Date.now() });
    }
  }
  result.events.sort(compareEvents);
  return result;
}

// Call only from an explicit maintenance command; never collect parts in a writer.
export async function cleanupParts($, directory, olderThanMs = 24 * 60 * 60 * 1000) {
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
    throw new TypeError('Cleanup age must be a finite non-negative number');
  }
  const cutoff = Date.now() - olderThanMs;
  if (!await $.fs.exists(directory)) return 0;
  let removed = 0;
  for (const entry of await $.fs.list(directory)) {
    if (!PART.test(entry.name) || entry.kind !== 'file' || entry.isLink ||
        !Number.isFinite(entry.mtimeMs) || entry.mtimeMs >= cutoff) continue;
    const path = pathIn(directory, entry.name);
    let info;
    try {
      info = await $.fs.stat(path);
    } catch (error) {
      if (!await $.fs.exists(path)) continue;
      throw error;
    }
    if (info.kind !== 'file' || info.isLink || !Number.isFinite(info.mtimeMs) ||
        info.mtimeMs >= cutoff) continue;
    await removePart($, path);
    removed += 1;
  }
  return removed;
}

function requestFile(request) {
  const file = request?.data.file;
  if (!file || typeof file.path !== 'string' ||
      (file.scope !== 'project' && file.scope !== 'external')) return null;
  return { path: file.path, scope: file.scope };
}

function callStatus(call) {
  if (!call.toolCallId) return 'uncorrelated';
  if (call.requests.length > 1 || call.results.length > 1) return 'conflict';
  if (!call.requests.length) return 'orphan-result';
  if (!call.results.length) return 'pending';
  const status = call.results[0].data.status;
  return ['completed', 'error', 'denied', 'exception'].includes(status) ? status : 'unknown';
}

export function replay(events) {
  const variants = new Map();
  for (const event of events) {
    validateEvent(event);
    const body = canonical(event);
    if (!variants.has(event.id)) variants.set(event.id, new Map());
    variants.get(event.id).set(body, JSON.parse(body));
  }
  const conflicts = [];
  const accepted = [];
  for (const id of [...variants.keys()].sort()) {
    const bodies = variants.get(id);
    if (bodies.size > 1) {
      conflicts.push({ type: 'event-id', id, variantCount: bodies.size });
    } else {
      accepted.push(bodies.values().next().value);
    }
  }
  accepted.sort(compareEvents);
  for (const event of accepted) {
    if (event.kind === 'ledger.conflict') conflicts.push({ type: 'persisted-conflict',
      id: event.id, targetId: event.data.targetId, rejectedHash: event.data.rejectedHash });
  }
  const disputed = new Set(accepted.filter(e => e.kind === 'ledger.conflict').map(e => e.data.targetId));
  const runs = new Map();
  const calls = new Map();
  for (const event of accepted) {
    const actor = { sessionId: event.sessionId, agentId: event.agentId };
    const runKey = canonical([event.sessionId, event.agentId]);
    if (!runs.has(runKey)) {
      runs.set(runKey, { ...actor, eventCount: 0, firstOccurredAt: event.occurredAt,
        lastOccurredAt: event.occurredAt });
    }
    const run = runs.get(runKey);
    run.eventCount += 1;
    run.lastOccurredAt = event.occurredAt;
    if (event.kind !== 'tool.request' && event.kind !== 'tool.result') continue;
    const toolCallId = typeof event.data.toolCallId === 'string' && event.data.toolCallId
      ? event.data.toolCallId : null;
    // Missing correlation stays separate; never infer a pair from time or tool name.
    const callKey = canonical([event.sessionId, toolCallId,
      toolCallId ? null : event.id]);
    if (!calls.has(callKey)) calls.set(callKey, { ...actor, toolCallId, requests: [], results: [] });
    const call = calls.get(callKey);
    (event.kind === 'tool.request' ? call.requests : call.results).push(event);
  }
  const toolCalls = [];
  const attribution = [];
  for (const call of calls.values()) {
    const { sessionId, agentId, toolCallId } = call;
    const actor = { sessionId, agentId, toolCallId };
    const status = [...call.requests, ...call.results].some(e => disputed.has(e.id)) ||
      new Set([...call.requests, ...call.results].map(e => e.agentId)).size > 1 ? 'conflict' : callStatus(call);
    const request = call.requests[0];
    const first = request || call.results[0];
    const tool = typeof first.data.tool === 'string' ? first.data.tool : null;
    const requestIds = call.requests.map(event => event.id);
    const resultIds = call.results.map(event => event.id);
    toolCalls.push({ ...actor, tool, requestIds, resultIds, status, file: requestFile(request) });
    if (status === 'conflict') {
      conflicts.push({ type: 'tool-call', ...actor, requestIds, resultIds });
    }
    for (const item of call.requests) {
      const file = requestFile(item);
      if (file) attribution.push({ ...actor, agentId: item.agentId,
        tool: typeof item.data.tool === 'string' ? item.data.tool : null,
        file, requestId: item.id, status });
    }
  }
  return { eventCount: variants.size, runs: [...runs.values()], toolCalls, attribution, conflicts };
}
