// What Arbiter decided about each tool call it stopped to look at, for the
// short note drawn under that call's row. Process memory only: a row from an
// earlier session draws without one.
const MAX_NOTES = 500;
const notes = new Map();
const ASK_OUTCOMES = new Set(['approved', 'session-allow', 'refused', 'unanswered']);

export function noteDecision(toolUseId, ruleIds, outcome) {
  if (typeof toolUseId !== 'string' || !toolUseId || !Array.isArray(ruleIds) || !ruleIds.length) return;
  notes.delete(toolUseId);
  notes.set(toolUseId, { ruleIds: [...ruleIds], outcome });
  while (notes.size > MAX_NOTES) notes.delete(notes.keys().next().value);
}

export function decisionNote(toolUseId) { return notes.get(toolUseId) ?? null; }
export function forgetNotes() { notes.clear(); }

export function approvalNotes() {
  return [...notes.entries()].filter(([, note]) => ASK_OUTCOMES.has(note.outcome));
}

// This session's approval asks so far: how many, and how many were allowed.
export function sessionAsks() {
  let asked = 0, allowed = 0;
  for (const [, note] of approvalNotes()) {
    asked += 1;
    if (note.outcome === 'approved' || note.outcome === 'session-allow') allowed += 1;
  }
  return { asked, allowed };
}
