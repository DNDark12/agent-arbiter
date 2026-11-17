// Keeps the ledger from growing without bound. Routine records (every tool
// call writes two) are removed after RETENTION_DAYS. What the court decided is
// kept: violations, releases, reviews, the person's decisions, and which agent
// ran as which citizen. A routine record a kept one cites as evidence stays too.
// The hardened (signed) ledger is never pruned: its cases must stay provable.
import { readProject } from './events.js';

export const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 100;
// Only these kinds are ever removed; a kind not listed here is kept.
const ROUTINE = new Set(['tool.request', 'tool.result', 'turn.complete', 'session.start', 'spawn.request',
  'rule.decision', 'tool.consent', 'policy.preview', 'acceptance.delivery']);

function citedIds(events) {
  const cited = new Set();
  const add = value => { if (typeof value === 'string') cited.add(value); };
  for (const event of events) {
    if (ROUTINE.has(event.kind)) continue;
    const data = event.data ?? {}, judgment = data.judgment ?? {};
    add(data.requestId); add(data.targetId);
    for (const list of [data.evidenceIds, data.dependencyIds, judgment.evidenceIds, judgment.dependencyIds]) {
      if (Array.isArray(list)) list.forEach(add);
    }
  }
  return cited;
}

// The routine events old enough to remove, given every event of the project.
export function prunable(events, now = Date.now(), days = RETENTION_DAYS) {
  const cutoff = now - days * DAY_MS, cited = citedIds(events);
  return events.filter(event => ROUTINE.has(event.kind) && event.occurredAt < cutoff && !cited.has(event.id));
}

export async function pruneProject($, ctx, now = Date.now()) {
  if (ctx.signer || ctx.authConfigured || ctx.authError) return { removed: 0, parts: 0, skipped: 'hardened ledger is kept whole' };
  // cleanup = true also sweeps private part files a stopped writer left behind.
  const read = await readProject($, ctx, true);
  const old = prunable(read.events, now);
  let removed = 0;
  for (let index = 0; index < old.length; index += BATCH) {
    const paths = old.slice(index, index + BATCH).map(event =>
      `${ctx.dataRoot}/events/${ctx.projectId}/${new Date(event.occurredAt).toISOString().slice(0, 7)}/${event.id}.json`);
    const result = await $.process.run(['/bin/rm', '-f', ...paths]);
    if (result.exitCode === 0) removed += paths.length;
  }
  return { removed, parts: read.removed, kept: read.events.length - removed };
}

// Once a day per project, from any session. Never throws: maintenance that
// fails changes nothing and is tried again the next day.
export async function maintain($, ctx, now = Date.now()) {
  try {
    const marker = `${ctx.dataRoot}/events/${ctx.projectId}/.maintained`;
    if (await $.fs.exists(marker)) {
      const last = Number(await $.fs.read(marker));
      if (Number.isFinite(last) && now - last < DAY_MS) return null;
    }
    // Mark first, so two sessions starting together do not both prune.
    await $.fs.write(marker, String(now));
    return await pruneProject($, ctx, now);
  } catch { return null; }
}
