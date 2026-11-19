// Pure proposal only. Points, durable sentences and enforcement belong to later phases.
export function sentencing({ decision, actorId, group, repeatInTurn, attributableHarm } = {}) {
  const proposal = (type, reason, followUp = null) => ({ type, reason, followUp });
  if (!decision || decision.outcome !== 'deny' || decision.violation !== true ||
      !['approval-required', 'always-denied'].includes(decision.reason) ||
      typeof decision.lawId !== 'string' || !decision.lawId ||
      !['ordinary', 'destructive', 'always-deny'].includes(group) ||
      typeof repeatInTurn !== 'boolean' || typeof attributableHarm !== 'boolean') {
    return proposal('none', 'insufficient-evidence');
  }
  if (actorId === null) return proposal('warning', 'main-agent');
  if (typeof actorId !== 'string' || !actorId.trim()) return proposal('none', 'unattributed');
  if (repeatInTurn) return proposal('detain', 'repeat-in-turn', 'imprison');
  if (decision.reason === 'always-denied' || group === 'always-deny' || group === 'destructive' || attributableHarm) {
    return proposal('imprison', attributableHarm ? 'attributable-harm' : group);
  }
  return proposal('fine', 'unapproved-action');
}
