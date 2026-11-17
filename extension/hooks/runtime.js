import {canonical,digest} from './ledger.js';
import {redact} from './privacy.js';
import {createSigner} from './auth.js';
import {protectedPaths,strictProfile,inspectProfile} from './runtime-policy.js';

const HEX=/^[a-f0-9]{64}$/;
const proofs=new Map();
const probeCalls=new Map();
const requiredSessions=new Set();
export function protectionArmed(){return requiredSessions.size>0;}
const CORE_TOOLS=new Set(['Bash','Read','Glob','Grep','Write','Edit','NotebookEdit','Agent','Task','TaskStop','TaskOutput','TaskList','TaskGet','TaskCreate','TaskUpdate','ToolSearch','AskUserQuestion','EnterPlanMode','ExitPlanMode','TodoWrite','SubagentHandback','WebSearch','WebFetch']);

export async function runtimePaths($,ctx,settings = {}){
  const home=await $.env.get('HOME');
  const hostRoots=JSON.parse(settings.env?.AGENT_ARBITER_HOST_ROOTS || '[]');
  return protectedPaths({configRoot:ctx.configRoot,pluginRoot:ctx.pluginRoot || $.plugin.root,projectRoot:ctx.projectRoot,home,hostRoots});
}

async function settingsSnapshot($,ctx){
  const settings=await $.settings.read();
  const paths=await runtimePaths($,ctx,settings);
  const issues=[...inspectProfile(settings,paths).issues];
  if(!Array.isArray(JSON.parse(settings.env?.AGENT_ARBITER_HOST_ROOTS || 'null')) || !JSON.parse(settings.env.AGENT_ARBITER_HOST_ROOTS).length)issues.push('Operator must declare immutable host runtime roots');
  if(Object.keys(settings.env || {}).some(key=>/^(?:LD_|DYLD_|BASH_ENV$|ENV$|NODE_OPTIONS$|PYTHONPATH$)/.test(key)))issues.push('Host loader or shell injection environment is unsupported');
  if(settings.mcpServers && Object.keys(settings.mcpServers).length)issues.push('Configured external MCP servers are unsupported');
  if(settings.sandbox?.allowAppleEvents || settings.sandbox?.enableWeakerNetworkIsolation || settings.sandbox?.bwrapPath || settings.sandbox?.socatPath || settings.sandbox?.ripgrep) issues.push('Custom or weaker sandbox helpers are unsupported');
  if(settings.permissions?.disableAutoMode!=='disable' && settings.disableAutoMode!=='disable') issues.push('Auto mode must be disabled');
  for(const field of ['hooks','apiKeyHelper','awsAuthRefresh','awsCredentialExport','otelHeadersHelper','statusLine','fileSuggestion','lspServers']){
    if(settings[field] && Object.keys(Object(settings[field])).length) issues.push('Privileged host helper requires isolated profile: '+field);
  }
  if(Object.entries(settings.enabledPlugins || {}).some(([name,enabled])=>enabled && !/^agent-arbiter(?:@|$)/.test(name))) issues.push('Other enabled plugins require a separate trusted profile');
  const tools=await $.tool.list();
  const unsupported=Array.isArray(tools)?tools.filter(t=>t.mcp || !CORE_TOOLS.has(t.name)):[];
  const unknownTools=unsupported.filter(t=>!settings.permissions?.deny?.includes(t.name) && !(t.mcp && settings.permissions?.deny?.includes('mcp__*'))).map(t=>t.name);
  if(!Array.isArray(tools) || !tools.length || tools.some(t=>t.mcp) || unknownTools.length)issues.push('Unprotected external tool inventory');
  for(const path of paths){
    if(await $.fs.exists(path)){
      const stat=await $.fs.stat(path,{resolve:true});
      if(stat.isLink || stat.realPath!==path) issues.push('Protected path is not canonical');
    }
  }
  const engineVersion=(await $.session.version()).version;
  const fingerprint=await digest(canonical({settings,paths,tools:tools.map(t=>({name:t.name,mcp:t.mcp})),engineVersion}));
  return {settings,paths,issues,fingerprint,engineVersion,unknownTools};
}

async function checkedFloor($,ctx){
  const snapshot=await settingsSnapshot($,ctx);
  if(snapshot.issues.length) throw new Error('Runtime protection floor is not strict');
  for(const path of snapshot.paths){
    const isFile=await $.fs.exists(path) && (await $.fs.stat(path)).kind==='file';
    const target=isFile || path.endsWith('/.claude.json')?path:path+'/.court-boundary-probe';
    for(const [tool,input] of [['Read',{file_path:target}],['Write',{file_path:target,content:'probe-not-executed'}],['Edit',{file_path:target,old_string:'x',new_string:'y'}],['NotebookEdit',{notebook_path:target,new_source:'probe-not-executed'}]]){
      const answer=await $.tool.check({tool,input});
      if(answer.decision!=='deny' || !snapshot.settings.permissions.deny.includes(answer.rule)) throw new Error('Engine path protection unavailable for '+tool+' (decision '+answer.decision+', rule '+(answer.rule || 'absent')+')');
    }
  }
  const backup=await $.tool.check({tool:'Bash',input:{command:'printf COURT_ENGINE_QUERY'}});
  if(!['ask','deny'].includes(backup.decision) || !(snapshot.settings.permissions[backup.decision] || []).includes(backup.rule)) throw new Error('Engine permission backup unavailable (decision '+backup.decision+', rule '+(backup.rule || 'absent')+')');
  return snapshot;
}

export async function profileRuntime($,ctx,options = {}){
  const loaded=await $.settings.read();
  const hostRoots=options.hostRoots || JSON.parse(loaded.env?.AGENT_ARBITER_HOST_ROOTS || '[]');
  const settings={env:{AGENT_ARBITER_HOST_ROOTS:JSON.stringify(hostRoots)}};
  const paths=await runtimePaths($,ctx,settings);
  const profile=strictProfile(paths);
  profile.permissions.disableAutoMode='disable';profile.env=settings.env;
  for(const tool of await $.tool.list())if(!tool.mcp && !CORE_TOOLS.has(tool.name) && /^[A-Za-z0-9_-]+$/.test(tool.name))profile.permissions.deny.push(tool.name);
  return {settings:profile,protectedPaths:paths,hostRootsRequired:hostRoots.length===0,applied:false,requiresOperatorReview:true};
}

export async function loadAuthentication($,ctx){
  let settings;
  try{settings=await $.settings.read();}catch{requiredSessions.add(ctx.sessionId);return {configured:true,signer:null,anchor:null,authError:'Settings unavailable'};}
  const anchor=settings.env?.AGENT_ARBITER_ANCHOR,keyFile=settings.env?.AGENT_ARBITER_KEY_FILE;
  if(anchor===undefined && keyFile===undefined) return {configured:false,signer:null,anchor:null};
  requiredSessions.add(ctx.sessionId);
  try{
    if(!HEX.test(anchor) || typeof keyFile!=='string' || !keyFile.startsWith(ctx.configRoot+'/plugins/data/agent-arbiter/security/') || !/^key-[a-f0-9-]+\.hex$/.test(keyFile.split('/').at(-1)) || keyFile.includes('..')) throw new Error('Invalid anchored key');
    const snapshot=await checkedFloor($,ctx);
    const stat=await $.fs.stat(keyFile,{resolve:true});
    if(stat.kind!=='file' || stat.isLink || stat.realPath!==keyFile) throw new Error('Private key is not canonical');
    let mode=await $.process.run(['/usr/bin/stat','-f','%Lp',keyFile],{timeoutMs:3000});
    if(mode.exitCode!==0) mode=await $.process.run(['/usr/bin/stat','-c','%a',keyFile],{timeoutMs:3000});
    if(mode.exitCode!==0 || mode.stdout.trim()!=='600' || mode.isStdoutTruncated) throw new Error('Private key permissions unavailable');
    const signer=await createSigner(await $.fs.read(keyFile),anchor);
    return {configured:true,signer,anchor,keyFile,fingerprint:snapshot.fingerprint};
  }catch(error){return {configured:true,signer:null,anchor:HEX.test(anchor)?anchor:null,authError:'Anchored authentication or protected runtime unavailable',authReason:redact(error.message).replace(/[a-f0-9]{64}/gi,'[redacted hex]')};}
}

function quote(value){return "'"+value.replaceAll("'","'\\''")+"'";}
function stdout(result){
  if(result?.deny || result?.isError) return null;
  const value=result?.result;
  if(value?.exitCode!==undefined && value.exitCode!==0) return null;
  if(value?.isStdoutTruncated) return null;
  return typeof value?.stdout==='string'?value.stdout:null;
}

// A mod's own Bash call cannot ask the person for engine permission. The human
// starts a fixed canary plan; ordinary agent calls run it through the real tool
// and its native ask rule. Only engine-stamped calls can consume a plan step.
export function consumeRuntimeProbe(ctx,event,origin,_pluginName){
  if(origin?.plugin!=='engine' || event.tool!=='Bash' || ctx.authError || event.run_in_background===true || event.dangerouslyDisableSandbox===true)return null;
  const plan=probeCalls.get(ctx.sessionId);
  if(!plan || plan.busy || plan.failed || plan.projectRoot!==ctx.projectRoot || plan.anchor!==(ctx.anchor || null) || event.command!==plan.commands[plan.index])return null;
  const receipt={token:crypto.randomUUID(),sessionId:ctx.sessionId,index:plan.index};
  plan.busy=receipt.token;return receipt;
}

async function cleanProbe($,plan){
  await $.process.run(['/bin/rm','-f',plan.path,...plan.aliases]);
}

export async function completeRuntimeProbe($,ctx,receipt,result){
  const plan=probeCalls.get(ctx.sessionId);
  if(!plan || plan.busy!==receipt?.token || plan.index!==receipt.index)return {ready:false,reason:'Probe receipt unavailable'};
  plan.busy=null;
  const expected=['COURT_BASELINE','READ_BLOCKED','WRITE_BLOCKED','ALIAS_BLOCKED','ALIAS_BLOCKED'][plan.index];
  const marker=stdout(result)?.trim();
  const aliasStep=plan.index>=3;
  const crossDevice=aliasStep && marker==='ALIAS_CROSS_DEVICE';
  const aliasExists=aliasStep && await $.fs.exists(plan.aliases[plan.index-3]);
  if((marker!==expected && !crossDevice) || aliasExists){
    plan.failed=true;proofs.delete(ctx.sessionId);await cleanProbe($,plan);
    return {ready:false,reason:'Probe step denied/unproven, alias collision, or outside protected boundary',step:plan.index+1};
  }
  if(aliasStep && marker==='ALIAS_BLOCKED')plan.aliasDenials++;
  plan.index++;
  if(plan.index<plan.commands.length)return {ready:false,pending:true,nextCommand:plan.commands[plan.index],step:plan.index+1};
  try{
    const snapshot=await checkedFloor($,ctx);
    if(snapshot.fingerprint!==plan.fingerprint || plan.aliasDenials<1 || await $.fs.read(plan.path)!==plan.canary)throw new Error('Runtime changed during probe');
    proofs.set(ctx.sessionId,{fingerprint:plan.fingerprint,projectRoot:ctx.projectRoot,at:Date.now()});
    probeCalls.delete(ctx.sessionId);
    return {ready:true,fingerprint:plan.fingerprint,scope:'same-session agent Bash canaries plus engine path checks'};
  }catch{plan.failed=true;proofs.delete(ctx.sessionId);return {ready:false,reason:'Runtime changed or canary integrity unavailable'};}
  finally{await cleanProbe($,plan);}
}

// Indirect I/O avoids the engine's textual cat/redirection rules: these
// canaries must test the OS sandbox, not merely a pre-execution file rule.
function canaryCommand(kind,path,alias){
  const prefix='import os,errno\np='+JSON.stringify(path)+'\n';
  const denied='e.errno in (errno.EACCES,errno.EPERM,errno.ENOENT)';
  let body;
  if(kind==='read')body="try:\n f=os.open(p,os.O_RDONLY);os.close(f);print('READ_OPEN',end='')\nexcept OSError as e:\n print('READ_BLOCKED' if "+denied+" else 'READ_UNPROVEN',end='')";
  else if(kind==='write')body="try:\n f=os.open(p,os.O_WRONLY|os.O_APPEND);os.write(f,b'changed');os.close(f);print('WRITE_OPEN',end='')\nexcept OSError as e:\n print('WRITE_BLOCKED' if "+denied+" else 'WRITE_UNPROVEN',end='')";
  else body='a='+JSON.stringify(alias)+"\ntry:\n os.link(p,a);print('ALIAS_OPEN',end='')\nexcept OSError as e:\n print('ALIAS_CROSS_DEVICE' if e.errno==errno.EXDEV else ('ALIAS_BLOCKED' if "+denied+" else 'ALIAS_UNPROVEN'),end='')";
  return '/usr/bin/python3 -I -S -c '+quote(prefix+body);
}

export async function probeRuntime($,ctx){
  const snapshot=await checkedFloor($,ctx);
  const proof=proofs.get(ctx.sessionId);
  if(proof?.fingerprint===snapshot.fingerprint && proof.projectRoot===ctx.projectRoot)return {ready:true,fingerprint:proof.fingerprint};
  const previous=probeCalls.get(ctx.sessionId);
  if(previous)await cleanProbe($,previous);
  proofs.delete(ctx.sessionId);
  const nonce=crypto.randomUUID(),path=ctx.configRoot+'/plugins/data/agent-arbiter/security/probe-'+nonce+'.txt';
  const aliases=[ctx.projectRoot+'/.court-sandbox-alias-'+nonce,'/tmp/.court-sandbox-alias-'+nonce];
  const commands=[
    '/usr/bin/printf COURT_BASELINE',canaryCommand('read',path),canaryCommand('write',path),
    ...aliases.map(alias=>canaryCommand('alias',path,alias)),
  ];
  const canary='Public sandbox canary '+nonce;await $.fs.write(path,canary);
  probeCalls.set(ctx.sessionId,{projectRoot:ctx.projectRoot,anchor:ctx.anchor || null,fingerprint:snapshot.fingerprint,path,aliases,canary,commands,index:0,busy:null,failed:false,aliasDenials:0});
  return {ready:false,pending:true,commands,instructions:'Have an agent execute these exact Bash commands in order in this session. Approve the native engine prompts. Arbiter verifies actual results; a reported answer does not count.'};
}

export async function bootstrapRuntime($,ctx,origin){
  if(!['composer','bridge'].includes(origin?.kind)) throw new Error('Human bootstrap required');
  const snapshot=await checkedFloor($,ctx);
  if(snapshot.settings.env?.AGENT_ARBITER_ANCHOR || snapshot.settings.env?.AGENT_ARBITER_KEY_FILE) throw new Error('Existing anchor must not be replaced automatically');
  const proof=proofs.get(ctx.sessionId);
  if(!proof || proof.fingerprint!==snapshot.fingerprint || proof.projectRoot!==ctx.projectRoot)throw new Error('Run the agent canary plan before bootstrap; sandbox protection unproven');
  const directory=ctx.configRoot+'/plugins/data/agent-arbiter/security';
  const mkdir=await $.process.run(['/bin/mkdir','-p',directory]);
  if(mkdir.exitCode!==0) throw new Error('Private directory unavailable');
  const stat=await $.fs.stat(directory,{resolve:true});
  if(stat.isLink || stat.realPath!==directory) throw new Error('Private directory is not canonical');
  if((await $.process.run(['/bin/chmod','700',directory])).exitCode!==0) throw new Error('Private directory protection unavailable');
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  const secret=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');bytes.fill(0);
  const keyFile=directory+'/key-'+crypto.randomUUID()+'.hex';
  if(await $.fs.exists(keyFile)) throw new Error('Fresh key collision');
  await $.fs.write(keyFile,secret);
  if((await $.process.run(['/bin/chmod','600',keyFile])).exitCode!==0) throw new Error('Private key protection unavailable');
  const anchor=await digest(secret);
  const profile=strictProfile(snapshot.paths,anchor,keyFile);profile.permissions.disableAutoMode='disable';profile.env.AGENT_ARBITER_HOST_ROOTS=snapshot.settings.env.AGENT_ARBITER_HOST_ROOTS;
  profile.permissions.deny=[...new Set([...snapshot.settings.permissions.deny,...profile.permissions.deny])];
  profile.permissions.ask=[...new Set([...snapshot.settings.permissions.ask,...profile.permissions.ask])];
  return {anchor,keyFile,settings:profile,applied:false,legacyAuthorityAdopted:false,message:'Apply this public anchor through reviewed settings, reload and probe again before activation.'};
}

export async function runtimeReady($,ctx){
  const auth=await loadAuthentication($,ctx);
  if(!auth.signer || auth.authError) return {ready:false,reason:auth.authError || 'Anchor required'};
  const proof=proofs.get(ctx.sessionId);
  if(!proof || proof.fingerprint!==auth.fingerprint || proof.projectRoot!==ctx.projectRoot) return {ready:false,reason:'Same-session sandbox proof required'};
  return {ready:true,fingerprint:auth.fingerprint,anchor:auth.anchor};
}

export async function hardLawBackup($,ctx,rules){
  const settings=await $.settings.read();
  for(const rule of rules.filter(rule=>rule.effect==='deny')){
    if(rule.action!=='source.write'){
      if(!settings.permissions?.deny?.includes('Bash'))return false;
      continue;
    }
    if(typeof rule.target!=='string' || rule.target.startsWith('/') || rule.target.split('/').some(part=>!part || part==='.' || part==='..'))return false;
    const target=ctx.projectRoot+'/'+rule.target;
    for(const [tool,input] of [['Write',{file_path:target,content:'not-executed'}],['Edit',{file_path:target,old_string:'x',new_string:'y'}],['NotebookEdit',{notebook_path:target,new_source:'not-executed'}]]){
      const answer=await $.tool.check({tool,input});
      if(answer.decision!=='deny' || !settings.permissions?.deny?.includes(answer.rule))return false;
    }
  }
  return true;
}

export async function inspectRuntime($,ctx){
  try{
    const snapshot=await settingsSnapshot($,ctx);
    let engineQueriesReady=false,engineQueryFailure=null;
    if(!snapshot.issues.length){try{await checkedFloor($,ctx);engineQueriesReady=true;}catch(error){engineQueryFailure=redact(error.message);}}
    const proof=proofs.get(ctx.sessionId),proofMatches=proof?.fingerprint===snapshot.fingerprint && proof.projectRoot===ctx.projectRoot;
    return {ready:!!ctx.signer && engineQueriesReady && snapshot.issues.length===0 && proofMatches,issues:snapshot.issues,protectedPaths:snapshot.paths,fingerprint:snapshot.fingerprint,engineVersion:snapshot.engineVersion,unknownTools:snapshot.unknownTools,authenticated:!!ctx.signer,authError:ctx.authError || null,authReason:ctx.authReason || null,engineQueriesReady,engineQueryFailure,requiresSameSessionProbe:!proofMatches};
  }catch{return {ready:false,issues:['Runtime settings or tool inventory unavailable']};}
}
