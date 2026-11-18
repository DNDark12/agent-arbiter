// Shared process state for commands and human pane callbacks.
export const modes = new Map();
export const enforcedSessions = new Map();
let emergencyOff = false, masterEnabled = true;
export function setMasterEnabled(value) { masterEnabled = value !== false; }
export function masterIsEnabled() { return masterEnabled; }
export function emergencyStopped() { return emergencyOff; }
export function setEmergencyOff(value) { emergencyOff = value === true; }
export function courtDisabled() { return !masterEnabled || emergencyOff; }
export function enforcementArmed() { return enforcedSessions.size > 0 && !emergencyOff; }
export function resetEnforcement(ctx) {
  emergencyOff = false;
  if (ctx) { enforcedSessions.delete(ctx.sessionId); modes.delete(`${ctx.projectId}:${ctx.sessionId}`); }
  else { enforcedSessions.clear(); modes.clear(); }
}
