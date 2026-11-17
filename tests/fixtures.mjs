import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { handleCourt } from '../extension/hooks/controls.js';
const exec=promisify(execFile);
export async function world(t) {
 const root=await fs.mkdtemp(join(tmpdir(),'court-phase2-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const stat=async p=>{const s=await fs.lstat(p);return {kind:s.isDirectory()?'dir':'file',isLink:s.isSymbolicLink(),realPath:await fs.realpath(p),mtimeMs:s.mtimeMs}};
 const $={plugin:{root},clock:{sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))},settings:{read:async()=>({})},tool:{list:async()=>[]},session:{root:async()=>root,id:async()=>'s',repo:async()=>null},env:{get:async k=>k==='CLAUDE_CONFIG_DIR'?root:undefined},ui:{ask:async()=> 'Allow'},fs:{
  stat, read:p=>fs.readFile(p,'utf8'),write:async(p,s)=>{await fs.mkdir(dirname(p),{recursive:true});await fs.writeFile(p,s)},
  exists:async p=>{try{await fs.lstat(p);return true}catch(e){if(e.code==='ENOENT')return false;throw e}},
  list:async p=>Promise.all((await fs.readdir(p)).map(async name=>({name,...await stat(join(p,name))})))},
  process:{run:async argv=>{try{return {exitCode:0,...await exec(argv[0],argv.slice(1))}}catch(e){if(typeof e.code!=='number')throw e;return{exitCode:e.code}}}}};
 const command=(args,kind='composer')=>handleCourt($,{args,origin:{kind}});
 await command('mode observe');
 return {$,root,command};
}
