import {t} from './i18n.js';
import {loadProjectSettings,saveProjectSettings,updateProjectSettings} from './project-rules.js';
import {openRulesPane} from './rules-pane.js';
import { profileRuntime, bootstrapRuntime, probeRuntime, runtimeReady, hardLawBackup, inspectRuntime } from './runtime.js';
import { handleCaseCommand } from './court.js';
import { canonical, digest, replay } from './ledger.js';
import { observationContext, configRoot } from './context.js';
import { emit, readProject, quarantineProject } from './events.js';
import { normalizeGrant, reduceGrants } from './grants.js';
import { compileRules, evaluate } from './statutes.js';
import { sentencing } from './sentencing.js';
import { disciplineState, docket, docketText, releaseViolations } from './discipline.js';
import {changeProjectMode,purgeData} from './panel-actions.js';
import {modes,enforcedSessions,courtDisabled,setEmergencyOff,emergencyStopped} from './control-state.js';
export {setMasterEnabled,courtDisabled,enforcementArmed} from './control-state.js';
import { refreshStatus } from './status.js';
import { reduceScores, scoreTable } from './scoring.js';
import { projectLessons, lessonEffects, lessonTable, shareLessons, unshareLessons, loadLibrary, experimentResults } from './lessons.js';
import { allProjectScores } from './scoring.js';
import { ROLES, roleOf } from './roles.js';
import { reduceReviews, judgeUsage, reviewTable, decideFinding, decideExemplar } from './judge.js';
import { updatePlugin } from './update.js';

const staleSources = new Set();
const HUMAN = new Set(['composer', 'bridge']);
// Default mode needs only the first line. The second belongs to the optional
// hardened runtime and its signed case ledger.
const USAGE = 'Usage: /arbiter rules | status | mode enforce|observe|off | docket | release <violation-id> [reason] | release all | citizens [all] | role <agent-type> <role>|auto | lessons [on|off|share <id>|all|unshare <id>|all|library|experiment on|off] | judge [on|off] | finding <ref> confirm|dismiss | exemplar <ref> approve|reject | cleanup | purge [all] | update | quarantine | verify | evidence <event-id> | help\nExperimental hardened runtime: /arbiter runtime profile|inspect|probe|bootstrap|status | mode hardened <JSON> | grant <JSON> | request <JSON> | grants | revoke <id> | laws | laws approve <JSON> | check <JSON> | record <citizen-id> | verdict <JSON> | appeal <case-id> [JSON] | pardon <case-id> [reason]';
function reply(value) { return { text: typeof value === 'string' ? value : canonical(value) }; }
function key(ctx) { return `${ctx.projectId}:${ctx.sessionId}`; }
function trusted(e) { return HUMAN.has(e.origin?.kind); }
function sorted(events) { return [...events].sort((a,b)=>a.occurredAt-b.occurredAt || a.id.localeCompare(b.id)); }
function modeFrom(events, ctx) {
  const entries = sorted(events).filter(e=>e.kind==='court.mode' && e.sessionId===ctx.sessionId && HUMAN.has(e.data.source?.origin));
  const mode=entries.at(-1)?.data.mode;
  return mode==='off'?'off':ctx.signer && mode==='enforce'?'enforce':'observe';
}
export async function currentEnforcement($,ctx) {
  if(courtDisabled())return {mode:'off'};
  const active=enforcedSessions.get(ctx.sessionId);
  if(active && active.projectId!==ctx.projectId)return {...active,hardened:true,bindingMismatch:true};
  const preferences=await loadProjectSettings($,ctx);
  if(!preferences.hardened || preferences.mode!=='enforce')return {mode:preferences.mode,hardened:false};
  if(ctx.authConfigured && (ctx.authError || !ctx.signer))return {mode:'enforce',hardened:true,bindingMismatch:true,unconfirmed:true};
  if(active)return {...active,hardened:true,bindingMismatch:active.anchor!==ctx.anchor};
  const k=key(ctx);
  if(!modes.has(k)){
    const read=await readProject($,ctx);
    if(ctx.authConfigured && (read.invalid.length || replay(read.events).conflicts.length))return {mode:'enforce',hardened:true,bindingMismatch:true,unconfirmed:true};
    modes.set(k,modeFrom(read.events,ctx));
    if(modes.get(k)==='enforce' && !read.invalid.length){
      const event=sorted(read.events).filter(e=>e.kind==='court.mode' && e.sessionId===ctx.sessionId && HUMAN.has(e.data.source?.origin)).at(-1);
      if(event?.data.policy && event.data.binding){
        const value={mode:'enforce',policy:event.data.policy,...event.data.binding};
        enforcedSessions.set(ctx.sessionId,value);
        return {...value,hardened:true,bindingMismatch:value.projectId!==ctx.projectId || value.anchor!==ctx.anchor};
      }
      return {mode:'enforce',hardened:true,bindingMismatch:true};
    }
  }
  return {mode:modes.get(k) || 'observe',hardened:true};
}

export async function observing($) {
  if(courtDisabled())return false;
  const ctx=await observationContext($);
  return (await currentEnforcement($,ctx)).mode!=='off';
}

export async function approvedRules($, ctx, events) {
  const approvals = new Map();
  // Legacy withdrawal claims can reduce availability, never silently remove a deny.
  const held = new Set(events.filter(e=>['laws.withdrawn','laws.held'].includes(e.kind)).map(e=>e.data.approvalId));
  for (const event of sorted(events)) {
    if (event.kind==='laws.approved' && HUMAN.has(event.data.source?.origin)) approvals.set(event.data.document.path, event);
  }
  const rules = [], inactive = [], holds = [];
  for (const event of approvals.values()) {
    const data = event.data;
    let current = null;
    try { current = await digest(await $.fs.read(data.document.path)); } catch { /* Unreadable source cannot grant authority. */ }
    const staleKey=`${ctx.projectId}:${event.id}`;
    if (held.has(event.id) || current !== data.document.version) staleSources.add(staleKey);
    if (staleSources.has(staleKey) && !held.has(event.id)) {
      // Protective observation only: it cannot grant or withdraw a denial. Persist
      // before returning a decision so restoring bytes after restart cannot reopen it.
      await emit($,ctx,null,'laws.held',event.id,{approvalId:event.id,reason:'source-pending-human-review'});
    }
    if (staleSources.has(staleKey)) {
      inactive.push({approvalId:event.id,reason:'source-pending-human-review'});
      holds.push(...data.rules);
      rules.push(...data.rules.filter(rule=>rule.effect==='deny'));
      continue;
    }
    rules.push(...data.rules);
  }
  const compiled=await compileRules(rules);
  return {...compiled,version:await digest(canonical([compiled.version,holds])),inactive,holds};
}

export function checkCurrentPolicy(request, grants, laws, ctx, now) {
  const matches=rule=>rule.action===request?.action && (rule.target===null || rule.target===request?.target) &&
    (rule.environment===null || rule.environment===request?.environment);
  const priority=Math.max(-Infinity,...laws.rules.filter(matches).map(rule=>rule.priority));
  const hold=laws.holds.filter(matches).sort((a,b)=>b.priority-a.priority || a.id.localeCompare(b.id))[0];
  if (hold && hold.priority>=priority) return {outcome:'deny',reason:'law-source-pending-review',lawId:hold.id,grantId:null,violation:false};
  return evaluate(request,grants,laws.rules,ctx,now);
}

async function approveLaws($, ctx, input, source) {
  if (input.source!==undefined && !['global','project','user'].includes(input.source)) throw new Error('Unknown law source');
  const global = input.source === 'global';
  const kind = global ? 'global' : input.source === 'user' ? 'user' : 'project';
  const relative = input.path || 'CLAUDE.md';
  if (typeof relative!=='string' || relative.includes('\0') || relative.includes('..') || relative.startsWith('/') || !relative.endsWith('.md')) throw new Error('Expected project-relative markdown source');
  const base = global ? await configRoot($) : ctx.projectRoot;
  if (global && relative!=='CLAUDE.md') throw new Error('Global source must be CLAUDE.md');
  const path = `${base}/${relative}`;
  const info = await $.fs.stat(path,{resolve:true});
  const resolvedBase = (await $.fs.stat(base,{resolve:true})).realPath || base;
  if (info.kind!=='file' || !info.realPath?.startsWith(resolvedBase+'/')) throw new Error('Law source escapes its approved directory');
  const version = await digest(await $.fs.read(path));
  if (!Array.isArray(input.rules) || !input.rules.length || input.rules.length>100) throw new Error('Expected 1-100 explicit rules');
  const custom = input.rules.map((rule,index)=>({...rule,id:`${kind}:${relative}:${index}`,source:{kind,id:relative},version,priority:global?20:kind==='user'?40:30}));
  const compilation = await compileRules(custom);
  await emit($,ctx,null,'laws.approved',source.id,{source,document:{path,version},rules:custom});
  return {approved:true,version,ruleCount:custom.length,compilationVersion:compilation.version};
}

export async function handleCourt($, e) {
  const args = e.args.trim();
  const split = args.indexOf(' ');
  const command = split<0 ? args : args.slice(0,split);
  const body = split<0 ? '' : args.slice(split+1).trim();
  const mutation = ['off','mode','grant','request','revoke','release','role','finding','exemplar','purge','update'].includes(command) || (command==='judge' && ['on','off'].includes(body)) || (command==='lessons' && /^(on|off|share|unshare|experiment)(\s|$)/.test(body)) || (command==='laws' && body.startsWith('approve')) || ['cleanup','quarantine'].includes(command) || (command==='runtime' && !body.startsWith('profile') && !['status','inspect'].includes(body));
  if (mutation && !trusted(e)) return reply(t('cmd.human'));
  // Emergency switch takes effect even when context or disk is unavailable.
  if (command==='off' || (command==='mode' && body==='off')) setEmergencyOff(true);
  try {
    // Needs no project: it updates the installed plugin itself.
    if(command==='update')return reply(await updatePlugin($));
    const ctx = await observationContext($,{recoverPreferences:command==='' || command==='rules',authentication:command==='runtime' || command==='mode' && (body.startsWith('hardened') || body.startsWith('enforce '))});
    const source = {kind:'command',origin:e.origin?.kind || 'unclassified',id:crypto.randomUUID()};
    if(command==='' || command==='rules'){
      try{const opened=await openRulesPane($,ctx,command===''?'inbox':'rules');return reply(opened.isPlaced?t('pane.opened'):t('pane.waiting',{reason:opened.reason || ''}));}
      catch(error){return reply('Rules pane unavailable: '+String(error?.message || error).slice(0,400));}
    }
    if(command==='quarantine')return reply(await quarantineProject($,ctx));
    if(command==='help')return reply(body==='advanced'?USAGE.split('\n')[1]:body==='commands'?USAGE.split('\n')[0]:t('settings.help'));
    if(command==='purge'){
      if(!['','all'].includes(body))return reply(USAGE);
      return reply((await purgeData($,ctx,body==='all')).text);
    }
    if(command==='citizens' && body==='all')return reply(await allProjectScores($,ctx));
    if(command==='citizens'){
      const settings=await loadProjectSettings($,ctx);
      const events=(await readProject($,ctx)).events;
      return reply(scoreTable(reduceScores(events,ctx.projectId,await disciplineState($,ctx,true),settings.roles,reduceReviews(events,ctx.projectId))));
    }
    if(['judge','findings','finding','exemplar'].includes(command)){
      const settings=await loadProjectSettings($,ctx);
      if(command==='judge' && ['on','off'].includes(body)){
        await updateProjectSettings($,ctx,latest=>({...latest,judge:body==='on'}));
        return reply(t('cmd.judgeSwitch',{state:t('cmd.'+body)}));
      }
      const events=(await readProject($,ctx)).events,reviews=reduceReviews(events,ctx.projectId);
      if(command==='finding' || command==='exemplar'){
        const [ref,verb]=body.split(/\s+/);
        const decision={confirm:'confirmed',dismiss:'dismissed',approve:'approved',reject:'rejected'}[verb];
        const evidenceId=command==='finding'?await decideFinding($,ctx,reviews,ref,decision,source):await decideExemplar($,ctx,reviews,ref,decision,source);
        if(!evidenceId)return reply(t(command==='finding'?'cmd.findingUsage':'cmd.exemplarUsage'));
        await refreshStatus($,ctx);
        return reply(t('cmd.decided',{ref,decision}));
      }
      if(body)return reply(USAGE);
      return reply(reviewTable(reviews,judgeUsage(events,ctx.projectId),settings.judge));
    }
    if(command==='role'){
      const [name,role]=body.split(/\s+/);
      if(!name || !(role==='auto' || ROLES.includes(role)))return reply(t('cmd.roleUsage',{roles:ROLES.join('|')}));
      let roles;
      await updateProjectSettings($,ctx,latest=>{roles={...latest.roles};if(role==='auto')delete roles[name];else roles[name]=role;return {...latest,roles};});
      return reply(t(role==='auto'?'cmd.roleAuto':'cmd.role',{name,role:roleOf(name,roles)}));
    }
    if(command==='lessons'){
      const settings=await loadProjectSettings($,ctx);
      if(['experiment on','experiment off'].includes(body)){
        const on=body.endsWith('on');
        await updateProjectSettings($,ctx,latest=>({...latest,lessonExperiment:on}));
        return reply(t('cmd.experimentSwitch',{state:t(on?'cmd.on':'cmd.off')}));
      }
      if(['on','off'].includes(body)){
        await updateProjectSettings($,ctx,latest=>({...latest,lessons:body==='on'}));
        return reply(t('cmd.lessonsSwitch',{state:t('cmd.'+body)}));
      }
      if(body==='library'){
        const library=await loadLibrary($,ctx);
        return reply(library.length?[t('cmd.libraryHead'),...library.map(entry=>`${entry.id} · ${entry.agentName} (${entry.role}) · ${entry.text}`)].join('\n'):t('cmd.libraryNone'));
      }
      if(body.startsWith('unshare')){
        const removed=await unshareLessons($,ctx,body.slice('unshare'.length).trim());
        return reply(removed.length?t('cmd.unshared',{count:removed.length}):t('cmd.unshareNone'));
      }
      const lessons=await projectLessons($,ctx,settings);
      if(body.startsWith('share')){
        const wanted=body.slice('share'.length).trim();
        const chosen=wanted==='all'?lessons:lessons.filter(lesson=>wanted.length>=4 && lesson.id.startsWith(wanted));
        if(!chosen.length)return reply(t('cmd.lessonNone'));
        const added=await shareLessons($,ctx,chosen);
        return reply(added.length?t('cmd.shared',{count:added.length}):t('cmd.sharedNone'));
      }
      if(body)return reply(USAGE);
      const events=(await readProject($,ctx)).events,discipline=await disciplineState($,ctx);
      const experiment=settings.lessonExperiment || events.some(event=>event.kind==='spawn.result' && event.data?.lessonsHeldOut)?experimentResults(events,ctx.projectId,discipline):null;
      return reply(lessonTable(lessons,lessonEffects(events,ctx.projectId,lessons,discipline),settings.lessons,experiment));
    }
    // Default mode keeps violations, not signed cases: release one here.
    if(command==='release' && !(await loadProjectSettings($,ctx)).hardened){
      const state=await disciplineState($,ctx,true);
      const active=state.violations.filter(record=>record.status==='active');
      const space=body.indexOf(' '),wanted=space<0?body:body.slice(0,space),reason=space<0?null:body.slice(space+1).trim();
      const ids=wanted==='all'?active.map(record=>record.id):active.filter(record=>wanted.length>=8 && record.id.startsWith(wanted)).map(record=>record.id);
      if(!ids.length)return reply(t('cmd.releaseNone'));
      await releaseViolations($,ctx,ids,source,reason);
      await refreshStatus($,ctx);
      return reply(t('cmd.released',{count:ids.length}));
    }
    if(command==='mode' && ['enforce','observe','off'].includes(body) || command==='off'){
      const mode=command==='off'?'off':body;
      await changeProjectMode($,ctx,mode);
      return reply({mode,hardened:false,scope:'project'});
    }
    if(command==='runtime'){
      if(body==='profile' || body.startsWith('profile '))return reply(await profileRuntime($,ctx,body==='profile'?{}:JSON.parse(body.slice(8))));
      if(body==='bootstrap')return reply(await bootstrapRuntime($,ctx,e.origin));
      if(body==='probe')return reply(await probeRuntime($,ctx));
      if(body==='inspect')return reply(await inspectRuntime($,ctx));
      if(body==='status')return reply({...await runtimeReady($,ctx),authConfigured:ctx.authConfigured,authenticated:!!ctx.signer});
      return reply('Usage: /arbiter runtime profile|bootstrap|probe|status');
    }
    if(command==='mode' && (body.startsWith('enforce ') || body.startsWith('hardened'))){
      const ready=await runtimeReady($,ctx);
      if(!ctx.signer || !ready.ready)return reply('Phase 4 protected runtime not ready: '+(ready.reason || 'anchored proof required'));
      let policy;try{policy=JSON.parse(body.slice(body.startsWith('hardened')?'hardened'.length:'enforce'.length).trim());}catch{return reply('Explicit enforce policy and host attestation required.');}
      if(!Number.isSafeInteger(policy.finePoints) || policy.finePoints<=0 || policy.grantsOnly!==true || policy.trustedHost!==true || policy.noOutsideWriters!==true ||
        !Array.isArray(policy.replacementModels) || !policy.replacementModels.length || policy.replacementModels.some(model=>typeof model!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{3,200}$/.test(model) || ['haiku','sonnet','opus','inherit','default'].includes(model)))return reply('Explicit enforce policy and host attestation required.');
      const read=await readProject($,ctx);
      if(read.invalid.length || replay(read.events).conflicts.length)return reply('Authenticated ledger integrity unavailable; activation refused.');
      if(!await hardLawBackup($,ctx,(await approvedRules($,ctx,read.events)).rules))return reply('Engine deny backup missing for approved hard laws.');
      const binding={projectId:ctx.projectId,anchor:ctx.anchor,fingerprint:ready.fingerprint};
      await emit($,ctx,null,'court.mode',source.id,{mode:'enforce',source,policy,binding});
      await saveProjectSettings($,ctx,{...await loadProjectSettings($,ctx),mode:'enforce',hardened:true});
      modes.set(key(ctx),'enforce');enforcedSessions.set(ctx.sessionId,{mode:'enforce',policy,...binding});
      return reply({mode:'enforce',scope:'same-session hard laws',authenticated:true});
    }

    if (command==='off' || (command==='mode' && ['observe','off'].includes(body))) {
      const mode = command==='off' || body==='off' ? 'off' : 'observe';
      if (mode==='observe') setEmergencyOff(false);
      modes.set(key(ctx),mode);
      enforcedSessions.delete(ctx.sessionId);
      try { await emit($,ctx,null,'court.mode',source.id,{mode,source}); }
      catch { return reply(`Arbiter ${mode} in this process; persistence failed, session restart may reset mode.`); }
      return reply(`Arbiter ${mode} for this session.`);
    }
    if (['','status','verify','cleanup'].includes(command)) return null;
    const read = await readProject($,ctx);
    const conflicts = replay(read.events).conflicts;
    if (command==='evidence') {
      if (!/^[a-f0-9]{64}$/.test(body)) return reply('Expected exact event ID (64 lowercase hex).');
      const matches=read.events.filter(event=>event.id===body);
      const disputed=conflicts.some(c=>c.id===body || c.targetId===body || c.requestIds?.includes(body) || c.resultIds?.includes(body));
      const integrity={invalidCount:read.invalid.length,conflictCount:conflicts.length,disputed};
      return reply(matches.length===1 ? {...matches[0],integrity} : {found:matches.length>0,variants:matches,integrity});
    }
    const caseAnswer=await handleCaseCommand($,e,ctx,read,command,body);
    // `docket cases` lists the signed case ledger of the experimental hardened runtime.
    if (command==='docket' && body!=='cases' && !(await loadProjectSettings($,ctx)).hardened) return reply(docketText(await disciplineState($,ctx,true)));
    if (caseAnswer && command==='docket' && !(await loadProjectSettings($,ctx)).hardened) {
      // Default mode records violations beside any cases from the hardened ledger.
      try { return reply({...JSON.parse(caseAnswer.text),violations:docket(await disciplineState($,ctx,true))}); }
      catch { return caseAnswer; }
    }
    if (caseAnswer) return caseAnswer;
    if (read.invalid.length || conflicts.length) return reply('Ledger integrity unavailable; no authority decision can be made.');
    if (command==='grants') return reply({grants:reduceGrants(read.events).filter(g=>g.projectId===ctx.projectId && g.sessionId===ctx.sessionId)});
    if (command==='grant' || command==='request') {
      const input = JSON.parse(body);
      const now=Date.now();
      const candidate={...input,id:crypto.randomUUID(),expiresAt:input.expiresAt??now+86400000,scope:input.scope??{kind:'session',id:ctx.sessionId}};
      let grant=normalizeGrant(candidate,ctx,source,now);
      if (!grant) return reply('Invalid grant: exact action/target/environment/scope and future expiry required.');
      if (command==='request') {
        let answer='';
        try { answer=await $.ui.ask(`Allow ${grant.action} on ${grant.target} in ${grant.environment}, project ${ctx.projectRoot}, session ${ctx.sessionId}, actor ${grant.agentId || 'all agents in scope'}, scope ${grant.scope.kind}:${grant.scope.id}, until ${new Date(grant.expiresAt).toISOString()}?`,['Deny','Allow']); }
        catch { /* Dismissed/unavailable/no answer never authorizes. */ }
        if (answer!=='Allow') { await emit($,ctx,null,'grant.declined',source.id,{source}); return reply({granted:false}); }
        grant=normalizeGrant(grant,ctx,{...source,kind:'ui'},Date.now());
        if (!grant) return reply({granted:false,reason:'expired-during-consent'});
      }
      const evidenceId=await emit($,ctx,null,'grant.created',source.id,{grant});
      return reply({grantId:grant.id,granted:true,evidenceId});
    }
    if (command==='revoke') {
      const grant=reduceGrants(read.events).find(g=>g.id===body && g.projectId===ctx.projectId && g.sessionId===ctx.sessionId);
      if (!grant) return reply('Grant not found in this session.');
      await emit($,ctx,null,'grant.revoked',source.id,{grantId:body,source});
      return reply({revoked:body});
    }
    if (command==='laws') {
      if (body.startsWith('approve ')) {
        const input=JSON.parse(body.slice(8));
        if((await currentEnforcement($,ctx)).mode==='enforce' && !await hardLawBackup($,ctx,input.rules || []))return reply('Engine deny backup required before approving hard laws in enforce.');
        return reply(await approveLaws($,ctx,input,source));
      }
      if (body) return reply(USAGE);
      return reply(await approvedRules($,ctx,read.events));
    }
    if (command==='check') {
      const request=JSON.parse(body);
      const laws=await approvedRules($,ctx,read.events);
      const decision=checkCurrentPolicy(request,reduceGrants(read.events),laws,ctx,Date.now());
      const law=laws.rules.find(rule=>rule.id===decision.lawId) || laws.holds.find(rule=>rule.id===decision.lawId);
      const basis={lawId:law?.id??null,lawVersion:law?.version??null,lawSource:law?.source??null,compilationVersion:laws.version};
      const proposal=sentencing({decision,actorId:request.agentId??null,group:law?.group,repeatInTurn:false,attributableHarm:false});
      // Preview inputs are user assertions, never evidence that an agent acted.
      const previewId=source.id;
      const evidenceId=await emit($,ctx,null,'policy.preview',previewId,{source,inputHash:await digest(canonical(request)),decision,proposal,basis,evaluationOnly:true});
      return reply({mode:(await currentEnforcement($,ctx)).mode,evaluationOnly:true,decision,proposal,basis,executed:false,evidenceId});
    }
    return null; // Existing status/verify/cleanup handler owns these commands.
  } catch {
    if (emergencyStopped()) return reply('Arbiter off in this process; storage/context unavailable.');
    return reply('Arbiter command failed validation or storage; no grant or successful authority decision confirmed.');
  }
}
