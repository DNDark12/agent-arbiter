import {registerRulesPane} from './rules-pane.js';
import {registerBand} from './band.js';
import { enforceTool, endedTurn, fallbackTool } from './gate.js';
import { protectionArmed, consumeRuntimeProbe, completeRuntimeProbe } from './runtime.js';
import { classifyTool } from './action.js';
import { actorSentence, stopForHandover } from './prison.js';
import { enforceSpawn, rememberSpawn } from './spawn.js';
import { handleCourt, observing, currentEnforcement, enforcementArmed, courtDisabled, setMasterEnabled } from './controls.js';
import { emit, readProject, readProjectShared } from './events.js';
import { canonical, digest, replay } from './ledger.js';
import { redact, fileMetadata } from './privacy.js';
import { observationContext as context, platformSupported } from './context.js';
import { citizen, bindCitizen } from './citizens.js';
import { transcriptCoverage, gitSnapshot, gitHead } from './forensics.js';
import { rememberCitizen, takeSpawnNote, handbackNoteFor, replacementAllowed, rejectReplacement, beginReplacement, endReplacement } from './discipline.js';
import { setLanguage, t } from './i18n.js';
import { chime, refreshStatus, setSounds, statusCounts } from './status.js';
import { disciplineState } from './discipline.js';
import { reduceReviews } from './judge.js';
import { rememberBrief, rememberMainTurn, mainTurnId, noteActivity, judgeRun } from './judge.js';
import { briefProfile } from './roles.js';
import { maintain, pruneProject, RETENTION_DAYS } from './retention.js';
import { beginActivity, beginWait, endActorActivity, recordOutputRate } from './notes.js';
import { verificationCheck, verificationOutcome } from './history.js';
import { CHECKLIST_TOOL, NATIVE_TASKS, checklistSummary, nativeOperation, registerChecklistTool, reportedOperation, saveChecklist } from './checklist.js';

const offers = new Map();
let failures = 0;
let sequence = 0;
const boot = crypto.randomUUID();
function armed(){return !courtDisabled() && (protectionArmed() || enforcementArmed());}

async function warn($) {
  failures += 1;
  try { await $.ui.log('Agent Arbiter: evidence collection incomplete; inspect status before relying on this run.'); } catch { /* Never change a tool result because logging failed. */ }
}


let supported;
const UNSUPPORTED = () => t('cmd.unsupported');
async function platformReady($) {
  if (supported === undefined) {
    supported = await platformSupported($);
    if (!supported) { try { await $.ui.log(UNSUPPORTED()); } catch { /* The notice is best effort. */ } }
  }
  return supported;
}

async function collecting($) {
  if (!await platformReady($)) return false;
  try { return await observing($); }
  catch { await warn($); return true; } // Observe failures never alter tool execution.
}

function offerKey(input) {
  return canonical([input.subagentType || input.agent || '', input.provider || null]);
}

async function recordChecklist($, ctx, key, op) {
  const result = await saveChecklist($, ctx, key, op);
  if (ctx.preferences.progressSounds && result.chime) chime($, result.chime);
  const summary = checklistSummary(result);
  await refreshStatus($, ctx);
  return summary;
}

async function summary($, cleanup = false) {
  const ctx = await context($);
  const pruned = cleanup ? await pruneProject($, ctx) : null;
  const {events,invalid,parts,removed} = await readProject($, ctx, cleanup);
  const state = replay(events);
  const mode=(await currentEnforcement($,ctx)).mode;
  const counts = statusCounts(await disciplineState($, ctx, true), reduceReviews(events, ctx.projectId));
  const lines = [t('cmd.status', { mode, events: state.eventCount, runs: state.runs.length, calls: state.toolCalls.length,
    invalid: invalid.length, conflicts: state.conflicts.length, parts: parts.length, ...counts, failures })];
  if (cleanup) lines.push(t('cmd.cleanup', { parts: removed + (pruned.parts || 0), days: RETENTION_DAYS,
    removed: `${pruned.removed}${pruned.skipped ? ` (${pruned.skipped})` : ''}` }));
  return lines.join('\n');
}

/** @type {import('claude-code').Register} */
export const register = (on, options = {}) => {
  let stream = null;
  setMasterEnabled(options.enabled);
  setLanguage(options.language);
  setSounds(options.sounds);
  registerRulesPane(on,()=>failures);
  registerBand(on);
  on('session.start', async ($, e, next) => {
    try { if (!['en', 'vi'].includes(options.language)) setLanguage('auto', await $.env.get('LC_ALL') || await $.env.get('LANG') || ''); }
    catch { /* English stays the fallback. */ }
    try {
      await $.command.register({ name: 'arbiter', description: 'Open Agent Arbiter settings and controls', argumentHint: 'open panel | update | off | help', immediate: true });
      if (!await collecting($)) return next(e);
      const ctx = await context($);
      if (ctx.preferences.checklist) {
        try { await registerChecklistTool($); } catch { /* Task progress is optional. */ }
      }
      await emit($, ctx, null, 'session.start', boot, {
        progress: 1,
        mode: (await currentEnforcement($,ctx)).mode, engineVersion: redact((await $.session.version()).version),
        model: redact(await $.session.model()), git: await gitSnapshot($, ctx.root) });
      // Daily upkeep in the background: old routine records and stale part files.
      void maintain($, ctx);
      void refreshStatus($, ctx);
    } catch { await warn($); }
    return next(e);
  });

  on('agent.offer', async ($, e, next) => {
    if (!await collecting($)) return next(e);
    offers.set(offerKey(e), { source: e.source, provider: e.provider });
    return next(e);
  }).catch(($,e,next)=>next.called?next(e):armed()?{isOffered:false}:next(e));

  on('agent.spawn', async ($, e, next) => {
    if (!await collecting($)) return next(e);
    let ctx, identity = null, spawnPolicy;
    const originalInput=e;
    const actor = e.parentAgentId || null;
    const attempt = `${e.tool_use_id || 'unlinked'}:${boot}:${++sequence}`;
    try {
      ctx = await context($);
      identity = await citizen($, ctx.root, (await $.session.version()).version, e, offers.get(offerKey(e)), null);
      spawnPolicy=await enforceSpawn($,ctx,e,identity);
      if(spawnPolicy.deny)return spawnPolicy;
      e=spawnPolicy.input;
      if(spawnPolicy.replacement?.blockedModels)beginReplacement(ctx,attempt);
      await emit($, ctx, actor, 'spawn.request', attempt, { spawnAttemptId: attempt, toolCallId: e.tool_use_id || null,
        agentType: redact(e.subagentType), resumeAgentId: e.resume?.agentId || null, citizen: identity,
        git: await gitSnapshot($, ctx.root), idScope: 'hook-invocation' });
    } catch {
      await warn($);
      if(armed()){endReplacement(ctx,attempt);return {deny:'Agent Arbiter: spawn supervision unavailable.'};}
    }
    let result;
    try { result = await next(e); }
    catch (error) {
      endReplacement(ctx,attempt);
      try { if (ctx) await emit($, ctx, actor, 'spawn.result', attempt, { spawnAttemptId: attempt, childAgentId: null, status: 'exception', citizen: null }); } catch { await warn($); }
      throw error;
    }
    try {
      if (ctx) {
        // Use the definition observed before starting, so a concurrent edit cannot rebind it.
        if (identity && !result.deny) {
          identity = await bindCitizen(identity, ctx.projectId, result.model);
        }
        const modelVerified=(!spawnPolicy?.expectedModel || result.model===spawnPolicy.expectedModel) && replacementAllowed(spawnPolicy?.replacement,identity?.resolvedModel);
        if(!modelVerified && spawnPolicy?.replacement?.blockedModels)rejectReplacement(ctx,result.agentId,e.tool_use_id);
        try{await emit($, ctx, actor, 'spawn.result', attempt, { spawnAttemptId: attempt,
          childAgentId: result.agentId || null, status: result.deny ? 'denied' : 'started', citizen: result.deny ? null : identity,
          modelVerified,probationFrom:spawnPolicy?.probationFrom || [],
          reservationIds:spawnPolicy?.reservationIds || [],reservationClaim:spawnPolicy?.reservationClaim || null,
          ...(spawnPolicy?.replacement?{replacement:spawnPolicy.replacement}:{}),
          ...(spawnPolicy?.lessons?.length?{lessons:spawnPolicy.lessons}:{}),...(spawnPolicy?.lessonsHeldOut?{lessonsHeldOut:true}:{}),
          ...(typeof originalInput.prompt==='string' && !originalInput.resume?{profile:briefProfile(originalInput.prompt)}:{}) });}catch{await warn($);}
        if(result.agentId && !result.deny){
          void refreshStatus($,ctx);
          rememberCitizen(ctx,result.agentId,identity);
          rememberBrief(ctx,result.agentId,originalInput,identity);
          rememberSpawn(ctx,result.agentId,{input:originalInput,identity,offer:offers.get(offerKey(e))});
          if(!modelVerified){
            let history=[];try{history=(await readProject($,ctx)).events;}catch{await warn($);}
            const stopped=await stopForHandover($,ctx,result.agentId,history);
            await emit($,ctx,result.agentId,'replacement.rejected',attempt,{reason:'actual-model-mismatch',...stopped});
          }
        }
      }
    } catch { await warn($); }
    finally{endReplacement(ctx,attempt);}
    return result;
  }).catch(($,e,next)=>next.called?next(e):armed()?{deny:'Agent Arbiter spawn gate failed.'}:next(e));

  on('tool.call', async ($, e, next) => {
    if (!await collecting($)) return next(e);
    let ctx, requestId;
    const actor = e.agentId || null;
    const key = e.tool_use_id || `${boot}:${++sequence}`;
    const data = { tool: redact(e.tool), toolCallId: e.tool_use_id || null };
    try{ctx=await context($);}catch{await warn($);}
    if (e.tool === CHECKLIST_TOOL) {
      if (!ctx?.preferences.checklist || actor || (next.origin?.plugin && next.origin.plugin !== 'engine')) return { deny: 'This session has no main-thread checklist reporting access.' };
      try {
        const updated = await recordChecklist($, ctx, key, reportedOperation(e));
        return { result: `${updated.completed}/${updated.total}` };
      } catch (error) { return { deny: String(error.message || 'Checklist update unavailable.').slice(0, 140) }; }
    }
    const probe=ctx?consumeRuntimeProbe(ctx,e,next.origin,$.plugin.name):null;
    if(probe){
      let result;
      try{result=await next(e);}catch(error){
        try{await completeRuntimeProbe($,ctx,probe,{isError:true});}catch{ /* Preserve the original tool failure. */ }
        throw error;
      }
      let status;
      try{status=await completeRuntimeProbe($,ctx,probe,result);}
      catch{status={ready:false,reason:'Probe verification/cleanup outcome unconfirmed; inspect runtime status.'};}
      return {...result,context:'Agent Arbiter runtime probe: '+canonical(status)};
    }
    try {
      if(!ctx)ctx=await context($);
      if(!actor)data.turnId=mainTurnId(ctx);
      data.head = await gitHead($, ctx.root);
      data.inputHash = await digest(canonical(JSON.parse(JSON.stringify(e))));
      if (typeof e.command === 'string') {
        // Arguments can contain arbitrary secrets; retain only safe executable text.
        const executable = e.command.trim().match(/^[A-Za-z0-9_./-]+/);
        data.command = executable ? `${redact(executable[0])} [arguments redacted]` : '[redacted]';
      }
      if (['Write', 'Edit', 'NotebookEdit'].includes(e.tool)) {
        const path = e.file_path || e.notebook_path;
        if (typeof path === 'string') data.file = await fileMetadata(ctx.root, path, $, ctx.sessionRoot);
      }
      if(data.file)data.environment='local';
      const classification=e.tool==='Bash'?{kind:'unknown'}:classifyTool(e,{...ctx,environment:'local',file:data.file});
      if(classification.kind==='action')data.action=classification.request;
      requestId=await emit($, ctx, actor, 'tool.request', key, data);
    } catch { await warn($); }
    if(ctx){
      const denied=await enforceTool($,ctx,e,data,requestId);
      if(denied){
        try{await emit($,ctx,actor,'tool.result',key,{...data,status:'denied',court:true});}catch{await warn($);}
        noteActivity(ctx,actor,{tool:e.tool,target:data.file?.path ?? data.command,status:'denied'},data.turnId);
        return denied;
      }
      const enforcement=e.tool==='SubagentHandback' && typeof e.message==='string'?await currentEnforcement($,ctx):null;
      if(enforcement?.mode==='enforce' && enforcement.hardened){
        const sentence=actorSentence((await readProject($,ctx)).events,ctx,actor);
        if(sentence.caseIds.length)e={...e,message:e.message+'\n[Agent Arbiter active cases: '+sentence.caseIds.slice(0,8).join(', ')+'. Use /arbiter docket for evidence and appeal.]'};
      }else if(enforcement?.mode==='enforce' && actor){
        // The lead reads the handback: tell it what the Arbiter did to this agent.
        const note=await handbackNoteFor($,ctx,actor);
        if(note)e={...e,message:e.message+note};
      }
    }else if(armed())return {deny:'Agent Arbiter context unavailable.'};
    else if(!courtDisabled() && fallbackTool(e))return fallbackTool(e);
    let check = null;
    if (ctx && e.tool === 'Bash') {
      let cwd = ctx.root;
      try { cwd = await $.session.cwd() || cwd; } catch { /* Older engine or fixture. */ }
      try { check = await verificationCheck(e.command, [ctx.checkoutId, cwd]); }
      catch { /* Optional history metadata. */ }
    }
    const finish = ctx && actor ? beginActivity($, ctx, actor, key, 'tool', data.tool) : null;
    const prompt = !actor && (e.tool === 'AskUserQuestion' ? 'question' : e.tool === 'ExitPlanMode' ? 'plan' : null);
    const settle = ctx && prompt && next.origin?.plugin !== $.plugin.name ? beginWait($, ctx, actor, key, prompt) : null;
    let result;
    try { result = await next(e); }
    catch (error) {
      try { if (ctx) await emit($, ctx, actor, 'tool.result', key, { ...data, status: 'exception' }); } catch { await warn($); }
      throw error;
    } finally {
      finish?.();
      if (settle) await settle();
      if (check && result?.deny === undefined) {
        const outcome = verificationOutcome(check, result);
        try {
          const previous = outcome === 'failed' && ctx.preferences.progressSounds ?
            (await readProjectShared($, ctx)).events.findLast(event => event.kind === 'progress.check' &&
              event.sessionId === ctx.sessionId && event.data.key === check.key && event.data.outcome !== 'unknown') : null;
          await emit($, ctx, actor, 'progress.check', key, { ...check, outcome });
          if (outcome === 'failed' && ctx.preferences.progressSounds && previous?.data.outcome !== 'failed') chime($, 'check-failed');
        }
        catch { /* The original result is authoritative. */ }
        void refreshStatus($, ctx);
      }
    }
    if(ctx)noteActivity(ctx,actor,{tool:e.tool,target:data.file?.path ?? data.command,status:result.deny?'denied':result.isError?'error':'completed'},data.turnId);
    // A spawn the Arbiter moved to another model: say so to whoever started it.
    const spawnNote=e.tool_use_id && !result.deny?takeSpawnNote(e.tool_use_id):null;
    if(spawnNote)result={...result,context:[...(Array.isArray(result.context)?result.context:[]),spawnNote]};
    try { if (ctx) await emit($, ctx, actor, 'tool.result', key, { ...data,
      head: await gitHead($, ctx.root), outputHash: await digest(canonical(JSON.parse(JSON.stringify(result)))),
      exitCode: Number.isInteger(result.result?.exitCode) ? result.result.exitCode : null,
      exitCodeStatus: Number.isInteger(result.result?.exitCode) ? 'reported' : 'unavailable',
      status: result.deny ? 'denied' : result.isError ? 'error' : 'completed' }); } catch { await warn($); }
    if (ctx?.preferences.checklist && !actor && NATIVE_TASKS.has(e.tool)) {
      try {
        const op = await nativeOperation(e, result);
        if (op) await recordChecklist($, ctx, key, op);
      } catch { /* Leave the original native task operation intact. */ }
    }
    return result;
  }).catch(($,e,next)=>next.called?next(e):armed()?{deny:'Agent Arbiter hardened tool gate failed; execution refused.'}:(courtDisabled()?next(e):(fallbackTool(e) || next(e))));

  on('turn.start', async ($, e, next) => {
    if(!e.agentId){
      stream = null;
      if (await collecting($)) {
        try {
          const ctx = await context($);
          rememberMainTurn(ctx, e);
          if (ctx.preferences.outputSpeed) stream = { ctx, id: e.turnId };
        } catch { await warn($); }
      }
    }
    return next(e);
  });

  on('tool.list', async ($, e, next) => {
    const result = await next(e);
    if (!result.value?.some(tool => tool.name === CHECKLIST_TOOL)) return result;
    try {
      const ctx = await context($);
      if (ctx.preferences.checklist && ctx.preferences.mode !== 'off' && !courtDisabled()) return result;
    } catch { /* Hide the optional tool when its preference is unavailable. */ }
    return { ...result, value: result.value.filter(tool => tool.name !== CHECKLIST_TOOL) };
  });

  on('turn.step', async function* ($, e, next) {
    if (e.agentId || !stream || stream.id !== e.turnId) return yield* next(e);
    const { ctx } = stream, source = next(e);
    let first = null, last = null, finished = false;
    try {
      for (;;) {
        const chunk = await source.next();
        if (chunk.done) {
          finished = true;
          return chunk.value;
        }
        const part = chunk.value;
        if (['text', 'thinking', 'tool', 'input'].includes(part.kind)) {
          last = Date.now();
          first ??= last;
        } else if (part.kind === 'stop' && first !== null && last > first) {
          recordOutputRate($, ctx, part.usage?.output_tokens, last - first);
        }
        yield part;
      }
    } finally {
      if (!finished) {
        try { await source.return?.(); } catch { /* Preserve the original cancellation. */ }
      }
    }
  });

  on('turn.complete', async ($, e, next) => {
    if (!await collecting($)) return next(e);
    let ctx;
    try {
      ctx = await context($);
      endedTurn(ctx,e.agentId || null);
      await endActorActivity($,ctx,e.agentId || null);
      const usage = {};
      for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
        const value = e.usage?.[key];
        if (Number.isFinite(value) && value >= 0) usage[key] = value;
      }
      await emit($, ctx, e.agentId || null, 'turn.complete', e.turnId || `${boot}:${++sequence}`, {
        turnId: e.turnId || null, reason: redact(e.reason), isAborted: e.isAborted === true, durationMs: e.durationMs,
        usage, model: e.usage?.model ? redact(e.usage.model) : null,
        transcript: await transcriptCoverage($, e.agentId), git: await gitSnapshot($, ctx.root) });
    } catch { await warn($); }
    // The judge reviews in the background: the turn is handed back without waiting.
    if (ctx) void refreshStatus($, ctx);
    if (ctx) void judgeRun($, ctx, e).then(review => review ? refreshStatus($, ctx) : null);
    return next(e);
  });

  on('command.run', { command: 'arbiter' }, async ($, e) => {
    if (!await platformReady($)) return { text: UNSUPPORTED() };
    const answer = await handleCourt($, e);
    if (answer) return answer;
    if (!['', 'status', 'verify', 'cleanup'].includes(e.args.trim())) return { text: t('settings.help') };
    try { return { text: await summary($, e.args.trim() === 'cleanup') }; }
    catch { await warn($); return { text: 'Agent Arbiter: ledger unavailable; no integrity result can be reported.' }; }
  });
};
