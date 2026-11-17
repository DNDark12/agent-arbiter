import {canonical} from './ledger.js';
import {reduceCases} from './cases.js';

const ID=/^[a-f0-9]{64}$/;
const HELD=new Set(['detain','imprison','life']);
const TERMINAL=new Set(['completed','failed','killed']);
const FILE_TOOLS=new Set(['Read','Glob','Grep','Write','Edit','NotebookEdit']);
const SPAWN_TOOLS=new Set(['Agent','Task','TaskSpawn']);
const ALIASES=new Set(['haiku','sonnet','opus','inherit','default','unknown','unspecified','auto','latest']);
const text=value=>typeof value==='string' && value.trim()===value && value.length>0 && !/[\0\r\n]/.test(value);
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const scoped=(events,ctx)=>Array.isArray(events)?events.filter(event=>event?.projectId===ctx?.projectId &&
 event.sessionId===ctx?.sessionId && object(event.data)):[];
const unknown=()=>({known:false,citizenId:null,restrictions:[],caseIds:[]});

// The caller supplies authenticated events. Never use an old session's runtime
// agent ID as a current citizen binding; an unknown resume cannot inherit one.
export function actorSentence(events,ctx,agentId) {
 if(!text(agentId) || !text(ctx?.sessionId) || !ID.test(ctx?.projectId) || ctx.authError) return unknown();
 const projection=reduceCases(events,ctx.projectId);
 const actorHeld=projection.cases.some(record=>record.status==='active' &&
  record.judgment.actor.sessionId===ctx.sessionId && record.judgment.actor.agentId===agentId &&
  record.effects.restrictions.some(restriction=>HELD.has(restriction)));
 const bindings=scoped(events,ctx).filter(event=>event.kind==='spawn.result' &&
  event.data.status==='started' && event.data.childAgentId===agentId).map(event=>event.data.citizen?.id);
 const ids=new Set(bindings);
 if(!bindings.length || ids.size!==1 || !bindings.every(id=>typeof id==='string' && ID.test(id))) {
  return actorHeld?{...unknown(),held:true}:unknown();
 }
 const citizenId=bindings[0];
 const sentence=projection.citizens.find(citizen=>citizen.citizenId===citizenId);
 const restrictions=sentence?[...sentence.restrictions]:[];
 return {known:true,citizenId,restrictions,caseIds:sentence?[...sentence.caseIds]:[],
  held:actorHeld || restrictions.some(restriction=>HELD.has(restriction))};
}

export function stoppedTree(agents,agentId) {
 const no=reason=>({stopped:false,reason});
 if(!text(agentId) || !Array.isArray(agents) || !agents.length) return no('agent-list-unavailable');
 const rows=new Map();
 for(const agent of agents) {
  if(!object(agent) || !text(agent.id) || rows.has(agent.id) ||
    (agent.parentId!==undefined && !text(agent.parentId))) return no('agent-list-ambiguous');
  rows.set(agent.id,agent);
 }
 if(!rows.has(agentId)) return no('agent-missing');
 const pending=[agentId],seen=new Set();
 while(pending.length) {
  const id=pending.pop();
  if(seen.has(id)) return no('agent-tree-cycle');
  seen.add(id);
  if(!TERMINAL.has(rows.get(id).status)) return no('agent-tree-running');
  for(const row of rows.values()) if(row.parentId===id) pending.push(row.id);
 }
 return {stopped:true,reason:'agent-tree-stopped'};
}

function linkedSpawn(request,history) {
 const attempts=history.filter(event=>event.kind==='spawn.request' && event.agentId===request.agentId &&
  text(request.data.toolCallId) && event.data.toolCallId===request.data.toolCallId);
 return attempts.length>0 && attempts.every(attempt=>settledSpawn(attempt,history));
}

function settledSpawn(attempt,history) {
 if(!text(attempt.data.spawnAttemptId)) return false;
 const results=history.filter(event=>event.kind==='spawn.result' && event.agentId===attempt.agentId &&
  event.data.spawnAttemptId===attempt.data.spawnAttemptId);
 if(!results.length) return false;
 if(!results.every(event=>event.data.status==='denied' && event.data.childAgentId===null ||
   event.data.status==='started' && text(event.data.childAgentId))) return false;
 const outcomes=new Set(results.map(event=>canonical([event.data.status,event.data.childAgentId??null])));
 return outcomes.size===1;
}

export function handoverProof(events,ctx,agentId,agents) {
 const no=reason=>({safe:false,reason});
 if(!text(ctx?.sessionId) || !ID.test(ctx?.projectId) || ctx.authError || !Array.isArray(events)) {
  return no('actor-history-unavailable');
 }
 const stopped=stoppedTree(agents,agentId);
 if(!stopped.stopped) return no(stopped.reason);
 const history=scoped(events,ctx);
 const tree=new Set([agentId]);
 // AgentInfo.parentId is authoritative for currently listed descendants. The
 // ledger also retains children that have disappeared from the runtime list.
 let changed=true;
 while(changed) {
  changed=false;
  const add=id=>{if(!tree.has(id)){tree.add(id);changed=true;}};
  for(const row of agents) if(tree.has(row.parentId)) add(row.id);
  for(const event of history) if(event.kind==='spawn.result' && tree.has(event.agentId) &&
    event.data.status==='started' && text(event.data.childAgentId)) add(event.data.childAgentId);
 }
 if(!history.some(event=>event.agentId===agentId || event.kind==='spawn.result' &&
   event.data.status==='started' && event.data.childAgentId===agentId)) return no('actor-history-unavailable');
 for(const id of tree) {
  const child=stoppedTree(agents,id);
  if(!child.stopped) return no(child.reason);
  const parents=new Set(agents.filter(row=>row.id===id && text(row.parentId)).map(row=>row.parentId));
  for(const event of history) if(event.kind==='spawn.result' && event.data.status==='started' &&
    event.data.childAgentId===id) parents.add(event.agentId);
  if(parents.size>1) return no('spawn-parent-ambiguous');
 }
 for(const event of history) {
  if(!tree.has(event.agentId)) continue;
  if(event.kind==='spawn.request' && !settledSpawn(event,history)) return no('spawn-outcome-unavailable');
  if(event.kind==='spawn.result' && event.data.status!=='denied' &&
    (event.data.status!=='started' || !text(event.data.childAgentId))) return no('spawn-outcome-unavailable');
  if(event.kind!=='tool.request' && event.kind!=='tool.result') continue;
  if(FILE_TOOLS.has(event.data.tool)) continue;
  if(SPAWN_TOOLS.has(event.data.tool) && linkedSpawn(event,history)) continue;
  // Even an apparently harmless Bash command may invoke a script that detaches
  // a process. A killed agent never proves those external effects ended.
  return no('external-capability-history');
 }
 return {safe:true,reason:'stopped-file-only-tree'};
}

// Deliberately top-level: native function hooks need each $ operation visible.
export async function stopForHandover($,ctx,agentId,events) {
 if(!text(agentId)) return {safe:false,reason:'agent-missing',stopReported:false};
 let stopReported=false;
 try {
  const result=await $.tool.call({tool:'TaskStop',task_id:agentId});
  stopReported=object(result) && result.deny===undefined && result.isError!==true &&
   (result.result!==undefined || text(result.text));
 } catch { /* Still inspect the runtime; an error is never a successful stop. */ }
 let agents;
 try {agents=await $.agent.list();}
 catch {return {safe:false,reason:'agent-list-unavailable',stopReported};}
 const proof=handoverProof(events,ctx,agentId,agents);
 return stopReported?{...proof,stopReported}:{safe:false,reason:'stop-unconfirmed',stopReported};
}

const modelId=value=>text(value) && !ALIASES.has(value.toLowerCase()) && !/[\s*\[\]]/.test(value);
function knownIdentity(identity) {
 if(!object(identity) || !text(identity.name) || !['projectSettings','userSettings','built-in','plugin'].includes(identity.source) ||
   !modelId(identity.resolvedModel)) return false;
 if(identity.provider!==null && (!object(identity.provider) || !text(identity.provider.plugin) || !text(identity.provider.tier))) return false;
 return typeof identity.definitionHash==='string' && ID.test(identity.definitionHash) ||
  identity.source==='built-in' && identity.definitionHash===null && text(identity.engineVersion);
}

function sameDefinition(left,right) {
 if(!object(right) || left.name!==right.name || left.source!==right.source) return false;
 if(canonical(left.provider)!==canonical(right.provider??null)) return false;
 return left.definitionHash ? left.definitionHash===right.definitionHash :
  right.definitionHash===null && left.engineVersion===right.engineVersion;
}

export function replacementModel(identity,bannedIdentities,configuredModels) {
 if(!knownIdentity(identity) || !Array.isArray(bannedIdentities) || !Array.isArray(configuredModels)) return null;
 return configuredModels.find(model=>modelId(model) && model!==identity.resolvedModel &&
  !bannedIdentities.some(banned=>sameDefinition(identity,banned) && banned.resolvedModel===model))??null;
}
