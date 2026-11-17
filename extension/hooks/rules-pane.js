import { observationContext } from './context.js';
import { ACTIONS, EFFECTS, loadProjectSettings, saveProjectSettings, listRules, toggleBuiltin, createUserRule, updateUserRule, deleteUserRule } from './project-rules.js';
import { disciplineState, docket, releaseViolations } from './discipline.js';
import { t, ruleLabel, actionLabel, currentLanguage } from './i18n.js';
import { readProject } from './events.js';
import { reduceScores } from './scoring.js';
import { projectLessons, shareLessons } from './lessons.js';
import { reduceReviews, decideFinding, decideExemplar } from './judge.js';

const PANE='arbiter-rules', PAGE_SIZE=6;
const states=new Map(),mutations=new Map();
function key(ctx){return `${ctx.archiveRoot}:${ctx.projectId}`;}
function stateFor(ctx){
  if(!states.has(key(ctx)))states.set(key(ctx),{tab:'rules',search:'',group:'all',page:0,editor:null,confirm:null,message:''});
  return states.get(key(ctx));
}
function redraw($){$.ui.invalidate('ui.render');}
function change($,state,values){Object.assign(state,values);redraw($);}
function errorText(error){return t('pane.failed',{error:error instanceof Error?error.message:String(error)});}
async function mutate($,ctx,edit){
  const state=stateFor(ctx),id=key(ctx);
  const pending=(mutations.get(id) || Promise.resolve()).then(async()=>{
    try{await saveProjectSettings($,ctx,edit(await loadProjectSettings($,ctx)));state.message=t('pane.saved');return true;}
    catch(error){state.message=errorText(error);return false;}
  });
  mutations.set(id,pending);
  try{return await pending;}finally{if(mutations.get(id)===pending)mutations.delete(id);redraw($);}
}
async function saveEditor($,ctx){
  const state=stateFor(ctx),editor=state.editor;if(!editor)return;
  if(!editor.target.trim()){change($,state,{message:t('pane.validation')});return;}
  const wanted={action:editor.action,target:editor.target,effect:editor.effect};
  const saved=await mutate($,ctx,latest=>editor.original?
    updateUserRule(latest,editor.original.id,wanted,editor.original):createUserRule(latest,{...wanted,id:`user:${crypto.randomUUID()}`}));
  if(saved)change($,state,{editor:null,tab:'rules',group:'custom',search:'',page:0});
}
async function confirmAction($,ctx){
  const state=stateFor(ctx),confirmation=state.confirm;if(!confirmation)return;
  if(confirmation.type==='delete'){
    if(await mutate($,ctx,latest=>deleteUserRule(latest,confirmation.rule.id,confirmation.rule)))change($,state,{confirm:null,message:t('pane.deleted')});
    return;
  }
  let mode='enforce';try{mode=(await loadProjectSettings($,ctx)).mode;}catch{ /* Explicit recovery works with corrupt preferences. */ }
  try{await saveProjectSettings($,ctx,{mode});change($,state,{confirm:null,editor:null,tab:'rules',group:'all',search:'',page:0,message:t('pane.resetDone')});}
  catch(error){change($,state,{message:errorText(error)});}
}
async function release($,ctx,id){
  try{await releaseViolations($,ctx,[id],{kind:'ui',origin:'ui',id:crypto.randomUUID()});stateFor(ctx).message=t('pane.released');}
  catch(error){stateFor(ctx).message=errorText(error);}
  redraw($);
}
function groupOf(rule){const group=rule.action.split('.')[0];return rule.source==='user'?'custom':group==='fs'?'file':group;}
function editorFor(rule){return rule?{action:rule.action,target:rule.target,effect:rule.effect,original:{id:rule.id,action:rule.action,target:rule.target,effect:rule.effect}}:{action:'file.write',target:'**',effect:'ask',original:null};}
function confirmationView($,h,ctx,state){
  const c=state.confirm;
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Text({children:t(c.type==='reset'?'pane.confirm.reset':'pane.confirm.delete',{rule:c.rule?ruleLabel(c.rule):''})}),
    h.Box({flexDirection:'row',gap:1,children:[
      h.Button({key:c.type==='reset'?'confirm-reset':'confirm-delete',label:t('pane.confirm.yes'),onPress:()=>confirmAction($,ctx)}),
      h.Button({key:'cancel-confirm',label:t('pane.cancel'),onPress:()=>change($,state,{confirm:null})}),
    ]}),
  ]});
}
function editorView($,h,ctx,state){
  const e=state.editor,command=e.action==='bash.command';
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Button({key:'back-rules',label:t('pane.back'),plain:true,onPress:()=>change($,state,{editor:null})}),
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
  const page=Math.max(0,Math.min(state.page,Math.ceil(filtered.length/PAGE_SIZE)-1));
  const visible=filtered.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Box({flexDirection:'row',flexWrap:'wrap',gap:1,children:[
      h.Input({key:'rule-search',label:t('pane.search'),value:state.search,placeholder:t('pane.searchHint'),onInput:value=>change($,state,{search:value,page:0}),onSubmit:value=>change($,state,{search:value,page:0})}),
      h.Button({key:'new-rule',label:'+ '+t('pane.add'),variant:'primary',onPress:()=>change($,state,{editor:editorFor(null),message:''})}),
    ]}),
    h.Box({flexDirection:'row',flexWrap:'wrap',gap:1,justifyContent:'space-between',children:[
      h.Select({key:'rule-group',value:state.group,options:['all','git','db','file','package','custom'].map(value=>({value,label:t('pane.group.'+value)})),onSelect:value=>change($,state,{group:value,page:0})}),
      h.Text({dimColor:true,children:t('pane.count',{count:filtered.length,enabled:filtered.filter(rule=>rule.enabled).length})}),
    ]}),
    ...visible.map(rule=>h.Box({key:'row:'+rule.id,flexDirection:'row',flexWrap:'wrap',gap:1,alignItems:'center',justifyContent:'space-between',children:[
      h.Box({flexDirection:'column',flexGrow:1,flexShrink:1,children:[
        h.Text({bold:true,children:ruleLabel(rule)}),
        h.Text({dimColor:true,children:`${t(rule.source==='user'?'pane.group.custom':'pane.group.'+groupOf(rule))} · ${t('effect.'+rule.effect)}`}),
      ]}),
      ...(rule.source==='builtin'?[
        h.Button({key:'toggle:'+rule.id,label:t(rule.enabled?'pane.toggle.on':'pane.toggle.off'),onPress:()=>mutate($,ctx,latest=>toggleBuiltin(latest,rule.id))}),
      ]:[
        h.Button({key:'edit:'+rule.id,label:t('pane.edit'),onPress:()=>change($,state,{editor:editorFor(rule),message:''})}),
        h.Button({key:'delete:'+rule.id,label:t('pane.remove'),onPress:()=>change($,state,{confirm:{type:'delete',rule:{...rule}},message:''})}),
      ]),
    ]})),
    ...(visible.length?[]:[h.Text({dimColor:true,children:t('pane.empty')})]),
    h.Box({flexDirection:'row',gap:1,justifyContent:'space-between',children:[
      h.Text({dimColor:true,children:t('pane.range',{from:filtered.length?page*PAGE_SIZE+1:0,to:Math.min(filtered.length,(page+1)*PAGE_SIZE),count:filtered.length})}),
      ...(page>0?[h.Button({key:'page-previous',label:t('pane.previous'),onPress:()=>change($,state,{page:page-1})})]:[]),
      ...((page+1)*PAGE_SIZE<filtered.length?[h.Button({key:'page-next',label:t('pane.next'),onPress:()=>change($,state,{page:page+1})})]:[]),
    ]}),
  ]});
}
async function violationsView($,h,ctx){
  let records;try{records=docket(await disciplineState($,ctx,true),20);}catch{return h.Text({children:t('pane.docketError')});}
  return h.Box({flexDirection:'column',gap:1,children:records.length?records.map(record=>h.Box({flexDirection:'column',children:[
    h.Text({bold:true,children:record.who}),
    h.Text({children:`${t('sanction.'+record.sanction)} · ${record.points} · ${t('status.'+record.status)}`}),
    h.Text({dimColor:true,children:record.ruleIds.map(id=>id.startsWith('user:')?id:t('rule.'+id)).join(', ')}),
    ...(record.status==='active'?[h.Button({key:'release:'+record.id,label:t('pane.release',{who:record.who}),onPress:()=>release($,ctx,record.id)})]:[]),
  ]})):[h.Text({dimColor:true,children:t('pane.docketNone')})]});
}
async function share($,ctx,lesson){
  try{const added=await shareLessons($,ctx,[lesson]);stateFor(ctx).message=t(added.length?'pane.shared':'pane.sharedAlready');}
  catch(error){stateFor(ctx).message=errorText(error);}
  redraw($);
}
async function decide($,ctx,kind,ref,decision){
  const state=stateFor(ctx),source={kind:'ui',origin:'ui',id:crypto.randomUUID()};
  try{
    const reviews=reduceReviews((await readProject($,ctx)).events,ctx.projectId);
    const done=kind==='finding'?await decideFinding($,ctx,reviews,ref,decision,source):await decideExemplar($,ctx,reviews,ref,decision,source);
    state.message=t(done?'pane.decided':'pane.decideGone');
  }catch(error){state.message=errorText(error);}
  redraw($);
}
// Scores and lessons are read-only here; the person switches the judge and
// lessons, decides findings and exemplars, and shares lessons.
async function citizensView($,h,ctx,settings){
  let rows=[],lessons=[],reviews=[];
  try{
    const discipline=await disciplineState($,ctx,true),events=(await readProject($,ctx)).events;
    reviews=reduceReviews(events,ctx.projectId);
    rows=reduceScores(events,ctx.projectId,discipline,settings.roles,reviews);
    lessons=await projectLessons($,ctx,settings);
  }catch{return h.Text({children:t('pane.docketError')});}
  const open=reviews.flatMap(review=>review.findings.filter(finding=>finding.state==='open').map(finding=>({review,finding}))).slice(-4);
  const candidates=reviews.filter(review=>review.exemplar.state==='candidate').slice(-2);
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Box({flexDirection:'row',flexWrap:'wrap',gap:1,justifyContent:'space-between',alignItems:'center',children:[
      h.Text({bold:true,children:t('pane.judge')}),
      h.Button({key:'toggle-judge',label:t(settings.judge?'pane.toggle.on':'pane.toggle.off'),onPress:()=>mutate($,ctx,latest=>({...latest,judge:!latest.judge}))}),
    ]}),
    h.Text({dimColor:true,children:t('pane.judgeHint')}),
    ...open.map(({review,finding})=>h.Box({flexDirection:'column',children:[
      h.Text({children:`${review.citizen?.name ?? 'agent'} · ${finding.severity} · ${finding.dimension}`}),
      h.Text({children:finding.claim}),h.Text({dimColor:true,children:finding.evidence}),
      h.Box({flexDirection:'row',gap:1,children:[
        h.Button({key:'confirm:'+finding.ref,label:t('pane.confirmFinding'),onPress:()=>decide($,ctx,'finding',finding.ref,'confirmed')}),
        h.Button({key:'dismiss:'+finding.ref,label:t('pane.dismissFinding'),onPress:()=>decide($,ctx,'finding',finding.ref,'dismissed')}),
      ]}),
    ]})),
    ...candidates.map(review=>h.Box({flexDirection:'column',children:[
      h.Text({children:`${t('pane.exemplar')} · ${review.citizen?.name ?? 'agent'} · ${review.quality}`}),
      h.Text({children:review.exemplar.why}),
      h.Box({flexDirection:'row',gap:1,children:[
        h.Button({key:'approve:'+review.ref,label:t('pane.approve'),onPress:()=>decide($,ctx,'exemplar',review.ref,'approved')}),
        h.Button({key:'reject:'+review.ref,label:t('pane.reject'),onPress:()=>decide($,ctx,'exemplar',review.ref,'rejected')}),
      ]}),
    ]})),
    h.Text({bold:true,children:t('pane.scores')}),
    ...(rows.length?rows.slice(0,PAGE_SIZE).map(row=>h.Box({flexDirection:'column',children:[
      h.Text({bold:true,children:row.name+(row.model?'@'+row.model:'')}),
      h.Text({children:t('pane.score',{role:row.role,trust:row.trust,runs:row.runs,clean:row.cleanRuns,fines:row.fines,detentions:row.detentions})+
        ' · '+(row.reviews?t('pane.quality',{quality:row.quality,reviews:row.reviews}):t('pane.qualityNone'))+(row.detained?' · '+t('sanction.detain'):'')}),
    ]})):[h.Text({dimColor:true,children:t('pane.scoresNone')})]),
    h.Box({flexDirection:'row',flexWrap:'wrap',gap:1,justifyContent:'space-between',alignItems:'center',children:[
      h.Text({bold:true,children:t('pane.lessons')}),
      h.Button({key:'toggle-lessons',label:t(settings.lessons?'pane.toggle.on':'pane.toggle.off'),onPress:()=>mutate($,ctx,latest=>({...latest,lessons:!latest.lessons}))}),
    ]}),
    h.Text({dimColor:true,children:t('pane.lessonsHint')}),
    ...(lessons.length?lessons.slice(0,PAGE_SIZE).map(lesson=>h.Box({flexDirection:'column',children:[
      h.Text({children:`${lesson.agentName} (${lesson.role}) · ${lesson.count}×`}),
      h.Text({dimColor:true,children:lesson.text}),
      h.Button({key:'share:'+lesson.id,label:t('pane.share'),onPress:()=>share($,ctx,lesson)}),
    ]})):[h.Text({dimColor:true,children:t('pane.lessonsNone')})]),
  ]});
}
function settingsView($,h,ctx,state,settings){
  return h.Box({flexDirection:'column',gap:1,children:[
    h.Select({key:'court-mode',label:t('pane.mode'),value:settings.mode,options:['enforce','observe','off'].map(value=>({value,label:t('pane.modeLabel.'+value)})),onSelect:value=>mutate($,ctx,latest=>({...latest,mode:value,hardened:false}))}),
    h.Text({dimColor:true,children:t('pane.mode.'+settings.mode)}),
    h.Text({children:`${t('pane.language')}: ${currentLanguage()==='vi'?'Tiếng Việt':'English'} · /config`}),
    h.Text({dimColor:true,children:t('pane.settingsHint')}),
    h.Text({bold:true,children:t('pane.reset')}),h.Text({dimColor:true,children:t('pane.resetHint')}),
    h.Button({key:'reset-rules',label:t('pane.reset')+'…',onPress:()=>change($,state,{confirm:{type:'reset'},message:''})}),
  ]});
}
export async function openRulesPane($,ctx){
  // Context is re-read on render: a previous project's view cannot mutate this one.
  return $.ui.open({id:PANE,title:'Agent Arbiter',focus:true});
}
export function registerRulesPane(on){
  on('ui.render',{component:'Pane',requestId:PANE},async($,e)=>{
    const h=$.ui.resolve(e);let ctx;
    try{ctx=await observationContext($,{recoverPreferences:true});}
    catch(error){return h.Box({flexDirection:'column',children:[h.Text({children:t('pane.unavailable')}),h.Text({children:String(error.message)}),h.Button({key:'refresh-rules',label:t('pane.retry'),onPress:()=>redraw($)})]});}
    const state=stateFor(ctx);let settings,body;
    try{settings=await loadProjectSettings($,ctx);}catch(error){body=h.Box({flexDirection:'column',gap:1,children:[h.Text({children:t('pane.unavailable')}),h.Text({children:String(error.message)}),h.Button({key:'reset-rules',label:t('pane.reset'),onPress:()=>change($,state,{confirm:{type:'reset'},message:''})})]});}
    if(state.confirm)body=confirmationView($,h,ctx,state);
    else if(settings)body=state.tab==='rules'?rulesView($,h,ctx,state,settings):state.tab==='violations'?await violationsView($,h,ctx):state.tab==='citizens'?await citizensView($,h,ctx,settings):settingsView($,h,ctx,state,settings);
    return h.Box({flexDirection:'column',gap:1,children:[
      h.Box({flexDirection:'row',flexWrap:'wrap',gap:1,justifyContent:'space-between',children:[h.Text({bold:true,children:t('pane.title')}),h.Text({dimColor:true,children:settings?t('pane.modeLabel.'+settings.mode):t('pane.unavailable')})]}),
      h.Text({dimColor:true,children:t('pane.scope',{name:ctx.projectRoot.split('/').filter(Boolean).at(-1) || '/'})}),
      h.Box({flexDirection:'row',gap:1,children:['rules','violations','citizens','settings'].map(tab=>h.Button({key:'tab-'+tab,label:t('pane.tab.'+tab),...(state.tab===tab?{variant:'primary'}:{}),onPress:()=>change($,state,{tab,editor:null,confirm:null,message:''})}))}),
      body,
      h.Box({flexDirection:'row',gap:1,flexWrap:'wrap',justifyContent:'space-between',children:[h.Text({dimColor:!state.message,children:state.message || t('pane.noPending')}),h.Button({key:'refresh-rules',label:t('pane.refresh'),plain:true,onPress:()=>redraw($)})]}),
    ]});
  });
}
