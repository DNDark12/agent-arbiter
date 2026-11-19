export async function transcriptCoverage($, agentId) {
  try {
    const messages = await $.session.messages(agentId ? { agentId } : {});
    if (!Array.isArray(messages)) return { status: 'unavailable', complete: false, count: null };
    return { status: messages.length >= 4096 ? 'possibly-truncated' : 'available', complete: false, count: messages.length };
  } catch { return { status: 'unavailable', complete: false, count: null }; }
}

// Never execute Git against an untrusted worktree from the privileged hook host:
// status/diff can start clean filters or fsmonitor outside the agent sandbox.
export async function gitSnapshot($,root){
  return {status:'partial',head:await gitHead($,root),statusHash:null,diffHash:null,
    reason:'host-git-execution-disabled',untrackedContentsCaptured:false,attribution:'workspace-only'};
}

async function gitDirectory($,root){
  const path=root+'/.git',stat=await $.fs.stat(path,{resolve:true});
  if(stat.kind==='dir') return stat.realPath || path;
  if(stat.kind!=='file') return null;
  const match=(await $.fs.read(path)).trim().match(/^gitdir: ([^\0\r\n]+)$/);
  if(!match) return null;
  const directory=match[1].startsWith('/')?match[1]:root+'/'+match[1];
  const resolved=await $.fs.stat(directory,{resolve:true});
  return resolved.kind==='dir'?resolved.realPath:null;
}

// The repository's shared Git directory for the checkout's own one.
async function commonDirectory($,directory){
  if(!await $.fs.exists(directory+'/commondir'))return directory;
  const relative=(await $.fs.read(directory+'/commondir')).trim();
  if(!relative || /[\0\r\n]/.test(relative))return null;
  const path=relative.startsWith('/')?relative:directory+'/'+relative;
  return (await $.fs.stat(path,{resolve:true})).realPath || null;
}

// Every checkout of the repository at root: the main one and its linked
// worktrees, as real paths. A worktree counts only when its own .git file
// points back at its entry, so an entry written inside the project cannot
// claim a folder elsewhere. [] when unknown.
export async function worktreeRoots($,root){
  try{
    const directory=await gitDirectory($,root);if(!directory)return [];
    const common=await commonDirectory($,directory);if(!common)return [];
    const roots=new Set();
    if(common.endsWith('/.git'))roots.add(common.slice(0,-5));
    if(!await $.fs.exists(common+'/worktrees'))return [...roots];
    for(const entry of await $.fs.list(common+'/worktrees')){
      if(entry.kind!=='dir' || entry.isLink)continue;
      try{
        const gitFile=(await $.fs.read(`${common}/worktrees/${entry.name}/gitdir`)).trim();
        if(!gitFile.startsWith('/') || /[\0\r\n]/.test(gitFile) || !gitFile.endsWith('/.git'))continue;
        const back=(await $.fs.read(gitFile)).trim().match(/^gitdir: ([^\0\r\n]+)$/);
        const linked=back && (await $.fs.stat(back[1],{resolve:true})).realPath;
        if(linked!==(await $.fs.stat(`${common}/worktrees/${entry.name}`,{resolve:true})).realPath)continue;
        const checkout=await $.fs.stat(gitFile.slice(0,-5),{resolve:true});
        if(checkout.kind==='dir')roots.add(checkout.realPath || gitFile.slice(0,-5));
      }catch{ /* An unreadable entry is not a checkout. */ }
    }
    return [...roots];
  }catch{return [];}
}

export async function gitHead($,root){
  const hash=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  try{
    const directory=await gitDirectory($,root);if(!directory)return null;
    const head=(await $.fs.read(directory+'/HEAD')).trim();
    if(hash.test(head))return head;
    const match=head.match(/^ref: (refs\/[A-Za-z0-9_./-]+)$/);
    if(!match || match[1].includes('..') || match[1].includes('//'))return null;
    const common=await commonDirectory($,directory);if(!common)return null;
    for(const base of [...new Set([directory,common])]){
      if(await $.fs.exists(base+'/'+match[1])){
        const value=(await $.fs.read(base+'/'+match[1])).trim();if(hash.test(value))return value;
      }
      if(await $.fs.exists(base+'/packed-refs')){
        for(const line of (await $.fs.read(base+'/packed-refs')).split('\n')){
          const [value,ref]=line.split(' ');if(ref===match[1] && hash.test(value))return value;
        }
      }
    }
  }catch{ /* Missing metadata stays unknown. */ }
  return null;
}
