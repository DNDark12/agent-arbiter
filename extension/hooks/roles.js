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
