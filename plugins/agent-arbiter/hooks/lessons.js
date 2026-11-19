// Lessons: what earlier agents were stopped for, told to the next agent of the
// same type or role when it starts. A lesson is derived from violations still on
// the record, so releasing a violation withdraws its lesson. The person can
// share a lesson with every project; nothing is shared without that step.
import { t } from './i18n.js';
import { digest } from './ledger.js';
import { disciplineState, citizenSummary } from './discipline.js';
import { loadProjectSettings, listRules } from './project-rules.js';
import { roleOf, effectiveRole } from './roles.js';
import { readProject } from './events.js';
import { reduceReviews } from './judge.js';

export const MAX_LESSONS = 5;
const MAX_LIBRARY = 200;
const MAX_TEXT = 600;
const groupKey = (agentName, ruleIds) => `${agentName}\u0000${ruleIds.join(',')}`;
const agentNameOf = record => record.citizen?.name ?? (record.agentId ? 'agent' : 'main');
const sortedRules = record => [...new Set(record.ruleIds)].sort();

// labels: rule id -> readable name. overrides: roles the person set.
export function reduceLessons(discipline, labels = new Map(), overrides = {}) {
  const groups = new Map();
  for (const record of discipline?.violations ?? []) {
    if (record.status === 'released' || !record.ruleIds.length) continue;
    const agentName = agentNameOf(record), ruleIds = sortedRules(record), key = groupKey(agentName, ruleIds);
    const lesson = groups.get(key) ?? { agentName, role: agentName === 'main' ? 'orchestrate' : roleOf(agentName, overrides),
      ruleIds, count: 0, lastAt: 0, detail: '' };
    lesson.count += 1;
    if (record.at >= lesson.lastAt) { lesson.lastAt = record.at; lesson.detail = record.detail; }
    groups.set(key, lesson);
  }
  return [...groups.values()].map(lesson => {
    const names = lesson.ruleIds.map(id => labels.get(id) ?? id).join('; ');
    return { ...lesson, kind: 'rule', text: `${names}${lesson.detail ? ` — stopped for: ${lesson.detail}` : ''}`.slice(0, MAX_TEXT) };
  }).sort((left, right) => right.count - left.count || right.lastAt - left.lastAt);
}

// What the judge found and the person confirmed (kind finding), and practices
// the person approved as worth copying (kind exemplar).
export function reviewLessons(reviews, overrides = {}) {
  const groups = new Map();
  const add = (review, kind, tag, text) => {
    const agentName = review.citizen?.name ?? 'agent', key = `${agentName}\u0000${kind}\u0000${text}`;
    const lesson = groups.get(key) ?? { agentName, role: roleOf(agentName, overrides), ruleIds: [tag], kind, count: 0, lastAt: 0, detail: '', text };
    lesson.count += 1;
    lesson.lastAt = Math.max(lesson.lastAt, review.at);
    groups.set(key, lesson);
  };
  for (const review of reviews) {
    for (const finding of review.findings) if (finding.state === 'confirmed') add(review, 'finding', `finding:${finding.dimension}`, `${finding.claim} (review finding, ${finding.dimension})`.slice(0, MAX_TEXT));
    if (review.exemplar.state === 'approved' && review.exemplar.why) add(review, 'exemplar', 'exemplar', review.exemplar.why.slice(0, MAX_TEXT));
  }
  return [...groups.values()].sort((left, right) => right.count - left.count || right.lastAt - left.lastAt);
}

// Own type first, then other types of the same role, then shared lessons.
export function lessonsFor(lessons, library, agentName, role, limit = MAX_LESSONS) {
  const sameRole = lesson => role !== 'other' && lesson.role === role && lesson.agentName !== 'main';
  const sources = [['own', lessons.filter(lesson => lesson.agentName === agentName)],
    ['role', lessons.filter(lesson => lesson.agentName !== agentName && sameRole(lesson))],
    ['library', library.filter(lesson => lesson.agentName === agentName || sameRole(lesson))]];
  const seen = new Set(), picked = [];
  for (const [origin, list] of sources) {
    for (const lesson of list) {
      if (picked.length >= limit || seen.has(lesson.text)) continue;
      seen.add(lesson.text);
      picked.push({ ...lesson, origin });
    }
  }
  return picked;
}

export function lessonBlock(picked) {
  if (!picked.length) return '';
  const line = lesson => `- ${lesson.text}${lesson.origin === 'library' ? ' (from another project)' : lesson.count > 1 ? ` (${lesson.count} times)` : ''}`;
  const avoid = picked.filter(lesson => lesson.kind !== 'exemplar'), copy = picked.filter(lesson => lesson.kind === 'exemplar');
  return '\n\n[' + [
    ...(avoid.length ? ['Agent Arbiter lessons. Earlier agents were stopped for the actions listed below. This is a record, not a task: do not attempt them, and if your task seems to need one, stop and report to the lead.', ...avoid.map(line)] : []),
    ...(copy.length ? ['Agent Arbiter exemplars. Practices from earlier runs that the person approved as worth copying:', ...copy.map(line)] : []),
  ].join('\n') + ']';
}

// How often each lesson was taught, and how often it was broken again afterwards.
export function lessonEffects(events, projectId, lessons, discipline) {
  const effects = new Map(lessons.map(lesson => [lesson.id, { taught: 0, firstTaughtAt: null, repeatsAfter: 0 }]));
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.projectId !== projectId || event.kind !== 'spawn.result' || !Array.isArray(event.data?.lessons)) continue;
    for (const id of event.data.lessons) {
      const effect = effects.get(id);
      if (!effect) continue;
      effect.taught += 1;
      if (effect.firstTaughtAt === null || event.occurredAt < effect.firstTaughtAt) effect.firstTaughtAt = event.occurredAt;
    }
  }
  const byGroup = new Map(lessons.filter(lesson => lesson.kind === 'rule').map(lesson => [groupKey(lesson.agentName, lesson.ruleIds), effects.get(lesson.id)]));
  for (const record of discipline?.violations ?? []) {
    const effect = record.status === 'released' ? null : byGroup.get(groupKey(agentNameOf(record), sortedRules(record)));
    if (effect && effect.firstTaughtAt !== null && record.at > effect.firstTaughtAt) effect.repeatsAfter += 1;
  }
  return effects;
}

export function lessonTable(lessons, effects, enabled, experiment = null) {
  const head = t('tbl.lessonsHead', { state: t(enabled ? 'cmd.on' : 'cmd.off') });
  const tail = experiment ? [t('tbl.experiment', experiment)] : [];
  if (!lessons.length) return [head, t('tbl.lessonsNone'), ...tail].join('\n');
  return [head, ...lessons.map(lesson => {
    const effect = effects.get(lesson.id) ?? { taught: 0, repeatsAfter: 0 };
    const base = { id: lesson.id, agent: lesson.agentName, role: lesson.role, text: lesson.text, taught: effect.taught };
    return lesson.kind === 'rule' ? t('tbl.lessonRule', { ...base, count: lesson.count, repeats: effect.repeatsAfter }) :
      t('tbl.lessonOther', { ...base, kind: lesson.kind });
  }), ...tail, t('tbl.lessonsShare')].join('\n');
}

export async function projectLessons($, ctx, settings) {
  const preferences = settings ?? await loadProjectSettings($, ctx);
  const labels = new Map(listRules(preferences).map(rule => [rule.id, rule.source === 'builtin' ? rule.label : `${rule.action} ${rule.target}`]));
  const lessons = reduceLessons(await disciplineState($, ctx), labels, preferences.roles);
  for (const lesson of lessons) lesson.id = (await digest(`${ctx.projectId}\u0000${groupKey(lesson.agentName, lesson.ruleIds)}`)).slice(0, 12);
  let reviewed = [];
  try { reviewed = reviewLessons(reduceReviews((await readProject($, ctx)).events, ctx.projectId), preferences.roles); }
  catch { /* Rule lessons still apply when reviews cannot be read. */ }
  for (const lesson of reviewed) lesson.id = (await digest(`${ctx.projectId}\u0000${lesson.agentName}\u0000${lesson.kind}\u0000${lesson.text}`)).slice(0, 12);
  return [...lessons, ...reviewed];
}

function libraryPath(ctx) {
  if (typeof ctx?.archiveRoot !== 'string' || !ctx.archiveRoot.startsWith('/')) throw new Error('Invalid lesson library location');
  return `${ctx.archiveRoot.replace(/\/+$/, '')}/library/lessons.json`;
}

function libraryEntry(value) {
  return value && typeof value === 'object' && /^[a-f0-9]{12}$/.test(value.id) && typeof value.agentName === 'string' &&
    typeof value.role === 'string' && typeof value.text === 'string' && value.text.length <= MAX_TEXT && Array.isArray(value.ruleIds);
}

// A missing or unreadable library teaches nothing; it never blocks a spawn.
export async function loadLibrary($, ctx) {
  try {
    const path = libraryPath(ctx);
    if (!await $.fs.exists(path)) return [];
    const value = JSON.parse(await $.fs.read(path));
    return Array.isArray(value) ? value.filter(libraryEntry).slice(0, MAX_LIBRARY) : [];
  } catch { return []; }
}

async function saveLibrary($, ctx, entries) {
  const path = libraryPath(ctx), temporary = `${path}.${crypto.randomUUID()}.part`;
  try {
    await $.fs.write(temporary, JSON.stringify(entries.slice(0, MAX_LIBRARY), null, 2) + '\n');
    const published = await $.process.run(['/bin/mv', '-f', temporary, path]);
    if (published.exitCode !== 0) throw new Error('Could not publish the lesson library');
  } catch (error) {
    try { await $.process.run(['/bin/rm', '-f', temporary]); } catch { /* Preserve the publication failure. */ }
    throw error;
  }
}

// Returns the ids newly added. The caller has already checked a person asked.
export async function shareLessons($, ctx, lessons) {
  const library = await loadLibrary($, ctx), added = [];
  for (const lesson of lessons) {
    if (library.some(entry => entry.id === lesson.id)) continue;
    library.push({ id: lesson.id, kind: lesson.kind ?? 'rule', agentName: lesson.agentName, role: lesson.role, ruleIds: lesson.ruleIds,
      text: lesson.text, sourceProjectId: ctx.projectId, sharedAt: Date.now() });
    added.push(lesson.id);
  }
  if (added.length) await saveLibrary($, ctx, library);
  return added;
}

export async function unshareLessons($, ctx, prefix) {
  const library = await loadLibrary($, ctx);
  const removed = library.filter(entry => prefix === 'all' || (prefix.length >= 4 && entry.id.startsWith(prefix))).map(entry => entry.id);
  if (removed.length) await saveLibrary($, ctx, library.filter(entry => !removed.includes(entry.id)));
  return removed;
}

// policy: what the discipline step decided for this spawn. Adds the lessons to
// the brief of a new run; a resume or a refused spawn is returned untouched.
export async function teachSpawn($, ctx, policy, identity) {
  const input = policy?.input;
  if (!input || typeof input.prompt !== 'string' || input.resume) return policy;
  const settings = await loadProjectSettings($, ctx);
  const summary = citizenSummary(identity);
  if (!settings.lessons || !summary) return policy;
  const picked = lessonsFor(await projectLessons($, ctx, settings), await loadLibrary($, ctx), summary.name, effectiveRole(summary.name, input.prompt, settings.roles));
  if (!picked.length) return policy;
  // The control group: with the experiment on, one run in five gets no lessons.
  if (settings.lessonExperiment && parseInt((await digest(`${input.tool_use_id ?? crypto.randomUUID()}`)).slice(0, 8), 16) % 5 === 0) {
    return { ...policy, lessonsHeldOut: true };
  }
  return { ...policy, input: { ...input, prompt: input.prompt + lessonBlock(picked) }, lessons: picked.map(lesson => lesson.id) };
}

// Violations per run, for runs that were taught lessons and runs held out.
export function experimentResults(events, projectId, discipline) {
  const groups = { taught: new Set(), held: new Set() };
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.projectId !== projectId || event.kind !== 'spawn.result' || event.data?.status !== 'started' || typeof event.data.childAgentId !== 'string') continue;
    const key = `${event.sessionId}:${event.data.childAgentId}`;
    if (event.data.lessonsHeldOut) groups.held.add(key);
    else if (Array.isArray(event.data.lessons) && event.data.lessons.length) groups.taught.add(key);
  }
  const violations = group => (discipline?.violations ?? []).filter(record => record.status !== 'released' && record.agentId &&
    group.has(`${record.sessionId}:${record.agentId}`)).length;
  const rate = (count, runs) => runs ? (count / runs).toFixed(2) : '-';
  const taughtViolations = violations(groups.taught), heldViolations = violations(groups.held);
  return { taught: groups.taught.size, held: groups.held.size, taughtViolations, heldViolations,
    taughtRate: rate(taughtViolations, groups.taught.size), heldRate: rate(heldViolations, groups.held.size) };
}
