import { canonical, digest, publish, readLedger, cleanupParts, replay } from './ledger.js';
const payloads = new Map();
const inFlight = new Map();
const projectCaches = new Map();
const FINAL = /^[a-f0-9]{64}\.json$/;
const MONTH = /^\d{4}-\d{2}$/;

function projectCache(ctx) {
  const key = canonical([ctx.dataRoot, ctx.projectId, ctx.anchor || null,
    ctx.signer ? ctx.signer.keyId || null : 'unsigned', ctx.epoch || null]);
  let cache = projectCaches.get(key);
  if (!cache) {
    cache = new Map();
    projectCaches.set(key, cache);
    if (projectCaches.size > 16) projectCaches.delete(projectCaches.keys().next().value);
  }
  return cache;
}

function invalidateFinal(ctx, id) {
  const prefix = `${ctx.dataRoot}/events/${ctx.projectId}/`;
  for (const cache of projectCaches.values()) {
    for (const path of cache.keys()) {
      if (path.startsWith(prefix) && path.endsWith(`/${id}.json`)) cache.delete(path);
    }
  }
}

async function recordConflict($, ctx, actor, id, data) {
  // Hash only: neither the original nor the rejected payload is copied here.
  const rejectedHash = await digest(canonical(data));
  await emit($, ctx, actor, 'ledger.conflict', `${id}:${rejectedHash}`,
    { targetId: id, rejectedHash });
  throw new Error('Event payload conflict');
}

export async function emit($, ctx, actor, kind, key, data) {
  if (ctx.authError) throw new Error('Authenticated evidence unavailable');
  data = { ...data, checkoutId: ctx.checkoutId };
  const id = await digest(canonical([ctx.projectId, ctx.sessionId, kind.startsWith('tool.') ? null : actor, kind, key]));
  const previous = inFlight.get(id) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => emitOne($, ctx, actor, kind, id, data));
  inFlight.set(id, pending);
  try { await pending; return id; }
  finally { if (inFlight.get(id) === pending) inFlight.delete(id); }
}

function sameData(prior, current) {
  // Legacy evidence predates checkout metadata; preserve its exact original bytes.
  const candidate = { ...current };
  if (!Object.hasOwn(prior, 'checkoutId')) delete candidate.checkoutId;
  return canonical(prior) === canonical(candidate);
}

async function emitOne($, ctx, actor, kind, id, data) {
  let event = payloads.get(id);
  if (event && (event.agentId !== actor || !sameData(event.data, data))) {
    if (kind === 'ledger.conflict') throw new Error('Conflict evidence differs');
    return recordConflict($, ctx, actor, id, data);
  }
  if (!event) {
    // Reuse persisted time/body across hook restarts; never overwrite first evidence.
    const base = `${ctx.dataRoot}/events/${ctx.projectId}`;
    if (await $.fs.exists(base)) {
      for (const entry of await $.fs.list(base)) {
        if (entry.kind !== 'dir' || entry.isLink || !/^\d{4}-\d{2}$/.test(entry.name)) continue;
        const path = `${base}/${entry.name}/${id}.json`;
        if (!await $.fs.exists(path)) continue;
        const info = await $.fs.stat(path);
        if (info.kind !== 'file' || info.isLink) throw new Error('Invalid prior evidence');
        const envelope = JSON.parse(await $.fs.read(path));
        const prior = JSON.parse(envelope.body);
        if ((ctx.signer && !await ctx.signer.verify(envelope.body,envelope.auth)) || envelope.id !== id || prior.id !== id || await digest(envelope.body) !== envelope.sha256 ||
          canonical(prior) !== envelope.body || prior.schemaVersion !== 1 || prior.projectId !== ctx.projectId ||
          prior.sessionId !== ctx.sessionId || prior.agentId !== actor || prior.kind !== kind ||
          !Number.isFinite(prior.occurredAt) || !sameData(prior.data, data)) {
          if (kind === 'ledger.conflict') throw new Error('Invalid prior conflict evidence');
          return recordConflict($, ctx, actor, id, data);
        }
        event = prior;
      }
    }
    event ||= { schemaVersion: 1, id, projectId: ctx.projectId, sessionId: ctx.sessionId,
      agentId: actor, kind, occurredAt: Date.now(), data: JSON.parse(canonical({ ...data, checkoutId: ctx.checkoutId })) };
    payloads.set(id, event);
    if (payloads.size > 4096) payloads.delete(payloads.keys().next().value);
  }
  const month = new Date(event.occurredAt).toISOString().slice(0, 7);
  const result = await publish($, `${ctx.dataRoot}/events/${ctx.projectId}/${month}`, event, ctx.signer);
  invalidateFinal(ctx, id);
  scans.clear();
  if (result === 'conflict') {
    // Another process may have published identical metadata with an earlier time.
    const path = `${ctx.dataRoot}/events/${ctx.projectId}/${month}/${id}.json`;
    const info = await $.fs.stat(path);
    if (info.kind === 'file' && !info.isLink) {
      const envelope = JSON.parse(await $.fs.read(path));
      const winner = JSON.parse(envelope.body);
      if ((!ctx.signer || await ctx.signer.verify(envelope.body,envelope.auth)) && envelope.id === id && await digest(envelope.body) === envelope.sha256 &&
          canonical(winner) === envelope.body && winner.schemaVersion === 1 && winner.id === id &&
          winner.projectId === ctx.projectId && winner.sessionId === ctx.sessionId &&
          winner.agentId === actor && winner.kind === kind && Number.isFinite(winner.occurredAt) &&
          sameData(winner.data, data)) {
        payloads.set(id, winner);
        return;
      }
    }
    if (kind === 'ledger.conflict') throw new Error('Conflict record could not be published');
    return recordConflict($, ctx, actor, id, data);
  }
}

async function checkedDirectory($, path) {
  const info = await $.fs.stat(path);
  if (info.kind !== 'dir' || info.isLink) {
    throw new Error('Ledger directory is not canonical');
  }
}

async function quarantineDirectory($, ctx, month) {
  await checkedDirectory($, ctx.dataRoot);
  let path = ctx.dataRoot;
  for (const name of ['quarantine', ctx.projectId, month]) {
    path += `/${name}`;
    if (!await $.fs.exists(path)) {
      const made = await $.process.run(['/bin/mkdir', path]);
      if (made.exitCode !== 0 && !await $.fs.exists(path)) throw new Error('Quarantine directory unavailable');
    }
    await checkedDirectory($, path);
  }
  return path;
}

async function isolateFinal($, ctx, month, issue) {
  const source = `${ctx.dataRoot}/events/${ctx.projectId}/${month}/${issue.name}`;
  const result = { ...issue, source };
  if (!FINAL.test(issue.name) || !MONTH.test(month)) return result;
  try {
    await checkedDirectory($, ctx.dataRoot);
    await checkedDirectory($, `${ctx.dataRoot}/events`);
    await checkedDirectory($, `${ctx.dataRoot}/events/${ctx.projectId}`);
    await checkedDirectory($, `${ctx.dataRoot}/events/${ctx.projectId}/${month}`);
    if (!await $.fs.exists(source)) return result;
    const info = await $.fs.stat(source);
    // Never move/follow a symlink, directory, or unrelated file.
    if (info.kind !== 'file' || info.isLink) return result;
    const directory = await quarantineDirectory($, ctx, month);
    const token = `${issue.name.slice(0, -5)}-${crypto.randomUUID()}`;
    const target = `${directory}/${token}.json`;
    const report = `${directory}/${token}.report.json`;
    await $.fs.write(report, canonical({ source, target, reason: issue.reason, isolatedAt: Date.now() }));
    const moved = await $.process.run(['/bin/mv', '-n', source, target]);
    if (moved.exitCode !== 0 || !await $.fs.exists(target)) throw new Error('Quarantine move unavailable');
    result.quarantined = target;
    result.report = report;
    invalidateFinal(ctx, issue.name.slice(0, -5));
    scans.clear();
  } catch (error) {
    result.quarantineError = error.message;
  }
  return result;
}

async function scanProject($, ctx, cleanup, isolate) {
  if (ctx.authError) return {events:[],invalid:[{reason:'Authentication unavailable'}],parts:[],removed:0};
  if (!/^[a-f0-9]{64}$/.test(ctx.projectId)) throw new Error('Invalid project identity');
  const directory = `${ctx.dataRoot}/events/${ctx.projectId}`;
  const events = [], invalid = [], parts = [];
  let removed = 0;
  const cache = projectCache(ctx);
  if (await $.fs.exists(directory)) {
    await checkedDirectory($, directory);
    for (const entry of await $.fs.list(directory)) {
      if (entry.kind !== 'dir' || entry.isLink || !MONTH.test(entry.name)) continue;
      const month = `${directory}/${entry.name}`;
      await checkedDirectory($, month);
      if (cleanup) removed += await cleanupParts($, month, 24 * 60 * 60 * 1000);
      const read = await readLedger($, month, ctx.signer, cache);
      // A valid envelope from another project is still misplaced evidence.
      for (const event of read.events) {
        if (event.projectId === ctx.projectId) events.push(event);
        else read.invalid.push({name:`${event.id}.json`,reason:'Event project identity differs'});
      }
      for (const issue of read.invalid) invalid.push(isolate ? await isolateFinal($, ctx, entry.name, issue) : { ...issue, source: `${month}/${issue.name}` });
      parts.push(...read.parts);
    }
  }
  events.sort((a, b) => a.occurredAt - b.occurredAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {events,invalid,parts,removed};
}

// The panel and the band ask for the same ledger several times in one breath
// (status, scores, reviews, discipline). Those views share one scan for a few
// seconds; a write from this process drops it at once, and nothing that
// enforces a rule reads through it.
const scans = new Map();
const SCAN_SHARE_MS = 5000;
export function readProjectShared($, ctx) {
  const key = canonical([ctx.dataRoot, ctx.projectId, ctx.anchor || null, ctx.signer ? ctx.signer.keyId || null : 'unsigned', ctx.epoch || null]);
  const hit = scans.get(key);
  const read = hit && Date.now() - hit.at < SCAN_SHARE_MS ? hit.promise : (() => {
    const promise = readProject($, ctx).catch(error => { if (scans.get(key)?.promise === promise) scans.delete(key); throw error; });
    scans.set(key, { at: Date.now(), promise });
    if (scans.size > 16) scans.delete(scans.keys().next().value);
    return promise;
  })();
  return read.then(result => ({ ...result, events: [...result.events] }));
}

export async function readProject($, ctx, cleanup = false) {
  // Authenticated authority cannot heal itself by removing failed authentication.
  // Only the explicit human recovery path may move those records out of the epoch.
  return scanProject($, ctx, cleanup, !ctx.signer && !ctx.authConfigured);
}

async function priorQuarantines($, ctx) {
  const issues = [];
  const directory = `${ctx.dataRoot}/quarantine/${ctx.projectId}`;
  if (!await $.fs.exists(directory)) return issues;
  try {
    await checkedDirectory($, ctx.dataRoot);
    await checkedDirectory($, `${ctx.dataRoot}/quarantine`);
    await checkedDirectory($, directory);
  } catch { return issues; }
  for (const month of await $.fs.list(directory)) {
    if (month.kind !== 'dir' || month.isLink || !MONTH.test(month.name)) continue;
    const path = `${directory}/${month.name}`;
    await checkedDirectory($, path);
    for (const entry of await $.fs.list(path)) {
      if (entry.kind !== 'file' || entry.isLink ||
          !/^[a-f0-9]{64}-[a-f0-9-]{36}\.report\.json$/.test(entry.name)) continue;
      const report = `${path}/${entry.name}`;
      const target = `${path}/${entry.name.replace('.report.json', '.json')}`;
      if (!await $.fs.exists(target)) continue;
      const info = await $.fs.stat(target);
      if (info.kind !== 'file' || info.isLink) continue;
      try {
        const recorded = JSON.parse(await $.fs.read(report));
        const name = `${entry.name.slice(0, 64)}.json`;
        const source = `${ctx.dataRoot}/events/${ctx.projectId}/${month.name}/${name}`;
        if (recorded.source !== source || recorded.target !== target || typeof recorded.reason !== 'string') continue;
        issues.push({ name, source, reason: recorded.reason, quarantined: target, report });
      } catch { /* A damaged report cannot authorize changes to its stored evidence. */ }
    }
  }
  return issues;
}

export async function quarantineProject($, ctx) {
  const read = await scanProject($, ctx, false, true);
  const issues = [...read.invalid];
  const reports = new Set(issues.map(issue => issue.report));
  for (const issue of await priorQuarantines($, ctx)) {
    if (!reports.has(issue.report)) issues.push(issue);
  }
  return { events: read.events.length, issues, conflicts: replay(read.events).conflicts,
    paths: issues.filter(issue => issue.quarantined).map(issue => issue.quarantined),
    reports: issues.filter(issue => issue.report).map(issue => issue.report) };
}

// After the person deletes Arbiter data, nothing cached may bring it back.
export function forgetCaches() { payloads.clear(); inFlight.clear(); projectCaches.clear(); scans.clear(); }
