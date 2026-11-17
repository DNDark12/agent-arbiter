import * as fs from 'node:fs/promises';
import {loadProjectSettings,saveProjectSettings} from '../extension/hooks/project-rules.js';
import {world} from './fixtures.mjs';
import {strictProfile,protectedPaths} from '../extension/hooks/runtime-policy.js';
import {digest} from '../extension/hooks/ledger.js';
import {probeRuntime,consumeRuntimeProbe,completeRuntimeProbe} from '../extension/hooks/runtime.js';
import {canonical} from '../extension/hooks/ledger.js';
import {observationContext} from '../extension/hooks/context.js';
export async function protectedWorld(t){
 const w=await world(t),base=await fs.realpath(w.root),configRoot=base+'/config',projectRoot=base+'/workspace',pluginRoot=base+'/extension';
 await Promise.all([configRoot,projectRoot,pluginRoot].map(path=>fs.mkdir(path)));
 const secret=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
 const anchor=await digest(secret),keyFile=configRoot+'/plugins/data/agent-arbiter/security/key-'+crypto.randomUUID()+'.hex';
 await w.$.fs.write(keyFile,secret);await fs.chmod(keyFile,0o600);
 w.$.env.get=async k=>k==='HOME'?base+'/home':k==='CLAUDE_CONFIG_DIR'?configRoot:undefined;
 w.$.plugin={root:pluginRoot};w.$.session.id=async()=>base;w.$.session.root=async()=>projectRoot;
 const settings=strictProfile(protectedPaths({configRoot,pluginRoot,projectRoot,home:base+'/home',hostRoots:[base+'/host-runtime']}),anchor,keyFile);settings.permissions.disableAutoMode='disable';settings.env.AGENT_ARBITER_HOST_ROOTS=JSON.stringify([base+'/host-runtime']);
 w.$.settings={read:async()=>settings};w.$.session.version=async()=>({version:'2.1.325'});
 w.$.tool={list:async()=>[{name:'Bash',mcp:false},{name:'Read',mcp:false},{name:'Write',mcp:false}],check:async q=>{
  const target=q.input?.file_path || q.input?.notebook_path;
  const kind=q.tool==='Read'?'Read':'Edit';
  const rule=settings.permissions.deny.find(rule=>{
   if(rule===q.tool || rule===kind)return true;
   const prefix=kind+'(/';if(!rule.startsWith(prefix) || !rule.endsWith(')') || !target)return false;
   const pattern=rule.slice(prefix.length,-1);
   return pattern.endsWith('/**')?target.startsWith(pattern.slice(0,-3)+'/'):target===pattern;
  });
  return rule?{decision:'deny',rule}:{decision:'ask',rule:'*'};
 },call:async e=>({result:{stdout:e.command?.includes('COURT_BASELINE')?'COURT_BASELINE':e.command?.includes('ALIAS_BLOCKED')?'ALIAS_BLOCKED':e.command?.includes('READ_BLOCKED')?'READ_BLOCKED':'WRITE_BLOCKED',exitCode:0}})};
 const baseCtx=await observationContext(w.$);
 await saveProjectSettings(w.$,baseCtx,{...await loadProjectSettings(w.$,baseCtx),mode:'enforce',hardened:true});
 const ctx=await observationContext(w.$),command=async(args,kind='composer')=>{
  const answer=await w.command(args,kind);
  if(args==='runtime probe' && ['composer','bridge'].includes(kind)){
   const plan=JSON.parse(answer.text);if(plan.pending)return {text:canonical(await driveProbe(w.$,ctx,plan))};
  }
  return answer;
 };
 return {...w,command,root:projectRoot,configRoot,pluginRoot,settings,ctx,anchor};
}

// Synthetic operator + native tool receipts, not a person or OS sandbox proof.
export async function driveProbe($,ctx,plan){
 let status=plan;
 for(const command of plan.commands || []){
  const event={tool:'Bash',command,timeout:5000};
  const receipt=consumeRuntimeProbe(ctx,event,{plugin:'engine',tier:'core'},'agent-arbiter');
  if(!receipt)throw new Error('Fixture probe capability unavailable');
  status=await completeRuntimeProbe($,ctx,receipt,await $.tool.call(event));
  if(!status.pending)break;
 }
 return status;
}
