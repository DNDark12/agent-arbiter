// What kind of work an agent type does. It groups score rows and decides which
// lessons one agent type inherits from another; it is never a basis for guilt.
export const ROLES = Object.freeze(['ba', 'test-design', 'dev', 'test-run', 'review', 'security', 'db',
  'research', 'explore', 'orchestrate', 'other']);

// First match wins, so the narrower roles come before the broader ones:
// "security-integrity-reviewer" is security, "db-migration-reviewer" is db.
const PATTERNS = [
  ['security', /secur|integrity|pentest|vulnerab|threat/],
  ['db', /(^|[^a-z])(db|sql)([^a-z]|$)|database|migration|schema/],
  ['test-design', /test[-_ ]?design/],
  ['test-run', /tester|(^|[^a-z])qa([^a-z]|$)|test/],
  ['review', /review|audit|critic/],
  ['ba', /(^|[^a-z])ba([^a-z]|$)|analyst|requirement|planner|^plan$|architect/],
  ['research', /research|docs|guide|librarian/],
  ['explore', /explor|search|scout|investigat/],
  ['orchestrate', /orchestrat|coordinator|manager|(^|[^a-z])lead([^a-z]|$)/],
  ['dev', /dev|engineer|coder|implement|builder|rescue|fix/],
];

export function classifyRole(name) {
  const text = typeof name === 'string' ? name.toLowerCase() : '';
  return PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other';
}

// overrides: the person's own choice per agent type name, from /arbiter role.
export function roleOf(name, overrides = {}) {
  const chosen = Object.hasOwn(overrides, name) ? overrides[name] : null;
  return ROLES.includes(chosen) ? chosen : classifyRole(name);
}

// What one run is asked to do, read from its brief before it starts. A general
// agent type (role 'other') takes the role of its run; difficulty is fixed here,
// before the outcome is known, so the judge cannot be swayed by the result.
const BRIEF_ROLES = [
  ['security', /\b(security|vulnerab\w*|exploit\w*|injection|xss|csrf|secrets?|auth(entication|orization)?|permissions?)\b/g],
  ['review', /\b(review|audit|inspect the (diff|change)|code review|find (bugs|issues|problems))\b/g],
  ['test-design', /\b(write|add|design) (unit |integration |e2e )?tests?\b|\btest (cases|plan)\b/g],
  ['test-run', /\b(run|execute) (the )?(tests?|test suite|specs?)\b|\bqa\b/g],
  ['db', /\b(migrations?|schema|database|sql|index(es)?|seeders?)\b/g],
  ['ba', /\b(requirements?|acceptance criteria|user stor(y|ies)|specification|scope)\b/g],
  ['research', /\b(research|documentation|docs|compare|look up|investigate)\b/g],
  ['explore', /\b(find where|locate|search (the )?(code|repo)|explore|map the)\b/g],
  ['dev', /\b(implement|fix|add|build|refactor|create|update|write (the )?(code|function|module|class))\b/g],
];
const HARD = /\b(concurren\w*|race|deadlock|transactions?|migrations?|security|performance|optimi[sz]\w*|refactor\w*|algorithm\w*|distributed|caching|cache invalidation|idempoten\w*|backfill|encryption|parser|compiler)\b/gi;

export function briefProfile(prompt) {
  const text = typeof prompt === 'string' ? prompt.toLowerCase() : '';
  let runRole = 'other', best = 0;
  for (const [role, pattern] of BRIEF_ROLES) {
    const count = (text.match(pattern) ?? []).length;
    if (count > best) { best = count; runRole = role; }
  }
  const files = new Set(text.match(/[\w./-]+\.[a-z]{1,5}\b/g) ?? []).size;
  const hard = new Set((text.match(HARD) ?? []).map(word => word.toLowerCase())).size;
  const points = (text.length > 1500 ? 1 : 0) + (text.length > 4000 ? 1 : 0) + (files > 3 ? 1 : 0) + Math.min(hard, 2);
  return { runRole, difficulty: points >= 3 ? 'hard' : points >= 1 ? 'medium' : 'easy' };
}

// The role a run is held to: the person's choice, the agent type's, else the brief's.
export function effectiveRole(name, prompt, overrides = {}) {
  const role = roleOf(name, overrides);
  return role !== 'other' || Object.hasOwn(overrides, name) ? role : briefProfile(prompt).runRole;
}
