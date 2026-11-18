// Domain operations shared by commands and the native pane. Callers enforce
// provenance: this module never manufactures a human command origin.
import {updateProjectSettings,resetProjectRules} from './project-rules.js';
import {forgetCaches} from './events.js';
import {resetDiscipline} from './discipline.js';
import {resetEnforcement,setMasterEnabled} from './control-state.js';
import {refreshStatus} from './status.js';
import {setLanguage,t} from './i18n.js';

export async function changeProjectMode($,ctx,mode) {
  if (!['enforce','observe','off'].includes(mode)) throw new Error('Invalid project mode');
  const saved = await updateProjectSettings($,ctx,latest=>({...latest,mode,hardened:false}));
  resetEnforcement(ctx);
  await refreshStatus($,ctx);
  return saved;
}

export async function resetRules($,ctx) {
  return resetProjectRules($,ctx);
}

export async function globalConfig($) {
  return (await $.config.list()).filter(row=>['agent-arbiter.enabled','agent-arbiter.language'].includes(row.key));
}

export async function changeGlobalConfig($,key,value) {
  if (!['agent-arbiter.enabled','agent-arbiter.language'].includes(key)) throw new Error('Invalid Arbiter configuration key');
  const row = (await globalConfig($)).find(row=>row.key===key);
  if (!row) throw new Error(t('settings.configUnavailable'));
  if (row.isLocked) throw new Error(t('settings.locked'));
  const result = await $.config.set({key,value});
  if (result.deny) throw new Error(result.deny);
  if (key==='agent-arbiter.enabled') setMasterEnabled(result.value);
  else setLanguage(result.value,await $.env.get('LC_ALL') || await $.env.get('LANG') || '');
  return result.value;
}

export async function purgeData($,ctx,all=false) {
  const root=`${ctx.configRoot}/plugins/data/agent-arbiter`,scope=t(all?'cmd.purgeAll':'cmd.purgeProject');
  let answer='';
  try { answer=await $.ui.ask(t('cmd.purgeAsk',{scope}),[t('cmd.purgeNo'),t('cmd.purgeYes')]); } catch { /* No answer authorizes nothing. */ }
  if (answer!==t('cmd.purgeYes')) return {deleted:false,text:t('cmd.purgeCancelled')};
  const targets=all?[root]:[`${ctx.archiveRoot}/events/${ctx.projectId}`,`${ctx.archiveRoot}/projects/${ctx.projectId}`,
    ...(ctx.dataRoot!==ctx.archiveRoot?[`${ctx.dataRoot}/events/${ctx.projectId}`]:[])];
  if (!/^[a-f0-9]{64}$/.test(ctx.projectId) || targets.some(path=>!(path===root || path.startsWith(root+'/')) || path.includes('/../'))) throw new Error('Unexpected Arbiter data path');
  const result=await $.process.run(['/bin/rm','-rf','--',...targets]);
  forgetCaches();resetDiscipline();
  if (result.exitCode!==0) throw new Error(t('cmd.purgeFailed',{error:`exit ${result.exitCode}`}));
  resetEnforcement(all?null:ctx);
  try { $.ui.status(undefined); } catch { /* Best effort. */ }
  return {deleted:true,text:t('cmd.purged',{scope})};
}
