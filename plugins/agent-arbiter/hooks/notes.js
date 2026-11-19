// What Arbiter decided about each tool call it stopped to look at, for the
// short note drawn under that call's row. Process memory only: a row from an
// earlier session draws without one.
const MAX_NOTES = 500;
const notes = new Map();

export function noteDecision(toolUseId, ruleIds, outcome) {
  if (typeof toolUseId !== 'string' || !toolUseId || !Array.isArray(ruleIds) || !ruleIds.length) return;
  notes.delete(toolUseId);
  notes.set(toolUseId, { ruleIds: [...ruleIds], outcome });
  while (notes.size > MAX_NOTES) notes.delete(notes.keys().next().value);
}

export function decisionNote(toolUseId) { return notes.get(toolUseId) ?? null; }
export function forgetNotes() { notes.clear(); }
