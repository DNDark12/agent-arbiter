import { observationContext } from './context.js';
import { ACTIONS, EFFECTS, JUDGE_MODELS, loadProjectSettings, updateProjectSettings, listRules, toggleBuiltin, createUserRule, updateUserRule, deleteUserRule } from './project-rules.js';
import { disciplineState, docket, releaseViolations } from './discipline.js';
import { t, ruleLabel, actionLabel, currentLanguage } from './i18n.js';
import { checkFinding, translateTexts, translated } from './review-assist.js';
import { sessionTimeline, recentSessions } from './history.js';
import { timelineRow } from './history-view.js';
import { progressGraph, progressItems, progressTitle } from './progress-view.js';
import { readProjectShared } from './events.js';
import {reduceScores,allProjectScoreRows,scoreUsage} from './scoring.js';
import {projectLessons,shareLessons,unshareLessons,loadLibrary,lessonEffects,experimentResults} from './lessons.js';
import {reduceReviews,decideFinding,decideExemplar,judgeUsage,JUDGE_MODEL,DAILY_TRIALS} from './judge.js';
import {refreshStatus,diagnostics,bandSnapshot} from './status.js';
import {changeProjectMode,changeGlobalConfig,globalConfig,purgeData,resetRules} from './panel-actions.js';
import {masterIsEnabled} from './control-state.js';
import {ROLES,roleOf} from './roles.js';
import {COLORS,levelRow,roleIcon,pillTrackSvg,svgOf} from './visuals.js';
import {quarantineProject} from './events.js';
import {pruneProject,RETENTION_DAYS} from './retention.js';

const PANE='arbiter-rules', PAGE_SIZE=6;
const MENU_ICONS={settings:'⚙︎',rules:'⚖︎',violations:'⚠︎',citizens:'◎'};
const SECTION_ICONS={history:'◷',scores:'▥',lessons:'▤',reviews:'✓'};
const states=new Map();
function key(ctx){return `${ctx.archiveRoot}:${ctx.projectId}`;}
function stateFor(ctx){
  if(!states.has(key(ctx)))states.set(key(ctx),{tab:'settings',search:'',group:'all',editor:null,confirm:null,message:'',
    pending:false,maintenance:false,diagnostics:null,data:null,pages:{},violationFilter:'all',agentSection:'scores',scoreScope:'project',scoreKind:'all',agentSearch:'',lessonScope:'project',reviewFilter:'pending',detail:null,
    busy:new Set(),autoRun:null,autoNotes:new Map(),translating:false});
  return states.get(key(ctx));
}
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
  state.pending=true;redraw($);
  try{
    const current=await observationContext($,{recoverPreferences:true});
    if(key(current)!==key(ctx))throw new Error(t('settings.projectChanged'));
    state.message=await action() || t('pane.saved');state.data=null;state.diagnostics=null;return true;
  }catch(error){state.message=errorText(error);return false;}
  finally{state.pending=false;redraw($);}
}
async function mutate($,ctx,edit){return runAction($,ctx,async()=>{await updateProjectSettings($,ctx,edit);await refreshStatus($,ctx);});}
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
      const active=(await disciplineState($,ctx,true)).violations.filter(record=>record.status==='active');
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
    change($,state,{confirm:null,editor:null,detail:null,...(confirmation.type==='reset'?{search:'',group:'all'}:{})});
  }
}
function groupOf(rule){const group=rule.action.split('.')[0];return rule.source==='user'?'custom':group==='fs'?'file':group==='exec'?'system':group;}
function editorFor(rule){return rule?{action:rule.action,target:rule.target,effect:rule.effect,original:{id:rule.id,action:rule.action,target:rule.target,effect:rule.effect}}:{action:'file.write',target:'**',effect:'ask',original:null};}
function confirmationView($,h,ctx,state){
  const c=state.confirm;
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Text({children:t(c.type==='reset'?'pane.confirm.reset':c.type==='delete'?'pane.confirm.delete':'settings.confirm.'+c.type,{rule:c.rule?ruleLabel(c.rule):'',count:c.count || 1,name:ctx.projectRoot.split('/').at(-1)})}),
    ...(c.lesson?[h.Text({children:c.lesson.text})]:[]),
    ...(['release','release-all'].includes(c.type)?[h.Input({key:'release-reason',label:t('settings.reason'),value:c.reason || '',onInput:value=>{c.reason=value;},onSubmit:value=>{c.reason=value;}})]:[]),
    h.Box({flexDirection:'row',gap:1,children:[
      h.Button({key:'confirm-'+c.type,label:t('pane.confirm.yes'),onPress:()=>confirmAction($,ctx)}),
      h.Button({key:'cancel-confirm',label:t('pane.cancel'),onPress:()=>change($,state,{confirm:null})}),
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
  if(!state.data){
    const events=(await readProjectShared($,ctx)).events,discipline=await disciplineState($,ctx,true,true);
    const reviews=reduceReviews(events,ctx.projectId);
    state.data={events,discipline,reviews,rows:reduceScores(events,ctx.projectId,discipline,settings.roles,reviews),
      lessons:await projectLessons($,ctx,settings),library:await loadLibrary($,ctx)};
  }
  return state.data;
}
function paged($,h,state,id,rows,size=PAGE_SIZE){
  const last=Math.ceil(rows.length/size)-1;
  const page=Math.max(0,Math.min(state.pages[id] || 0,last));
  const start=page*size,end=Math.min(rows.length,start+size);
  const step=(name,icon,target)=>h.Box({width:4,alignItems:'center',children:target<0 || target>last?[]:[
    iconButton(h,id+'-'+name,icon,()=>{state.pages[id]=target;redraw($);}),
  ]});
  const controls=last>0?[h.Box({key:'pager-'+id,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:1,children:[
    step('previous','‹',page-1),
    h.Text({dimColor:true,tabular:true,children:t('pane.range',{from:start+1,to:end,count:rows.length})}),
    step('next','›',page+1),
  ]})]:[];
  return {visible:rows.slice(start,end),controls};
}

function progressView($,h,ctx,state){
  const kind=state.progressKind;
  const {visible,controls}=paged($,h,state,'progress',progressItems(bandSnapshot(ctx),kind),12);
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Text({bold:true,children:progressTitle(kind)}),
    progressGraph(h,state.surface,kind,visible),
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
    const reviews=reduceReviews((await readProjectShared($,ctx)).events,ctx.projectId);
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
async function autoReview($,ctx,state,settings){
  if(state.autoRun)return;
  const items=(state.data?.reviews ?? []).flatMap(review=>review.findings.filter(finding=>finding.state==='open').map(finding=>({review,finding})));
  const model=settings.judgeModel ?? JUDGE_MODEL,run={done:0,total:items.length,confirmed:0,dismissed:0,unsure:0,failed:0};
  state.autoRun=run;state.message='';redraw($);
  try{
    for(const {review,finding} of items){
      let verdict=null;
      try{verdict=await checkFinding($,ctx,review,finding,model);}catch{ /* The finding stays open. */ }
      if(!verdict){run.failed+=1;state.autoNotes.set(finding.ref,t('pane.autoModelFailed'));}
      else if(verdict.decision==='unsure'){run.unsure+=1;state.autoNotes.set(finding.ref,verdict.why || t('pane.autoUnsure'));}
      else if(await decide($,ctx,'finding',finding.ref,verdict.decision,{auto:true,model})){
        run[verdict.decision]+=1;state.autoNotes.delete(finding.ref);
      }else{run.failed+=1;state.autoNotes.set(finding.ref,state.message);}
      run.done+=1;redraw($);
    }
  }finally{
    state.autoRun=null;state.message=t('pane.autoDone',run)+(run.failed?' '+t('pane.autoFailed',run):'');redraw($);
  }
}
async function translatePage($,state,reviews){
  if(state.translating)return;
  const language=currentLanguage();
  state.translating=true;redraw($);
  try{
    const texts=reviews.flatMap(review=>[...review.findings.flatMap(finding=>[finding.claim,finding.evidence]),review.exemplar.why]);
    const added=await translateTexts($,texts,language);
    state.message=added?t('pane.translated',{count:added}):t('pane.translateNone');
  }catch{state.message=t('pane.translationUnavailable');}
  finally{state.translating=false;redraw($);}
}
const shown=text=>translated(text,currentLanguage()) ?? text;
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
    h.Select({key:'score-scope',label:t('settings.scope'),value:state.scoreScope,options:['project','all'].map(value=>({value,label:t('settings.scope.'+value)})),onSelect:value=>{state.pages.scores=0;change($,state,{scoreScope:value});}}),
    h.Select({key:'score-kind',label:t('pane.agentKind'),value:state.scoreKind,options:['all','main','subagent'].map(value=>({value,label:t(value==='all'?'settings.all':'pane.agentKind.'+value)})),onSelect:value=>{state.pages.scores=0;change($,state,{scoreKind:value});}}),
    h.Input({key:'agent-search',label:t('settings.agentSearch'),value:state.agentSearch,onInput:value=>{state.pages.scores=0;change($,state,{agentSearch:value});},onSubmit:value=>{state.pages.scores=0;change($,state,{agentSearch:value});}}),
    ...(state.scoreScope==='all'?[h.Text({dimColor:true,children:t('settings.allScores',{count:data.allScores.projects})})]:[]),
    ...(visible.length?visible.map(row=>{
      // Main and unidentified rows are not agent types: a role set for them would
      // override the role each turn's brief gives.
      const role=!seen.has(row.name) && state.scoreScope==='project' && row.kind==='subagent' && row.name!=='unidentified-agent';seen.add(row.name);
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
    ...(state.scoreScope==='project' && state.scoreKind==='all'?Object.keys(settings.roles).filter(name=>!data.rows.some(row=>row.name===name)).map(name=>h.Box({flexDirection:'column',children:[h.Text({children:name}),roleSelect($,h,ctx,name,settings)]})):[]),
  ]});
}
function lessonsView($,h,ctx,state,settings,data){
  const library=state.lessonScope==='library',rows=library?data.library:data.lessons;
  const {visible,controls}=paged($,h,state,'lessons',rows);
  const effects=lessonEffects(data.events,ctx.projectId,data.lessons,data.discipline);
  const experiment=experimentResults(data.events,ctx.projectId,data.discipline);
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Select({key:'lesson-scope',label:t('settings.scope'),value:state.lessonScope,options:['project','library'].map(value=>({value,label:t('settings.scope.'+value)})),onSelect:value=>{state.pages.lessons=0;change($,state,{lessonScope:value});}}),
    h.Text({dimColor:true,children:t('settings.libraryHint')}),
    ...(settings.lessonExperiment || experiment.held?[h.Text({children:t('tbl.experiment',experiment)})]:[]),
    ...(visible.length?visible.map(lesson=>{
      const effect=effects.get(lesson.id) || {taught:0,repeatsAfter:0},shared=data.library.some(entry=>entry.id===lesson.id);
      return h.Box({flexDirection:'column',gap:1,children:[
        h.Text({bold:true,children:`${lesson.agentName} · ${lesson.role}`}),h.Text({children:lesson.text}),
        ...(!library?[h.Text({dimColor:true,children:t('settings.lessonStats',{count:lesson.count,taught:effect.taught,repeats:effect.repeatsAfter})})]:[]),
        ...(library?[h.Button({key:'unshare:'+lesson.id,label:t('settings.unshare'),onPress:()=>askConfirmation($,state,'unshare',{lesson})})]:
          shared?[h.Text({dimColor:true,children:t('pane.sharedAlready')})]:[h.Button({key:'share:'+lesson.id,label:t('pane.share'),onPress:()=>askConfirmation($,state,'share',{lesson})})]),
      ]});
    }):[h.Text({dimColor:true,children:t(library?'cmd.libraryNone':'pane.lessonsNone')})]),...controls,
  ]});
}
function reviewsView($,h,ctx,state,settings,data){
  const pending=review=>review.findings.some(finding=>finding.state==='open');
  const suggested=review=>!pending(review) && review.exemplar.state==='candidate';
  const kindOf=review=>pending(review)?'pending':suggested(review)?'suggested':'completed';
  const rows=[...data.reviews].reverse().filter(review=>state.reviewFilter==='all' || kindOf(review)===state.reviewFilter);
  const noted=data.reviews.reduce((sum,review)=>sum+review.findings.filter(finding=>finding.state==='noted').length,0);
  const waitingCount=data.reviews.reduce((sum,review)=>sum+review.findings.filter(finding=>finding.state==='open').length,0);
  const answer=(key,label,ref,run)=>h.Button({key,label:state.busy.has(ref)?t('settings.working'):label,onPress:()=>state.busy.has(ref) || state.autoRun?undefined:run()});
  const {visible,controls}=paged($,h,state,'reviews',rows),usage=judgeUsage(data.events,ctx.projectId);
  const canTranslate=currentLanguage()!=='en' && visible.length>0;
  const detail=state.detail?.kind==='review'?data.reviews.find(review=>review.id===state.detail.id):null;
  if(detail)return h.Box({flexDirection:'column',gap:1,children:[
    iconButton(h,'back-reviews','←',()=>change($,state,{detail:null})),
    h.Text({bold:true,children:`${t('settings.details')} · ${detail.citizen?.kind==='main'?t('pane.agentKind.main'):detail.citizen?.name || 'agent'}`}),
    h.Text({dimColor:true,children:`${localTime(detail.at)} · ${detail.ref}`}),
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
    h.Text({children:t('tbl.judgeHead',{state:t(settings.judge?'cmd.on':'cmd.off'),model:settings.judgeModel ?? JUDGE_MODEL,today:usage.today,cap:DAILY_TRIALS,trials:usage.trials,input:usage.inputTokens,output:usage.outputTokens})}),
    h.Text({dimColor:true,children:t('pane.reviewsHint')}),
    ...(noted?[h.Text({dimColor:true,children:t('pane.autoNoted',{count:noted})})]:[]),
    ...(state.autoRun?[h.Text({children:t('pane.autoRunning',state.autoRun)})]:waitingCount||canTranslate?[h.Box({flexDirection:'row',gap:1,flexWrap:'wrap',children:[
      ...(waitingCount?[h.Button({key:'auto-review',label:t('pane.auto',{count:waitingCount}),onPress:()=>{void autoReview($,ctx,state,settings);}})]:[]),
      ...(canTranslate?[h.Button({key:'translate-reviews',label:'文 '+t(state.translating?'pane.translating':'pane.translateAction'),onPress:()=>{void translatePage($,state,visible);}})]:[]),
    ]})]:[]),
    ...(waitingCount && !state.autoRun?[h.Text({dimColor:true,children:t('pane.autoHint',{model:settings.judgeModel ?? JUDGE_MODEL})})]:[]),
    h.Select({key:'review-filter',label:t('settings.filter'),value:state.reviewFilter,options:['pending','suggested','completed','all'].map(value=>({value,label:t('settings.'+value)})),onSelect:value=>{state.pages.reviews=0;change($,state,{reviewFilter:value,detail:null});}}),
    ...(visible.length?visible.map(review=>h.Box({key:'review-row:'+review.id,flexDirection:'column',gap:1,children:[
      h.Box({flexDirection:'row',alignItems:'center',gap:1,children:[
        roleIcon(h,state.surface,review.citizen?.kind==='main'?'main':review.role,24,{animate:true},t('role.'+review.role)),
        h.Box({flexDirection:'row',flexWrap:'wrap',flexShrink:1,columnGap:1,children:[
          h.Text({bold:true,children:review.citizen?.kind==='main'?t('pane.agentKind.main'):review.citizen?.name || 'agent'}),
          h.Text({dimColor:true,children:`${localTime(review.at)} · ${t('role.'+review.role)} · ${t('difficulty.'+review.difficulty)}`}),
        ]}),
      ]}),
      levelRow(h,state.surface,{key:'quality',label:t('score.quality'),figure:review.quality===null?t('score.notReviewed'):t('score.outOf100',{value:review.quality}),
        bar:review.quality===null?null:{value:review.quality,max:100,color:COLORS.quality}},state.columns),
      // What waits is shown here with its two answers, so a decision needs no trip into the details.
      ...review.findings.filter(finding=>finding.state==='open').map(finding=>h.Box({key:'open:'+finding.ref,flexDirection:'column',gap:1,children:[
        h.Text({children:`${t('severity.'+finding.severity)} · ${t('dimension.'+finding.dimension)}: ${shown(finding.claim)}`}),
        ...(state.autoNotes.has(finding.ref)?[h.Text({dimColor:true,children:t('pane.autoNote',{why:shown(state.autoNotes.get(finding.ref))})})]:[]),
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
function historyView($,h,ctx,state,data){
  const sessions=recentSessions(data.events,ctx.projectId,20);
  const chosen=sessions.some(session=>session.sessionId===state.historySession)?state.historySession:
    sessions.some(session=>session.sessionId===ctx.sessionId)?ctx.sessionId:sessions[0]?.sessionId;
  if(!chosen)return h.Text({dimColor:true,children:t('history.empty')});
  const timeline=sessionTimeline(data.events,ctx.projectId,chosen,{discipline:data.discipline,reviews:data.reviews});
  const picker=h.Select({key:'history-session',label:t('history.session'),value:chosen,options:sessions.map(session=>({value:session.sessionId,
    label:`${session.sessionId===ctx.sessionId?t('history.thisSession')+' · ':''}${localTime(session.endedAt)} · ${t('history.sessionFigure',{agents:session.agents,calls:session.calls})}`})),
    onSelect:value=>{state.pages.history=0;change($,state,{historySession:value,detail:null});}});
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
  const {visible,controls}=paged($,h,state,'history',[...runs].reverse(),20);
  return h.Box({flexDirection:'column',gap:1,children:[picker,
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
  const body=state.agentSection==='lessons'?lessonsView($,h,ctx,state,settings,data):state.agentSection==='reviews'?reviewsView($,h,ctx,state,settings,data):
    state.agentSection==='history'?historyView($,h,ctx,state,data):await scoresView($,h,ctx,state,settings,data);
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Select({key:'agent-section',label:t('settings.agentSection'),value:state.agentSection,options:Object.entries(SECTION_ICONS).map(([value,icon])=>({value,label:icon+' '+t('settings.section.'+value)})),onSelect:value=>change($,state,{agentSection:value,detail:null,data:null})}),body,
  ]});
}
async function settingsView($,h,ctx,state,settings,failures){
  let configs=[],configError='';try{configs=await globalConfig($);}catch{configError=t('settings.configUnavailable');}
  const enabled=configs.find(row=>row.key==='agent-arbiter.enabled'),language=configs.find(row=>row.key==='agent-arbiter.language');
  if(!enabled || !language)configError=t('settings.configUnavailable');
  if(!state.diagnostics){try{state.diagnostics=await diagnostics($,ctx,failures());}catch(error){configError=errorText(error);}}
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Text({bold:true,children:t('settings.global')}),
    ...(enabled?[h.Button({key:'global-enabled',label:t('settings.enabled')+': '+t(enabled.value?'pane.toggle.on':'pane.toggle.off')+(enabled.isLocked?' · '+t('settings.locked'):''),onPress:()=>runAction($,ctx,async()=>{await changeGlobalConfig($,enabled.key,!enabled.value);await refreshStatus($,ctx);})})]:[]),
    ...(language?[h.Select({key:'global-language',label:t('pane.language')+(language.isLocked?' · '+t('settings.locked'):''),value:language.value,options:['auto','en','vi'].map(value=>({value,label:value==='auto'?t('settings.automatic'):value==='vi'?'Tiếng Việt':'English'})),onSelect:value=>runAction($,ctx,async()=>{await changeGlobalConfig($,language.key,value);})})]:[]),
    ...(configError?[h.Text({children:configError})]:[]),
    h.Text({bold:true,children:t('settings.project')}),
    h.Select({key:'court-mode',label:t('pane.mode'),value:settings.mode,options:['enforce','observe','off'].map(value=>({value,label:t('pane.modeLabel.'+value)})),onSelect:value=>runAction($,ctx,async()=>{await changeProjectMode($,ctx,value);})}),
    h.Text({dimColor:true,children:t('pane.mode.'+settings.mode)}),
    ...(!masterIsEnabled()?[h.Text({bold:true,children:t('settings.disabledGlobally')})]:[]),
    ...settings.hardened?[h.Text({children:t('settings.hardened')})]:[],
    ...['judge','lessons','lessonExperiment'].map((name,index)=>h.Button({key:['toggle-judge','toggle-lessons','toggle-experiment'][index],label:t(['pane.judge','pane.lessons','settings.experiment'][index])+': '+t(settings[name]?'pane.toggle.on':'pane.toggle.off'),onPress:()=>mutate($,ctx,latest=>({...latest,[name]:!latest[name]}))})),
    h.Select({key:'judge-model',label:t('settings.judgeModel'),value:settings.judgeModel ?? 'haiku',options:JUDGE_MODELS.map(value=>({value,label:t('settings.judgeModel.'+value)})),onSelect:value=>mutate($,ctx,latest=>({...latest,judgeModel:value}))}),
    h.Text({dimColor:true,children:t('pane.judgeHint')}),h.Text({dimColor:true,children:t('settings.experimentHint')}),
    h.Text({bold:true,children:t('settings.diagnostics')}),
    ...(state.diagnostics?[h.Text({children:t('cmd.status',state.diagnostics)})]:[]),
    h.Button({key:'refresh-diagnostics',label:t('settings.inspect'),onPress:()=>runAction($,ctx,async()=>{state.diagnostics=await diagnostics($,ctx,failures());return t('settings.inspected');})}),
    h.Button({key:'show-maintenance',label:t(state.maintenance?'settings.hideMaintenance':'settings.maintenance'),onPress:()=>change($,state,{maintenance:!state.maintenance})}),
    ...(state.maintenance?[
      h.Text({dimColor:true,children:t('settings.maintenanceHint',{days:RETENTION_DAYS})}),
      ...['quarantine','cleanup','reset','purge-project','purge-all'].map(type=>h.Button({key:type==='reset'?'reset-rules':type,label:t('settings.action.'+type)+'…',onPress:()=>askConfirmation($,state,type)})),
      h.Text({dimColor:true,children:t('settings.advancedCommands')}),
    ]:[]),
  ]});
}
// focus: what the band's Open came for. 'jail' shows the detained agents,
// 'review' the decisions waiting; either way without a line in the chat.
// Moves the pane to what waits: the detained agents, or the decisions.
function focusOn(state,focus){
  if(focus==='jail')Object.assign(state,{tab:'violations',violationFilter:'active',pages:{...state.pages,violations:0}});
  if(focus==='review')Object.assign(state,{tab:'citizens',agentSection:'reviews',reviewFilter:'pending',pages:{...state.pages,reviews:0}});
  if(focus?.kind==='progress')Object.assign(state,{tab:'progress',progressKind:focus.key,pages:{...state.pages,progress:0}});
  // A run pressed in the band: its session's timeline, at that run.
  if(focus?.kind==='run')Object.assign(state,{tab:'citizens',agentSection:'history',historySession:focus.sessionId,detail:focus.agentId?{kind:'run',id:focus.agentId}:null});
}
// The overview at the top of the pane, after the progress tracker people liked:
// a state pill, a grid of figures under small capital labels, a chip for each
// kind of thing that waits, and a line saying when nothing does.
function overviewView($,h,ctx,state,settings,surface){
  const snapshot=bandSnapshot(ctx);
  if(!snapshot){void refreshStatus($,ctx);return null;}
  const waiting=snapshot.pending+snapshot.detained,Svg=svgOf(h,surface);
  const pillLabel=waiting?t('overview.waitingPill',{count:waiting}):t('overview.calmPill');
  const pillColor=snapshot.detained?COLORS.jail:waiting?COLORS.review:COLORS.trust;
  const pill=Svg?(()=>{const drawn=pillTrackSvg({label:pillLabel,color:pillColor});return Svg({source:drawn.source,alt:pillLabel,width:drawn.width,height:drawn.height});})()
    :h.Text({bold:true,color:pillColor,children:pillLabel});
  const cell=(key,label,value)=>h.Box({key:'overview-'+key,flexDirection:'column',width:20,children:[
    h.Text({dimColor:true,size:'caption',maxLines:1,wrap:'truncate',children:label.toLocaleUpperCase()}),
    h.Text({bold:true,tabular:true,children:String(value)}),
  ]});
  const chip=(key,label,focus)=>h.Button({key:'overview-'+key,label,onPress:()=>{focusOn(state,focus);change($,state,{data:null,detail:null,editor:null,confirm:null,message:''});}});
  return h.Box({key:'overview',flexDirection:'column',gap:1,children:[
    h.Box({flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:1,children:[
      h.Box({flexDirection:'row',alignItems:'center',gap:1,children:[h.Text({color:pillColor,children:'●'}),h.Text({weight:'semibold',children:t('overview.state')})]}),pill]}),
    h.Box({flexDirection:'row',flexWrap:'wrap',rowGap:1,columnGap:2,children:[
      cell('waiting',t('overview.waiting'),waiting),
      cell('decided',t('overview.decided'),snapshot.decided),
      cell('detained',t('overview.detained'),snapshot.detained),
      cell('judge',t('overview.judge'),`${snapshot.judgedToday ?? 0}/${DAILY_TRIALS}`),
      cell('violations',t('overview.violations'),snapshot.violations ?? 0),
      cell('mode',t('overview.mode'),t('pane.modeLabel.'+settings.mode)),
    ]}),
    ...(waiting?[h.Box({flexDirection:'row',gap:1,flexWrap:'wrap',children:[
      ...(snapshot.pending?[chip('reviews',t('overview.chipReviews',{count:snapshot.pending}),'review')]:[]),
      ...(snapshot.detained?[chip('jail',t('overview.chipJail',{count:snapshot.detained}),'jail')]:[]),
    ]})]:[]),
    ...(waiting?[]:[h.Box({flexDirection:'column',children:[
      h.Box({flexDirection:'row',gap:1,children:[h.Text({color:COLORS.trust,children:'✓'}),h.Text({bold:true,children:t('overview.calm')})]}),
      h.Text({dimColor:true,children:t('overview.calmHint')}),
    ]})]),
  ]});
}
export async function openRulesPane($,ctx,tab='rules',focus=null){
  const state=stateFor(ctx);state.tab=tab;state.data=null;state.diagnostics=null;state.confirm=null;state.detail=null;state.editor=null;
  focusOn(state,focus);
  void refreshStatus($,ctx);
  return $.ui.open({id:PANE,title:'Agent Arbiter',focus:true});
}
export function registerRulesPane(on,failures=()=>0){
  on('ui.render',{component:'Pane',requestId:PANE},async($,e)=>{
    const h=$.ui.resolve(e);let ctx;
    try{ctx=await observationContext($,{recoverPreferences:true});}
    catch(error){return h.Box({flexDirection:'column',children:[h.Text({children:t('pane.unavailable')}),h.Text({children:String(error.message)}),h.Button({key:'refresh-rules',label:t('pane.retry'),onPress:()=>redraw($)})]});}
    const state=stateFor(ctx);let settings,body;
    state.surface=e.surface;state.columns=Number.isFinite(e.props?.bodyColumns)?e.props.bodyColumns:60;
    try{settings=await loadProjectSettings($,ctx);}catch(error){body=h.Box({flexDirection:'column',gap:1,children:[h.Text({children:t('pane.unavailable')}),h.Text({children:String(error.message)}),h.Button({key:'reset-rules',label:t('pane.reset'),onPress:()=>askConfirmation($,state,'reset')})]});}
    try{
      if(state.pending)body=h.Text({children:t('settings.working')});
      else if(state.confirm)body=confirmationView($,h,ctx,state);
      else if(state.tab==='progress')body=progressView($,h,ctx,state);
      else if(settings)body=state.tab==='rules'?rulesView($,h,ctx,state,settings):state.tab==='violations'?await violationsView($,h,ctx,state,settings):state.tab==='citizens'?await citizensView($,h,ctx,state,settings):await settingsView($,h,ctx,state,settings,failures);
    }catch(error){body=h.Text({children:errorText(error)});}
    return h.Box({flexDirection:'column',gap:1,children:[
      h.Box({flexDirection:'row',flexWrap:'wrap',gap:1,justifyContent:'space-between',children:[h.Text({bold:true,children:t('settings.title')}),h.Text({dimColor:true,children:!masterIsEnabled()?t('settings.disabledGlobally'):settings?t('pane.modeLabel.'+settings.mode):t('pane.unavailable')})]}),
      h.Text({dimColor:true,children:t('pane.scope',{name:ctx.projectRoot.split('/').filter(Boolean).at(-1) || '/'})}),
      ...(settings && !state.pending && !state.confirm && !state.editor?[overviewView($,h,ctx,state,settings,e.surface)].filter(Boolean):[]),
      ...(!state.pending?[h.Box({key:'pane-menu',flexDirection:'row',gap:1,flexWrap:'wrap',children:Object.entries(MENU_ICONS).map(([tab,icon])=>{
        const label=t('pane.tab.'+tab);
        return h.Button({key:'tab-'+tab,label:icon+' '+label,...(state.tab===tab?{variant:'primary'}:{}),
          onPress:()=>change($,state,{tab,editor:null,confirm:null,detail:null,data:null,message:''})});
      })})]:[]),
      body,
      h.Box({flexDirection:'row',gap:1,flexWrap:'wrap',justifyContent:'space-between',children:[h.Text({dimColor:!state.message,children:state.message || t('pane.noPending')}),
        ...(!state.pending?[iconButton(h,'refresh-rules','↻',()=>{void refreshStatus($,ctx);change($,state,{data:null,diagnostics:null});})]:[])]}),
    ]});
  });
}
