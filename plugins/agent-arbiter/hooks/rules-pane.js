import { observationContext } from './context.js';
import { ACTIONS, EFFECTS, JUDGE_MODELS, loadProjectSettings, updateProjectSettings, listRules, toggleBuiltin, createUserRule, updateUserRule, deleteUserRule } from './project-rules.js';
import { disciplineState, docket, releaseViolations } from './discipline.js';
import { t, ruleLabel, actionLabel, currentLanguage } from './i18n.js';
import { checkFinding, translateTexts, translated } from './review-assist.js';
import { sessionTimeline, recentSessions, durationText } from './history.js';
import { checklistView, sessionProgressDetails, timelineRow } from './history-view.js';
import { pendingWaits } from './notes.js';
import { checklistOf, registerChecklistTool, saveChecklist } from './checklist.js';
import { loadedVersion, updateAvailability, updatePlugin } from './update.js';
import { progressGraph, progressItems, progressTitle } from './progress-view.js';
import { readProjectShared } from './events.js';
import {reduceScores,allProjectScoreRows,scoreUsage} from './scoring.js';
import {projectLessons,shareLessons,unshareLessons,loadLibrary,lessonEffects,experimentResults} from './lessons.js';
import {reduceReviews,decideFinding,decideExemplar,judgeUsage,JUDGE_MODEL,DAILY_TRIALS} from './judge.js';
import {refreshStatus,diagnostics,bandSnapshot} from './status.js';
import {changeProjectMode,changeGlobalConfig,globalConfig,purgeData,resetRules} from './panel-actions.js';
import {masterIsEnabled} from './control-state.js';
import {ROLES,roleOf} from './roles.js';
import {COLORS,levelRow,roleIcon} from './visuals.js';
import {quarantineProject} from './events.js';
import {pruneProject,RETENTION_DAYS} from './retention.js';

const PANE='arbiter-rules', PAGE_SIZE=6;
const MENU_ICONS={inbox:'◉',citizens:'◎',violations:'⚠︎',rules:'⚖︎',settings:'⚙︎'};
const SECTION_ICONS={history:'◷',scores:'▥',lessons:'▤',reviews:'✓'};
const states=new Map();
function key(ctx){return `${ctx.archiveRoot}:${ctx.projectId}`;}
function sessionKey(ctx){return `${key(ctx)}:${ctx.sessionId}`;}
function stateFor(ctx){
  const id=sessionKey(ctx);
  if(!states.has(id))states.set(id,{tab:'inbox',scope:'project',search:'',group:'all',editor:null,confirm:null,message:'',
    pending:false,maintenance:false,diagnostics:null,data:null,pages:{},violationFilter:'all',agentSection:'scores',scoreScope:'project',scoreKind:'all',agentSearch:'',lessonScope:'project',reviewFilter:'pending',detail:null,
    busy:new Set(),autoRun:null,autoResult:null,autoNotes:new Map(),translating:false,translationMessage:null,pinChecked:false,pinOpening:false,opened:false,dismissed:false});
  return states.get(id);
}
const inScope=(ctx,state,item)=>state.scope==='project' || item.sessionId===ctx.sessionId;
// A time as the person reads it: their own clock, to the minute.
function localTime(at){const date=new Date(at);return new Date(at-date.getTimezoneOffset()*60000).toISOString().slice(0,16).replace('T',' ');}
function redraw($){$.ui.invalidate('ui.render');}
function change($,state,values){Object.assign(state,values);redraw($);}
function iconButton(h,key,icon,onPress){
  return h.Button({key,label:icon,plain:true,onPress});
}
function errorText(error){return t('pane.failed',{error:error instanceof Error?error.message:String(error)});}
async function runAction($,ctx,action){
  const state=stateFor(ctx);if(state.pending)return false;
  state.pending=true;state.message='';redraw($);
  try{
    const current=await observationContext($,{recoverPreferences:true});
    if(key(current)!==key(ctx))throw new Error(t('settings.projectChanged'));
    state.message=await action() || t('pane.saved');state.data=null;return true;
  }catch(error){state.message=errorText(error);return false;}
  finally{state.pending=false;redraw($);}
}
async function mutate($,ctx,edit){return runAction($,ctx,async()=>{await updateProjectSettings($,ctx,edit);});}
async function saveEditor($,ctx){
  const state=stateFor(ctx),editor=state.editor;if(!editor)return;
  if(!editor.target.trim()){change($,state,{message:t('pane.validation')});return;}
  const wanted={action:editor.action,target:editor.target,effect:editor.effect};
  const saved=await mutate($,ctx,latest=>editor.original?
    updateUserRule(latest,editor.original.id,wanted,editor.original):createUserRule(latest,{...wanted,id:`user:${crypto.randomUUID()}`}));
  if(saved){state.pages.page=0;change($,state,{editor:null,tab:'rules',group:'custom',search:''});}
}
async function confirmAction($,ctx){
  const state=stateFor(ctx),confirmation=state.confirm;if(!confirmation)return;
  if(confirmation.type==='delete'){
    if(await mutate($,ctx,latest=>deleteUserRule(latest,confirmation.rule.id,confirmation.rule)))change($,state,{confirm:null,message:t('pane.deleted')});
    return;
  }
  const success=await runAction($,ctx,async()=>{
    if(confirmation.type==='reset'){await resetRules($,ctx);return t('pane.resetDone');}
    if(confirmation.type==='release' || confirmation.type==='release-all'){
      if(state.scope==='thread' && await $.session.id()!==ctx.sessionId)throw new Error(t('panel.threadChanged'));
      const active=(await disciplineState($,ctx,true)).violations.filter(record=>record.status==='active' && inScope(ctx,state,record));
      if(confirmation.type==='release-all' && JSON.stringify(active.map(record=>record.id).sort())!==JSON.stringify([...confirmation.ids].sort()))throw new Error(t('settings.changed'));
      const ids=confirmation.type==='release-all'?active.map(record=>record.id):active.filter(record=>record.id===confirmation.id).map(record=>record.id);
      if(!ids.length)throw new Error(t('cmd.releaseNone'));
      await releaseViolations($,ctx,ids,{kind:'ui',origin:'ui',id:crypto.randomUUID()},confirmation.reason);
      await refreshStatus($,ctx);return t('cmd.released',{count:ids.length});
    }
    if(confirmation.type==='share'){
      const lesson=(await projectLessons($,ctx,await loadProjectSettings($,ctx))).find(lesson=>lesson.id===confirmation.lesson.id);
      if(!lesson)throw new Error(t('cmd.lessonNone'));
      if(lesson.text!==confirmation.lesson.text || lesson.role!==confirmation.lesson.role)throw new Error(t('settings.changed'));
      const added=await shareLessons($,ctx,[lesson]);return t(added.length?'pane.shared':'pane.sharedAlready');
    }
    if(confirmation.type==='unshare'){const removed=await unshareLessons($,ctx,confirmation.lesson.id);return t('cmd.unshared',{count:removed.length});}
    if(confirmation.type==='quarantine'){
      const result=await quarantineProject($,ctx);return t('settings.quarantined',{count:result.paths.length,conflicts:result.conflicts.length});
    }
    if(confirmation.type==='cleanup'){
      const result=await pruneProject($,ctx);return result.skipped || t('cmd.cleanup',{parts:result.parts,days:RETENTION_DAYS,removed:result.removed});
    }
    if(confirmation.type==='purge-project' || confirmation.type==='purge-all')return (await purgeData($,ctx,confirmation.type==='purge-all')).text;
    throw new Error('Unknown pane action');
  });
  if(success){
    if(confirmation.type==='reset')state.pages.page=0;
    change($,state,{confirm:null,editor:null,detail:null,diagnostics:null,...(confirmation.type==='reset'?{search:'',group:'all'}:{})});
  }
}
function groupOf(rule){const group=rule.action.split('.')[0];return rule.source==='user'?'custom':group==='fs'?'file':group==='exec'?'system':group;}
function editorFor(rule){return rule?{action:rule.action,target:rule.target,effect:rule.effect,original:{id:rule.id,action:rule.action,target:rule.target,effect:rule.effect}}:{action:'file.write',target:'**',effect:'ask',original:null};}
function confirmationView($,h,ctx,state){
  const c=state.confirm;
  const label=c.type==='reset'?'pane.confirm.reset':c.type==='delete'?'pane.confirm.delete':
    c.type==='release-all' && state.scope==='thread'?'settings.confirm.release-thread':'settings.confirm.'+c.type;
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Text({children:t(label,{rule:c.rule?ruleLabel(c.rule):'',count:c.count || 1,days:RETENTION_DAYS,name:ctx.projectRoot.split('/').at(-1)})}),
    ...(c.lesson?[h.Text({children:c.lesson.text})]:[]),
    ...(['release','release-all'].includes(c.type)?[h.Input({key:'release-reason',label:t('settings.reason'),value:c.reason || '',onInput:value=>{c.reason=value;},onSubmit:value=>{c.reason=value;}})]:[]),
    h.Box({flexDirection:'row',gap:1,children:[
      h.Button({key:'confirm-'+c.type,label:t('pane.confirm.yes'),onPress:()=>confirmAction($,ctx)}),
      h.Button({key:'cancel-confirm',label:t('pane.cancel'),onPress:()=>{if(!state.pending)change($,state,{confirm:null});}}),
    ]}),
  ]});
}
function editorView($,h,ctx,state){
  const e=state.editor,command=e.action==='bash.command';
  return h.Box({flexDirection:'column',gap:1,children:[
    iconButton(h,'back-rules','←',()=>change($,state,{editor:null})),
    h.Text({bold:true,children:t(e.original?'pane.editor.edit':'pane.editor.new')}),
    h.Select({key:'rule-action',label:t('pane.action'),value:e.action,options:ACTIONS.map(value=>({value,label:actionLabel(value)})),
      onSelect:value=>{e.action=value;redraw($);}}),
    h.Input({key:'rule-target',label:t(command?'pane.target.command':'pane.target.path'),value:e.target,
      placeholder:command?'git push*':'src/**',onInput:value=>{e.target=value;redraw($);},onSubmit:value=>{e.target=value;redraw($);}}),
    h.Text({dimColor:true,children:t(command?'pane.hint.command':'pane.hint.path')}),
    h.Select({key:'rule-effect',label:t('pane.effect'),value:e.effect,options:EFFECTS.map(value=>({value,label:t(`effect.${value}`)})),onSelect:value=>{e.effect=value;redraw($);}}),
    h.Text({children:t('pane.preview',{action:actionLabel(e.action),target:e.target,effect:t(`effect.${e.effect}`)})}),
    h.Box({flexDirection:'row',gap:1,children:[
      h.Button({key:e.original?'save-rule':'add-rule',label:t(e.original?'pane.save':'pane.add'),variant:'primary',onPress:()=>saveEditor($,ctx)}),
      h.Button({key:'cancel-editor',label:t('pane.cancel'),onPress:()=>change($,state,{editor:null})}),
    ]}),
  ]});
}
function rulesView($,h,ctx,state,settings){
  if(state.editor)return editorView($,h,ctx,state);
  const rows=listRules(settings),q=state.search.toLocaleLowerCase(),filtered=rows.filter(rule=>
    (state.group==='all' || groupOf(rule)===state.group) && `${ruleLabel(rule)} ${rule.action} ${rule.target}`.toLocaleLowerCase().includes(q));
  const {visible,controls}=paged($,h,state,'page',filtered);
  const filter=values=>{state.pages.page=0;change($,state,values);};
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Box({flexDirection:'row',flexWrap:'wrap',gap:1,children:[
      h.Input({key:'rule-search',label:t('pane.search'),value:state.search,placeholder:t('pane.searchHint'),onInput:value=>filter({search:value}),onSubmit:value=>filter({search:value})}),
      h.Button({key:'new-rule',label:'+ '+t('pane.add'),variant:'primary',onPress:()=>change($,state,{editor:editorFor(null),message:''})}),
    ]}),
    h.Box({flexDirection:'row',flexWrap:'wrap',gap:1,justifyContent:'space-between',children:[
      h.Select({key:'rule-group',value:state.group,options:['all','git','db','file','package','deploy','system','custom'].map(value=>({value,label:t('pane.group.'+value)})),onSelect:value=>filter({group:value})}),
      h.Text({dimColor:true,children:t('pane.count',{count:filtered.length,enabled:filtered.filter(rule=>rule.enabled).length})}),
    ]}),
    ...visible.map(rule=>h.Box({key:'row:'+rule.id,flexDirection:'row',gap:1,alignItems:'center',children:[
      h.Box({flexDirection:'column',flexGrow:1,flexShrink:1,minWidth:0,children:[
        h.Text({bold:true,children:ruleLabel(rule)}),
        h.Text({dimColor:true,children:`${t(rule.source==='user'?'pane.group.custom':'pane.group.'+groupOf(rule))} · ${t('effect.'+rule.effect)}`}),
      ]}),
      h.Box({flexDirection:'row',gap:1,flexShrink:0,children:rule.source==='builtin'?[
        iconButton(h,'toggle:'+rule.id,rule.enabled?'✓':'○',()=>mutate($,ctx,latest=>toggleBuiltin(latest,rule.id))),
      ]:[
        iconButton(h,'edit:'+rule.id,'✎',()=>change($,state,{editor:editorFor(rule),message:''})),
        iconButton(h,'delete:'+rule.id,'🗑︎',()=>change($,state,{confirm:{type:'delete',rule:{...rule}},message:''})),
      ]}),
    ]})),
    ...(visible.length?[]:[h.Text({dimColor:true,children:t('pane.empty')})]),
    ...controls,
  ]});
}
// The ledger-backed views refresh on entry, an explicit refresh or a successful
// action. Search/filters and input redraws reuse the same snapshot.
async function dataset($,ctx,state,settings){
  const snapshot=bandSnapshot(ctx);
  if(!state.data || state.data.snapshot!==snapshot){
    const projectEvents=(await readProjectShared($,ctx)).events,projectDiscipline=await disciplineState($,ctx,true,true);
    const events=projectEvents.filter(event=>inScope(ctx,state,event));
    const discipline={...projectDiscipline,violations:projectDiscipline.violations.filter(record=>inScope(ctx,state,record))};
    const reviews=reduceReviews(projectEvents,ctx.projectId).filter(review=>inScope(ctx,state,review));
    state.data={snapshot,events,projectEvents,discipline,reviews,rows:reduceScores(events,ctx.projectId,discipline,settings.roles,reviews)};
  }
  return state.data;
}
function paged($,h,state,id,rows,size=PAGE_SIZE){
  const last=Math.ceil(rows.length/size)-1;
  const page=Math.max(0,Math.min(state.pages[id] || 0,last));
  const start=page*size,end=Math.min(rows.length,start+size);
  const counterWidth=3*String(rows.length).length+5;
  const step=(name,icon,target)=>h.Box({width:4,alignItems:'center',children:target<0 || target>last?[]:[
    iconButton(h,id+'-'+name,icon,()=>{state.pages[id]=target;redraw($);}),
  ]});
  const controls=last>0?[h.Box({key:'pager-'+id,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:1,children:[
    step('previous','‹',page-1),
    h.Box({width:counterWidth,alignItems:'center',children:[
      h.Text({dimColor:true,tabular:true,children:t('pane.range',{from:start+1,to:end,count:rows.length})}),
    ]}),
    step('next','›',page+1),
  ]})]:[];
  return {visible:rows.slice(start,end),controls};
}

function progressView($,h,ctx,state){
  const kind=state.progressKind;
  const snapshot=bandSnapshot(ctx), scoped=snapshot && {...snapshot,
    recentReviews:snapshot.recentReviews?.filter(review=>inScope(ctx,state,review)),
    detainedRecords:snapshot.detainedRecords?.filter(record=>inScope(ctx,state,record)),
  };
  const {visible,controls}=paged($,h,state,'progress',progressItems(scoped,kind),12);
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Text({bold:true,children:progressTitle(kind)}),
    progressGraph(h,state.surface,kind,visible,state.columns),
    ...controls,
  ]});
}
const uiSource=()=>({kind:'ui',origin:'ui',id:crypto.randomUUID()});
function askConfirmation($,state,type,extra={}){change($,state,{confirm:{type,...extra},message:''});}

async function violationsView($,h,ctx,state,settings){
  const data=await dataset($,ctx,state,settings),records=docket(data.discipline,Number.MAX_SAFE_INTEGER);
  const active=records.filter(record=>record.status==='active');
  const filtered=records.filter(record=>state.violationFilter==='all' || record.status===state.violationFilter);
  const {visible,controls}=paged($,h,state,'violations',filtered);
  const detail=state.detail?.kind==='violation'?data.discipline.violations.find(record=>record.id===state.detail.id):null;
  if(detail){
    const record=records.find(record=>record.id===detail.id);
    return h.Box({flexDirection:'column',gap:1,children:[
      iconButton(h,'back-violations','←',()=>change($,state,{detail:null})),
      h.Text({bold:true,children:record.who}),
      h.Text({children:`${t('sanction.'+record.sanction)} · -${record.points} · ${t('status.'+record.status)}`}),
      h.Text({children:record.ruleIds.map(id=>id.startsWith('user:')?id:t('rule.'+id)).join(', ')}),
      h.Text({children:detail.detail || detail.reason}),h.Text({dimColor:true,children:detail.id}),
      ...(record.releaseReason?[h.Text({children:t('settings.reasonValue',{reason:record.releaseReason})})]:[]),
      ...(record.status==='active'?[h.Button({key:'release:'+record.id,label:t('pane.release',{who:record.who}),onPress:()=>askConfirmation($,state,'release',{id:record.id,reason:''})})]:[]),
    ]});
  }
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Box({flexDirection:'row',gap:1,flexWrap:'wrap',children:[
      h.Select({key:'violation-filter',label:t('settings.filter'),value:state.violationFilter,options:['all','active','released','served'].map(value=>({value,label:t(value==='all'?'settings.all':'status.'+value)})),onSelect:value=>{state.pages.violations=0;change($,state,{violationFilter:value,detail:null});}}),
      ...(active.length?[h.Button({key:'release-all',label:t('settings.releaseAll',{count:active.length}),onPress:()=>askConfirmation($,state,'release-all',{count:active.length,ids:active.map(record=>record.id),reason:''})})]:[]),
    ]}),
    ...(visible.length?visible.map(record=>h.Box({key:record.id,flexDirection:'column',children:[
      h.Box({flexDirection:'row',alignItems:'center',gap:1,children:[
        roleIcon(h,state.surface,record.agentId?roleOf(record.citizenName ?? ''):'main',24,
          {animate:true,detained:record.sanction==='detain' && record.status==='active'},record.who),
        h.Text({bold:true,children:record.who}),
      ]}),
      h.Text({children:`${localTime(record.at)} · ${t('sanction.'+record.sanction)} · -${record.points} · ${t('status.'+record.status)}`}),
      h.Text({dimColor:true,children:record.ruleIds.map(id=>id.startsWith('user:')?id:t('rule.'+id)).join(', ')}),
      ...(record.releaseReason?[h.Text({children:t('settings.reasonValue',{reason:record.releaseReason})})]:[]),
      h.Box({flexDirection:'row',gap:1,children:[
        h.Button({key:'violation:'+record.id,label:t('settings.details'),onPress:()=>change($,state,{detail:{kind:'violation',id:record.id}})}),
        ...(record.status==='active'?[h.Button({key:'release:'+record.id,label:t('pane.release',{who:record.who}),onPress:()=>askConfirmation($,state,'release',{id:record.id,reason:''})})]:[]),
      ]}),
    ]})):[h.Text({dimColor:true,children:t('pane.docketNone')})]),
    ...controls,
  ]});
}
// An answer is recorded without hiding the panel or reading everything again:
// only its own buttons wait, and the list shown is patched in place.
async function decide($,ctx,kind,ref,decision,extra={}){
  const state=stateFor(ctx);if(state.busy.has(ref))return false;
  state.busy.add(ref);redraw($);
  try{
    if(await $.session.id()!==ctx.sessionId)throw new Error(t('panel.threadChanged'));
    const reviews=reduceReviews((await readProjectShared($,ctx)).events,ctx.projectId).filter(review=>inScope(ctx,state,review));
    // A noted finding can be decided too: the detail view offers it.
    const pending=kind==='finding'?reviews.some(review=>review.findings.some(finding=>finding.ref===ref && ['open','noted'].includes(finding.state))):
      reviews.some(review=>review.ref===ref && review.exemplar.state==='candidate');
    if(!pending)throw new Error(t('pane.decideGone'));
    const source={...uiSource(),...extra};
    const done=kind==='finding'?await decideFinding($,ctx,reviews,ref,decision,source):await decideExemplar($,ctx,reviews,ref,decision,source);
    if(!done)throw new Error(t('pane.decideGone'));
    for(const review of state.data?.reviews ?? []){
      if(kind==='finding'){
        const finding=review.findings.find(item=>item.ref===ref);
        if(finding){finding.state=decision;review.disputed=review.findings.some(item=>item.state==='dismissed');}
      }else if(review.ref===ref)review.exemplar.state=decision;
    }
    state.message=t('pane.decided');void refreshStatus($,ctx);return true;
  }catch(error){state.message=errorText(error);return false;}
  finally{state.busy.delete(ref);redraw($);}
}
// The person's own button: the judge model checks each waiting finding in turn and
// its answer is recorded as theirs, marked automatic. What it cannot tell stays.
const canAutoReview=(state,finding)=>finding.state==='open' && state.autoNotes.get(finding.ref)?.decision!=='unsure';
async function autoReview($,ctx,state,settings){
  if(state.autoRun)return;
  const items=(state.data?.reviews ?? []).flatMap(review=>review.findings.filter(finding=>canAutoReview(state,finding)).map(finding=>({review,finding})));
  if(!items.length)return;
  const model=settings.judgeModel ?? JUDGE_MODEL,run={done:0,total:items.length,confirmed:0,dismissed:0,unsure:0,failed:0};
  state.autoRun=run;state.autoResult=null;state.message='';redraw($);
  try{
    for(const {review,finding} of items){
      let verdict=null;
      try{verdict=await checkFinding($,ctx,review,finding,model);}catch{ /* The finding stays open. */ }
      if(!verdict){run.failed+=1;state.autoNotes.set(finding.ref,{decision:'failed'});}
      else if(verdict.decision==='unsure'){run.unsure+=1;state.autoNotes.set(finding.ref,verdict);}
      else if(await decide($,ctx,'finding',finding.ref,verdict.decision,{auto:true,model})){
        run[verdict.decision]+=1;state.autoNotes.delete(finding.ref);
      }else{run.failed+=1;state.autoNotes.set(finding.ref,{decision:'failed',why:state.message});}
      run.done+=1;redraw($);
    }
  }finally{
    state.autoRun=null;state.autoResult=run;state.message='';redraw($);
  }
}
async function translatePage($,state,reviews,view){
  if(state.translating)return;
  const language=currentLanguage();
  state.translating=true;state.translationMessage=null;redraw($);
  try{
    const texts=reviews.flatMap(review=>[...review.findings.flatMap(finding=>[
      finding.claim,finding.evidence,state.autoNotes.get(finding.ref)?.why,
    ]),review.exemplar.why]);
    const {added,requested}=await translateTexts($,texts,language);
    const key=added?'pane.translated':requested?'pane.translationUnchanged':'pane.translateNone';
    state.translationMessage={view,key,count:added};
  }catch{state.translationMessage={view,key:'pane.translationUnavailable'};}
  finally{state.translating=false;redraw($);}
}
const shown=text=>translated(text,currentLanguage()) ?? text;
function translationControls($,h,state,reviews,view){
  if(currentLanguage()==='en' || !reviews.length)return [];
  return [
    h.Button({key:'translate-reviews',label:t(state.translating?'pane.translating':'pane.translateAction'),
      onPress:()=>{void translatePage($,state,reviews,view);}}),
    ...(state.translationMessage?.view===view?[h.Text({key:'review-translation-message',
      children:t(state.translationMessage.key,state.translationMessage)})]:[]),
  ];
}
function roleSelect($,h,ctx,name,settings){
  return h.Select({key:'role:'+name,label:t('settings.role'),value:settings.roles[name] || 'auto',
    options:['auto',...ROLES].map(value=>({value,label:value==='auto'?t('settings.automatic'):t('role.'+value)})),
    onSelect:value=>mutate($,ctx,latest=>{const roles={...latest.roles};if(value==='auto')delete roles[name];else roles[name]=value;return {...latest,roles};})});
}
// A row's levels: trust and clean runs for a subagent type, warnings for the
// main agent, and the reviewed quality, a bar only once something was scored.
function scoreLevels(row){
  const reviewed=row.qualityGroups.reduce((sum,group)=>sum+group.reviews,0);
  const quality=reviewed?Math.round(row.qualityGroups.reduce((sum,group)=>sum+group.sum,0)/reviewed):null;
  const levels=row.kind==='main'?[
    {key:'warnings',label:t('score.warnings'),figure:t('score.warningsFigure',{count:row.warnings}),bar:null},
  ]:[
    {key:'trust',label:t('score.trust'),figure:t('score.outOf100',{value:row.trust}),bar:{value:row.trust,max:100,color:COLORS.trust}},
  ];
  levels.push({key:'quality',label:t('score.quality'),figure:quality===null?t('score.notReviewed'):t('score.outOf100',{value:quality}),
    bar:quality===null?null:{value:quality,max:100,color:COLORS.quality}});
  if(row.kind!=='main')levels.push({key:'clean',label:t('score.clean'),figure:t('score.cleanFigure',{clean:row.cleanRuns,runs:row.runs}),
    bar:{value:row.cleanRuns,max:row.runs,color:COLORS.clean}});
  return levels;
}
async function scoresView($,h,ctx,state,settings,data){
  if(state.scoreScope==='all' && !data.allScores)data.allScores=await allProjectScoreRows($,ctx);
  const rows=(state.scoreScope==='all'?data.allScores.rows:data.rows).filter(row=>
    (state.scoreKind==='all' || row.kind===state.scoreKind) &&
    `${row.name} ${t('pane.agentKind.'+row.kind)} ${row.model || ''}`.toLowerCase().includes(state.agentSearch.toLowerCase()));
  const {visible,controls}=paged($,h,state,'scores',rows),seen=new Set();
  return h.Box({flexDirection:'column',gap:1,children:[
    ...(state.scope==='project'?[h.Select({key:'score-scope',label:t('settings.scope'),value:state.scoreScope,options:['project','all'].map(value=>({value,label:t('settings.scope.'+value)})),onSelect:value=>{state.pages.scores=0;change($,state,{scoreScope:value});}})]:[]),
    h.Select({key:'score-kind',label:t('pane.agentKind'),value:state.scoreKind,options:['all','main','subagent'].map(value=>({value,label:t(value==='all'?'settings.all':'pane.agentKind.'+value)})),onSelect:value=>{state.pages.scores=0;change($,state,{scoreKind:value});}}),
    h.Input({key:'agent-search',label:t('settings.agentSearch'),value:state.agentSearch,onInput:value=>{state.pages.scores=0;change($,state,{agentSearch:value});},onSubmit:value=>{state.pages.scores=0;change($,state,{agentSearch:value});}}),
    ...(state.scoreScope==='all'?[h.Text({dimColor:true,children:t('settings.allScores',{count:data.allScores.projects})})]:[]),
    ...(visible.length?visible.map(row=>{
      // Main and unidentified rows are not agent types: a role set for them would
      // override the role each turn's brief gives.
      const role=!seen.has(row.name) && state.scope==='project' && state.scoreScope==='project' && row.kind==='subagent' && row.name!=='unidentified-agent';seen.add(row.name);
      const name=row.kind==='main'?t('pane.agentKind.main'):row.name;
      return h.Box({key:'score:'+row.kind+':'+row.name+':'+(row.model ?? ''),flexDirection:'column',gap:1,children:[
        h.Box({flexDirection:'row',alignItems:'center',gap:1,children:[
          roleIcon(h,state.surface,row.kind==='main'?'main':row.role,32,{animate:true},t('role.'+row.role)),
          h.Box({flexDirection:'row',flexWrap:'wrap',flexShrink:1,columnGap:1,children:[
            h.Text({bold:true,children:name}),
            h.Text({dimColor:true,children:`${row.model ?? t('pane.modelUnknown')} · ${t(row.kind==='main'?'score.turns':'score.runs',{runs:row.runs})}${row.detained?' · '+t('tbl.detained').replace(/^ · /,''):''}`}),
          ]}),
        ]}),
        ...scoreLevels(row).map(metric=>levelRow(h,state.surface,metric,state.columns)),
        h.Text({dimColor:true,children:scoreUsage(row)}),
        ...(role?[roleSelect($,h,ctx,row.name,settings)]:[]),
      ]});
    }):[h.Text({dimColor:true,children:t('pane.scoresNone')})]),...controls,
    ...(state.scope==='project' && state.scoreScope==='project' && state.scoreKind==='all'?Object.keys(settings.roles).filter(name=>!data.rows.some(row=>row.name===name)).map(name=>h.Box({flexDirection:'column',children:[h.Text({children:name}),roleSelect($,h,ctx,name,settings)]})):[]),
  ]});
}
async function lessonsView($,h,ctx,state,settings,data){
  const library=state.lessonScope==='library';
  const lessons=data.lessons ??= await projectLessons($,ctx,settings),sharedLessons=data.library ??= await loadLibrary($,ctx);
  const rows=library?sharedLessons:lessons;
  const {visible,controls}=paged($,h,state,'lessons',rows);
  const effects=lessonEffects(data.events,ctx.projectId,lessons,data.discipline);
  const experiment=experimentResults(data.events,ctx.projectId,data.discipline);
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Select({key:'lesson-scope',label:t('settings.scope'),value:state.lessonScope,options:['project','library'].map(value=>({value,label:t('settings.scope.'+value)})),onSelect:value=>{state.pages.lessons=0;change($,state,{lessonScope:value});}}),
    h.Text({dimColor:true,children:t('settings.libraryHint')}),
    ...(settings.lessonExperiment || experiment.held?[h.Text({children:t('tbl.experiment',experiment)})]:[]),
    ...(visible.length?visible.map(lesson=>{
      const effect=effects.get(lesson.id) || {taught:0,repeatsAfter:0},shared=sharedLessons.some(entry=>entry.id===lesson.id);
      return h.Box({flexDirection:'column',gap:1,children:[
        h.Text({bold:true,children:`${lesson.agentName} · ${lesson.role}`}),h.Text({children:lesson.text}),
        ...(!library?[h.Text({dimColor:true,children:t('settings.lessonStats',{count:lesson.count,taught:effect.taught,repeats:effect.repeatsAfter})})]:[]),
        ...(library?[h.Button({key:'unshare:'+lesson.id,label:t('settings.unshare'),onPress:()=>askConfirmation($,state,'unshare',{lesson})})]:
          shared?[h.Text({dimColor:true,children:t('pane.sharedAlready')})]:[h.Button({key:'share:'+lesson.id,label:t('pane.share'),onPress:()=>askConfirmation($,state,'share',{lesson})})]),
      ]});
    }):[h.Text({dimColor:true,children:t(library?'cmd.libraryNone':'pane.lessonsNone')})]),...controls,
  ]});
}
function reviewsView($,h,ctx,state,settings,data,inbox=false){
  const pending=review=>review.findings.some(finding=>finding.state==='open');
  const suggested=review=>!pending(review) && review.exemplar.state==='candidate';
  const kindOf=review=>pending(review)?'pending':suggested(review)?'suggested':'completed';
  const rows=[...data.reviews].reverse().filter(review=>inbox?kindOf(review)!=='completed':state.reviewFilter==='all' || kindOf(review)===state.reviewFilter);
  const noted=data.reviews.reduce((sum,review)=>sum+review.findings.filter(finding=>finding.state==='noted').length,0);
  const waiting=data.reviews.flatMap(review=>review.findings.filter(finding=>finding.state==='open'));
  const eligible=waiting.filter(finding=>canAutoReview(state,finding));
  const manualCount=waiting.length-eligible.length;
  const retry=eligible.length>0 && eligible.every(finding=>state.autoNotes.get(finding.ref)?.decision==='failed');
  const answer=(key,label,ref,run)=>h.Button({key,label:state.busy.has(ref)?t('settings.working'):label,onPress:()=>state.busy.has(ref) || state.autoRun?undefined:run()});
  const {visible,controls}=paged($,h,state,inbox?'inbox-reviews':'reviews',rows),usage=judgeUsage(data.projectEvents,ctx.projectId);
  const translation=translationControls($,h,state,visible,(inbox?'inbox:':'list:')+visible.map(review=>review.id).join(':'));
  const detail=state.detail?.kind==='review'?data.reviews.find(review=>review.id===state.detail.id):null;
  if(detail)return h.Box({flexDirection:'column',gap:1,children:[
    iconButton(h,'back-reviews','←',()=>change($,state,{detail:null})),
    h.Text({bold:true,children:`${t('settings.details')} · ${detail.citizen?.kind==='main'?t('pane.agentKind.main'):detail.citizen?.name || 'agent'}`}),
    h.Text({dimColor:true,children:`${localTime(detail.at)} · ${detail.ref}`}),
    ...translationControls($,h,state,[detail],'detail:'+detail.id),
    ...Object.entries(detail.scores).map(([dimension,score])=>h.Text({children:`${t('dimension.'+dimension)}: ${score===null?t('tbl.undetermined'):t('score.outOf5',{value:score})}`})),
    ...(detail.findings.some(finding=>['open','noted'].includes(finding.state))?[h.Text({dimColor:true,children:t('pane.findingHint')})]:[]),
    ...detail.findings.map(finding=>h.Box({flexDirection:'column',gap:1,children:[
      h.Text({children:`${t('severity.'+finding.severity)} · ${t('dimension.'+finding.dimension)} · ${t('settings.decision.'+finding.state)}`}),
      h.Text({children:shown(finding.claim)}),h.Text({dimColor:true,children:shown(finding.evidence)}),
      ...(['open','noted'].includes(finding.state)?[h.Box({flexDirection:'row',gap:1,children:[
        h.Button({key:'confirm:'+finding.ref,label:t('pane.confirmFinding'),onPress:()=>decide($,ctx,'finding',finding.ref,'confirmed')}),
        h.Button({key:'dismiss:'+finding.ref,label:t('pane.dismissFinding'),onPress:()=>decide($,ctx,'finding',finding.ref,'dismissed')}),
      ]})]:[]),
    ]})),
    ...(detail.exemplar.state!=='none'?[h.Text({children:`${t('pane.exemplar')} · ${t('settings.decision.'+detail.exemplar.state)}: ${shown(detail.exemplar.why)}`})]:[]),
    ...(detail.exemplar.state==='candidate'?[h.Text({dimColor:true,children:t('pane.exemplarHint')}),h.Box({flexDirection:'row',gap:1,children:[
      h.Button({key:'approve:'+detail.ref,label:t('pane.approve'),onPress:()=>decide($,ctx,'exemplar',detail.ref,'approved')}),
      h.Button({key:'reject:'+detail.ref,label:t('pane.reject'),onPress:()=>decide($,ctx,'exemplar',detail.ref,'rejected')}),
    ]})]:[]),
  ]});
  return h.Box({flexDirection:'column',gap:1,children:[
    ...(inbox?[]:[
      h.Text({children:t('tbl.judgeHead',{state:t(settings.judge?'cmd.on':'cmd.off'),model:settings.judgeModel ?? JUDGE_MODEL,today:usage.today,cap:DAILY_TRIALS,trials:usage.trials,input:usage.inputTokens,output:usage.outputTokens})}),
      h.Text({dimColor:true,children:t('pane.reviewsHint')}),
      ...(noted?[h.Text({dimColor:true,children:t('pane.autoNoted',{count:noted})})]:[]),
    ]),
    ...(state.autoRun?[h.Text({children:t('pane.autoRunning',state.autoRun)})]:eligible.length||translation.length?[h.Box({flexDirection:'row',gap:1,alignItems:'center',flexWrap:'wrap',children:[
      ...(eligible.length?[h.Button({key:'auto-review',label:t(retry?'pane.autoRetry':'pane.auto',{count:eligible.length}),onPress:()=>{void autoReview($,ctx,state,settings);}})]:[]),
      ...translation,
    ]})]:[]),
    ...(state.autoResult?[h.Text({key:'review-auto-summary',
      children:t('pane.autoDone',state.autoResult)+(state.autoResult.failed?' '+t('pane.autoFailed',state.autoResult):'')})]:[]),
    ...(manualCount?[h.Text({key:'review-manual-count',children:t('pane.autoManual',{count:manualCount})})]:[]),
    ...(!inbox && eligible.length && !state.autoRun?[h.Text({dimColor:true,children:t('pane.autoHint',{model:settings.judgeModel ?? JUDGE_MODEL})})]:[]),
    ...(inbox?[]:[h.Select({key:'review-filter',label:t('settings.filter'),value:state.reviewFilter,options:['pending','suggested','completed','all'].map(value=>({value,label:t('settings.'+value)})),onSelect:value=>{state.pages.reviews=0;change($,state,{reviewFilter:value,detail:null});}})]),
    ...(visible.length?visible.map(review=>h.Box({key:'review-row:'+review.id,flexDirection:'column',gap:1,children:[
      h.Box({flexDirection:'row',alignItems:'center',gap:1,children:[
        roleIcon(h,state.surface,review.citizen?.kind==='main'?'main':review.role,24,{animate:true},t('role.'+review.role)),
        h.Box({flexDirection:'row',flexWrap:'wrap',flexShrink:1,columnGap:1,children:[
          h.Text({bold:true,children:review.citizen?.kind==='main'?t('pane.agentKind.main'):review.citizen?.name || 'agent'}),
          h.Text({dimColor:true,children:`${localTime(review.at)}${inbox?(pending(review)?' · '+t('progress.waitAge',{time:durationText(Date.now()-review.at)}):''):
            ' · '+t('role.'+review.role)+' · '+t('difficulty.'+review.difficulty)}`}),
        ]}),
      ]}),
      ...(inbox?[]:[levelRow(h,state.surface,{key:'quality',label:t('score.quality'),figure:review.quality===null?t('score.notReviewed'):t('score.outOf100',{value:review.quality}),
        bar:review.quality===null?null:{value:review.quality,max:100,color:COLORS.quality}},state.columns)]),
      // What waits is shown here with its two answers, so a decision needs no trip into the details.
      ...review.findings.filter(finding=>finding.state==='open').map(finding=>h.Box({key:'open:'+finding.ref,flexDirection:'column',gap:1,children:[
        h.Text({...(inbox?{maxLines:2,wrap:'truncate'}:{}),children:`${t('severity.'+finding.severity)} · ${t('dimension.'+finding.dimension)}: ${shown(finding.claim)}`}),
        ...(state.autoNotes.has(finding.ref)?[h.Text({dimColor:true,children:t('pane.autoNote',{why:shown(state.autoNotes.get(finding.ref).why)
          || t(state.autoNotes.get(finding.ref).decision==='unsure'?'pane.autoUnsure':'pane.autoModelFailed')})})]:[]),
        h.Box({flexDirection:'row',gap:1,children:[
          answer('confirm:'+finding.ref,t('pane.confirmFinding'),finding.ref,()=>decide($,ctx,'finding',finding.ref,'confirmed')),
          answer('dismiss:'+finding.ref,t('pane.dismissFinding'),finding.ref,()=>decide($,ctx,'finding',finding.ref,'dismissed')),
        ]}),
      ]})),
      ...(suggested(review)?[h.Box({flexDirection:'column',gap:1,children:[
        h.Text({children:shown(review.exemplar.why)}),
        h.Box({flexDirection:'row',gap:1,children:[
          answer('approve:'+review.ref,t('pane.approve'),review.ref,()=>decide($,ctx,'exemplar',review.ref,'approved')),
          answer('reject:'+review.ref,t('pane.reject'),review.ref,()=>decide($,ctx,'exemplar',review.ref,'rejected')),
        ]}),
      ]})]:[]),
      h.Button({key:'review:'+review.id,label:t('settings.details'),plain:true,onPress:()=>change($,state,{detail:{kind:'review',id:review.id}})}),
    ]})):[h.Text({dimColor:true,children:t('settings.noReviews')})]),...controls,
  ]});
}
// The sessions of this project and, for the one chosen, the thread of its main
// agent with a branch for every agent it sent; a run opens to what it did.
async function historyView($,h,ctx,state,settings,data){
  const events=(await readProjectShared($,ctx)).events.filter(event=>inScope(ctx,state,event));
  const sessions=recentSessions(events,ctx.projectId,20);
  const chosen=sessions.some(session=>session.sessionId===state.historySession)?state.historySession:
    sessions.some(session=>session.sessionId===ctx.sessionId)?ctx.sessionId:sessions[0]?.sessionId;
  if(!chosen)return h.Text({dimColor:true,children:t('history.empty')});
  const timeline=sessionTimeline(events,ctx.projectId,chosen,{discipline:data.discipline,reviews:data.reviews});
  const picker=state.scope==='project'?[h.Select({key:'history-session',label:t('history.session'),value:chosen,options:sessions.map(session=>({value:session.sessionId,
    label:`${session.sessionId===ctx.sessionId?t('history.thisSession')+' · ':''}${localTime(session.endedAt)} · ${t('history.sessionFigure',{agents:session.agents,calls:session.calls})}`})),
    onSelect:value=>{state.pages.history=0;change($,state,{historySession:value,detail:null});}})]:[];
  const agent=state.detail?.kind==='run'?timeline?.agents.find(run=>run.agentId===state.detail.id):null;
  if(agent)return h.Box({flexDirection:'column',gap:1,children:[
    iconButton(h,'back-history','←',()=>change($,state,{detail:null})),
    timelineRow(h,state.surface,agent,{lanes:1,first:true,last:true,size:32}),
    h.Text({dimColor:true,children:`${localTime(agent.startedAt)}${agent.endedAt?' → '+localTime(agent.endedAt).slice(11):''} · ${agent.agentId}`}),
    h.Text({children:agent.tools.length?t('history.tools',{tools:agent.tools.map(item=>`${item.tool} ${item.count}`).join(' · ')}):t('history.noTools')}),
    ...(agent.files?[h.Text({dimColor:true,children:t('history.files',{count:agent.files})})]:[]),
    ...(agent.violations.length?agent.violations.map(record=>h.Text({key:'v:'+record.id,children:`${t('sanction.'+record.sanction)} · ${record.ruleIds.map(id=>id.startsWith('user:')?id:t('rule.'+id)).join(', ')} · ${t('status.'+record.status)}`})):[h.Text({dimColor:true,children:t('history.clean')})]),
    ...agent.findings.map(finding=>h.Text({key:'f:'+finding.ref,children:`${t('severity.'+finding.severity)} · ${t('settings.decision.'+finding.state)}: ${shown(finding.claim)}`})),
    ...(agent.reviewId?[h.Button({key:'run-review',label:t('history.openReview'),onPress:()=>change($,state,{agentSection:'reviews',reviewFilter:'all',detail:{kind:'review',id:agent.reviewId}})})]:[]),
  ]});
  const runs=timeline?.agents ?? [];
  let contextPercent=null;
  if(chosen===ctx.sessionId){
    try{contextPercent=(await $.session.usage()).context?.percent;}catch{ /* Usage may not be available yet. */ }
  }
  const checklist=settings.checklist?checklistOf(events,chosen):null;
  const expanded=state.checklistSession===chosen;
  const {visible,controls}=paged($,h,state,'history',[...runs].reverse(),20);
  return h.Box({flexDirection:'column',gap:1,children:[...picker,
    ...sessionProgressDetails(h,timeline,contextPercent),
    ...(checklist?checklistView(h,checklist,timeline.main.calls,{expanded,
      toggle:()=>change($,state,{checklistSession:expanded?null:chosen}),
      clear:chosen===ctx.sessionId?()=>runAction($,ctx,async()=>{
        if(await $.session.id()!==ctx.sessionId)throw new Error(t('panel.threadChanged'));
        await saveChecklist($,ctx,crypto.randomUUID(),{type:'clear',source:'report'});
        await refreshStatus($,ctx);
        return t('progress.cleared');
      }):null,
    }):[]),
    h.Box({flexDirection:'column',children:[
      timelineRow(h,state.surface,{main:true,...timeline.main},{lanes:timeline.lanes,first:true,last:!runs.length}),
      ...visible.map((run,index)=>timelineRow(h,state.surface,run,{lanes:timeline.lanes,last:index===visible.length-1,
        onPress:()=>change($,state,{detail:{kind:'run',id:run.agentId}})})),
    ]}),
    ...(runs.length?controls:[h.Text({dimColor:true,children:t('history.none')})]),
  ]});
}
async function citizensView($,h,ctx,state,settings){
  const data=await dataset($,ctx,state,settings);
  const body=state.agentSection==='lessons'?await lessonsView($,h,ctx,state,settings,data):state.agentSection==='reviews'?reviewsView($,h,ctx,state,settings,data):
    state.agentSection==='history'?await historyView($,h,ctx,state,settings,data):await scoresView($,h,ctx,state,settings,data);
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Select({key:'agent-section',label:t('settings.agentSection'),value:state.agentSection,options:Object.entries(SECTION_ICONS).map(([value,icon])=>({value,label:icon+' '+t('settings.section.'+value)})),onSelect:value=>change($,state,{agentSection:value,detail:null,data:null})}),body,
  ]});
}
async function settingsView($,h,ctx,state,settings){
  let configs=[];
  try{configs=await globalConfig($);}catch{ /* Project preferences still work. */ }
  const enabled=configs.find(row=>row.key==='agent-arbiter.enabled'),language=configs.find(row=>row.key==='agent-arbiter.language');
  const sounds=configs.find(row=>row.key==='agent-arbiter.sounds'), version=await loadedVersion($);
  const group=(label,children)=>h.Box({flexDirection:'column',gap:1,children:[h.Text({bold:true,children:label}),...children]});
  const toggle=(key,label,value,onPress,locked=false)=>{
    const status=t(value?'pane.toggle.on':'pane.toggle.off');
    return h.Box({flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:1,children:[
      h.Text({children:label+(locked?' · '+t('settings.locked'):'')}),
      h.Button({key,label:status,onPress}),
    ]});
  };
  const display=(key,prop,value=settings[prop]===true)=>toggle('progress-'+key,t('progress.setting.'+key),value,
    ()=>runAction($,ctx,async()=>{
      const saved=await updateProjectSettings($,ctx,latest=>({...latest,[prop]:!(prop==='effects'?latest.effects!==false:latest[prop]===true)}));
      if(prop==='checklist' && saved.checklist){
        try{await registerChecklistTool($);}catch{ /* The next session can register it. */ }
      }
      await refreshStatus($,ctx);
    }));
  return h.Box({flexDirection:'column',gap:2,children:[
    group(t('settings.project'),[
      h.Select({key:'court-mode',label:t('pane.mode'),value:settings.mode,options:['enforce','observe','off'].map(value=>({value,label:t('pane.modeLabel.'+value)})),onSelect:value=>runAction($,ctx,async()=>{await changeProjectMode($,ctx,value);})}),
      ...(settings.hardened?[h.Text({children:t('settings.hardened')})]:[]),
      toggle('toggle-judge',t('pane.judge'),settings.judge,()=>mutate($,ctx,latest=>({...latest,judge:!latest.judge}))),
      h.Select({key:'judge-model',label:t('settings.judgeModel'),value:settings.judgeModel ?? 'haiku',options:JUDGE_MODELS.map(value=>({value,label:t('settings.judgeModel.'+value)})),onSelect:value=>mutate($,ctx,latest=>({...latest,judgeModel:value}))}),
      toggle('toggle-lessons',t('pane.lessons'),settings.lessons,()=>mutate($,ctx,latest=>({...latest,lessons:!latest.lessons}))),
      toggle('toggle-experiment',t('settings.experiment'),settings.lessonExperiment,()=>mutate($,ctx,latest=>({...latest,lessonExperiment:!latest.lessonExperiment}))),
    ]),
    group(t('settings.global'),[
      ...(enabled?[toggle('global-enabled',t('settings.enabled'),enabled.value,()=>runAction($,ctx,async()=>{
        await changeGlobalConfig($,enabled.key,!enabled.value);await refreshStatus($,ctx);return t('settings.savedGlobal');
      }),enabled.isLocked)]:[]),
      ...(language?[h.Select({key:'global-language',label:t('pane.language')+(language.isLocked?' · '+t('settings.locked'):''),value:language.value,options:['auto','en','vi'].map(value=>({value,label:value==='auto'?t('settings.automatic'):value==='vi'?'Tiếng Việt':'English'})),onSelect:value=>runAction($,ctx,async()=>{
        await changeGlobalConfig($,language.key,value);return t('settings.savedGlobal');
      })})]:[]),
      ...(sounds?[toggle('global-sounds',t('progress.setting.sounds'),sounds.value,
        ()=>runAction($,ctx,async()=>{await changeGlobalConfig($,sounds.key,!sounds.value);return t('settings.savedGlobal');}),sounds.isLocked)]:[]),
      ...(!enabled || !language?[h.Text({dimColor:true,children:t('settings.configUnavailable')})]:[]),
    ]),
    group(t('progress.settings'),[
      display('effects','effects',settings.effects!==false),
      display('fold','foldAgentStrips'),
      display('checklist','checklist'),
      ...(settings.checklist?[display('autoclose','autoCloseChecklist')]:[]),
      display('speed','outputSpeed'),
      display('chimes','progressSounds'),
    ]),
    group(t('progress.updates'),[
      ...(version?[h.Text({key:'progress-version',children:t('progress.version',{version})})]:[]),
      display('update-check','checkUpdates'),
      h.Box({flexDirection:'row',gap:1,flexWrap:'wrap',children:[
        ...(settings.checkUpdates?[h.Button({key:'progress-check-now',label:t('progress.checkNow'),
          onPress:()=>{void runAction($,ctx,async()=>{const result=await updateAvailability($);return t('progress.update.'+result.status,result);});}})]:[]),
        h.Button({key:'progress-update',label:t('progress.updateAction'),onPress:()=>{void runAction($,ctx,()=>updatePlugin($));}}),
      ]}),
    ]),
    h.Box({flexDirection:'column',gap:1,children:[
      h.Button({key:'show-maintenance',label:(state.maintenance?'▾ ':'▸ ')+t('settings.data'),plain:true,
        onPress:()=>{if(!state.pending)change($,state,{maintenance:!state.maintenance});}}),
      ...(state.maintenance?[
        h.Text({dimColor:true,children:t('settings.dataHint')}),
        ...(state.diagnostics?[h.Text({dimColor:true,children:t('settings.ledgerHealth',state.diagnostics)})]:[]),
        ...['quarantine','cleanup','reset','purge-project','purge-all'].map(type=>h.Button({key:type==='reset'?'reset-rules':type,label:t('settings.action.'+type)+'…',onPress:()=>{if(!state.pending)askConfirmation($,state,type);}})),
      ]:[]),
    ]}),
  ]});
}

async function refreshPane($,ctx,state,failures){
  await runAction($,ctx,async()=>{
    await refreshStatus($,ctx);
    if(state.tab==='settings' && state.maintenance)state.diagnostics=await diagnostics($,ctx,failures());
    return t('settings.refreshed');
  });
}
// Deep links from the inbox and the progress band.
function focusOn(state,focus){
  if(focus==='jail')Object.assign(state,{tab:'violations',violationFilter:'active',pages:{...state.pages,violations:0}});
  if(focus?.kind==='progress')Object.assign(state,{tab:'progress',progressKind:focus.key,pages:{...state.pages,progress:0}});
  // A run pressed in the band: its session's timeline, at that run.
  if(focus?.kind==='run' || focus?.kind==='checklist')Object.assign(state,{tab:'citizens',agentSection:'history',historySession:focus.sessionId,
    detail:focus.agentId?{kind:'run',id:focus.agentId}:null,...(focus.kind==='checklist'?{checklistSession:focus.sessionId}:{})});
}
async function inboxView($,h,ctx,state,settings){
  const data=await dataset($,ctx,state,settings);
  const detained=docket(data.discipline,Number.MAX_SAFE_INTEGER).filter(record=>record.sanction==='detain' && record.status==='active');
  const needsReview=data.reviews.some(review=>review.exemplar.state==='candidate' || review.findings.some(finding=>finding.state==='open'));
  const waits=pendingWaits(ctx);
  const section=(role,label,options={})=>h.Box({flexDirection:'row',alignItems:'center',gap:1,children:[
    roleIcon(h,state.surface,role,18,options,label),h.Text({bold:true,children:label}),
  ]});
  return h.Box({key:'panel-inbox',flexDirection:'column',gap:1,children:[
    ...(waits.length || detained.length || needsReview?[h.Text({bold:true,children:t('progress.waiting')})]:[]),
    ...waits.map(wait=>h.Text({key:'wait:'+wait.key,children:t('progress.wait.'+wait.kind,{time:durationText(Date.now()-wait.startedAt)})})),
    ...(detained.length?[section('other',t('overview.detained'),{detained:true}),
      ...detained.slice(0,3).map(record=>h.Box({key:'inbox-detention:'+record.id,flexDirection:'row',gap:1,alignItems:'center',children:[
        h.Box({flexGrow:1,flexShrink:1,minWidth:0,children:[h.Text({maxLines:1,wrap:'truncate',
          children:record.who+' · '+t('progress.waitAge',{time:durationText(Date.now()-record.at)})})]}),
        h.Button({key:'inbox-release:'+record.id,label:t('settings.details'),plain:true,onPress:()=>{
          focusOn(state,'jail');change($,state,{detail:{kind:'violation',id:record.id}});
        }}),
      ]})),
      h.Button({key:'overview-jail',label:t('panel.viewDetentions',{count:detained.length}),plain:true,onPress:()=>{
        focusOn(state,'jail');change($,state,{detail:null});
      }}),
    ]:[]),
    ...(needsReview || state.autoRun || state.autoResult?[section('review',t('panel.reviews')),reviewsView($,h,ctx,state,settings,data,true)]:[]),
    ...(!waits.length && !detained.length && !needsReview && !state.autoRun && !state.autoResult?[h.Text({dimColor:true,children:t('overview.calm')})]:[]),
  ]});
}

// Pinning is a project preference, but placement and dismissal belong to a
// particular session. A later thread in this project starts at its inbox.
export async function maybeOpenPinnedPane($,ctx,recheck=false){
  const state=stateFor(ctx);
  if(!masterIsEnabled() || state.opened || state.dismissed || state.pinOpening || state.pinChecked && !recheck)return;
  state.pinOpening=true;
  try{
    const settings=await loadProjectSettings($,ctx);
    state.pinChecked=true;
    if(settings.panelPinned && !state.opened && !state.dismissed){
      await $.ui.open({id:PANE,title:'Agent Arbiter'});
      if(!state.dismissed)state.opened=true;
    }
  }catch{state.pinChecked=false;}
  finally{state.pinOpening=false;}
}
export async function openRulesPane($,ctx,tab='rules',focus=null){
  const state=stateFor(ctx);state.tab=tab;state.data=null;state.diagnostics=null;state.confirm=null;state.detail=null;state.editor=null;
  focusOn(state,focus);
  state.opened=true;state.dismissed=false;
  void refreshStatus($,ctx);
  try{return await $.ui.open({id:PANE,title:'Agent Arbiter',focus:true});}
  catch(error){state.opened=false;throw error;}
}
export function registerRulesPane(on,failures=()=>0){
  on('session.attach',{surface:'desktop'},async($,e,next)=>{
    const result=await next(e);
    // Opening may wait for a render from the client, which needs the attach reply.
    try{void maybeOpenPinnedPane($,await observationContext($,{recoverPreferences:true}),true);}catch{ /* Retry at the prompt. */ }
    return result;
  });
  on('ui.close',{id:PANE},async($,e,next)=>{
    if(e.origin.kind==='person'){
      try{const state=stateFor(await observationContext($,{recoverPreferences:true}));state.dismissed=true;state.opened=false;}catch{ /* Close even without a project. */ }
    }
    return next(e);
  });
  on('ui.render',{component:'Pane',requestId:PANE},async($,e)=>{
    const h=$.ui.resolve(e);let ctx;
    try{ctx=await observationContext($,{recoverPreferences:true});}
    catch(error){return h.Box({flexDirection:'column',children:[h.Text({children:t('pane.unavailable')}),h.Text({children:String(error.message)}),h.Button({key:'refresh-rules',label:t('pane.retry'),onPress:()=>redraw($)})]});}
    const state=stateFor(ctx),showScope=!['rules','settings'].includes(state.tab) && !(state.tab==='citizens' && state.agentSection==='lessons');
    let settings,body;
    state.surface=e.surface;state.columns=Number.isFinite(e.props?.bodyColumns)?e.props.bodyColumns:60;
    try{settings=await loadProjectSettings($,ctx);}catch(error){body=h.Box({flexDirection:'column',gap:1,children:[h.Text({children:t('pane.unavailable')}),h.Text({children:String(error.message)}),h.Button({key:'reset-rules',label:t('pane.reset'),onPress:()=>askConfirmation($,state,'reset')})]});}
    try{
      if(state.confirm)body=confirmationView($,h,ctx,state);
      else if(state.tab==='progress')body=progressView($,h,ctx,state);
      else if(settings)body=state.tab==='inbox'?await inboxView($,h,ctx,state,settings):state.tab==='rules'?rulesView($,h,ctx,state,settings):state.tab==='violations'?await violationsView($,h,ctx,state,settings):state.tab==='citizens'?await citizensView($,h,ctx,state,settings):await settingsView($,h,ctx,state,settings);
    }catch(error){body=h.Text({children:errorText(error)});}
    return h.Box({flexDirection:'column',gap:1,children:[
      h.Box({flexDirection:'row',flexWrap:'wrap',gap:1,justifyContent:'space-between',children:[
        h.Text({bold:true,children:ctx.projectRoot.split('/').filter(Boolean).at(-1) || '/'}),
        h.Box({key:'panel-status',flexDirection:'row',alignItems:'center',gap:1,children:[
          h.Text({dimColor:true,children:!masterIsEnabled()?t('settings.disabledGlobally'):settings?t('pane.modeLabel.'+settings.mode):t('pane.unavailable')}),
          iconButton(h,'refresh-rules','↻',()=>refreshPane($,ctx,state,failures)),
        ]}),
      ]}),
      ...(settings && !state.confirm && !state.editor && (showScope || e.surface==='desktop')?[h.Box({flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:1,children:[
        ...(showScope?[h.Select({key:'panel-scope',value:state.scope,options:['thread','project'].map(value=>({value,label:t('panel.scope.'+value)})),
          onSelect:value=>{if(!state.pending && !state.autoRun)change($,state,{scope:value,data:null,pages:{},scoreScope:'project',historySession:null,detail:null,message:'',autoResult:null,translationMessage:null});}})]:[]),
        ...(e.surface==='desktop'?[h.Button({key:'pin-project',label:t(settings.panelPinned?'panel.unpin':'panel.pin'),plain:true,
          onPress:()=>mutate($,ctx,latest=>({...latest,panelPinned:!latest.panelPinned}))})]:[]),
      ]})]:[]),
      h.Box({key:'pane-menu',flexDirection:'row',gap:1,flexWrap:'wrap',children:Object.entries(MENU_ICONS).map(([tab,icon])=>{
        const label=t('pane.tab.'+tab);
        return h.Button({key:'tab-'+tab,label:icon+' '+label,...(state.tab===tab?{variant:'primary'}:{}),
          onPress:()=>{if(!state.pending)change($,state,{tab,editor:null,confirm:null,detail:null,data:null,message:''});}});
      })}),
      body,
      ...(state.pending || state.message?[h.Text({children:state.pending?t('settings.working'):state.message})]:[]),
    ]});
  });
}
