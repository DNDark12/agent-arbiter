import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonical, digest, publish, replay, readLedger } from '../plugins/agent-arbiter/hooks/ledger.js';
import * as events from '../plugins/agent-arbiter/hooks/events.js';
import { createSigner } from '../plugins/agent-arbiter/hooks/auth.js';
const exec = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'court-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let reads = 0;
  const stat = async path => { const s = await fs.lstat(path); return {kind:s.isDirectory()?'dir':s.isFile()?'file':'other',isLink:s.isSymbolicLink(),size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,ino:s.ino,realPath:path}; };
  const $ = {fs:{stat,read:async path=>{reads++;return fs.readFile(path,'utf8');},write:async(path,text)=>{await fs.mkdir(dirname(path),{recursive:true});await fs.writeFile(path,text);},exists:async path=>{try{await fs.lstat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}},list:async path=>Promise.all((await fs.readdir(path)).map(async name=>({name,...await stat(join(path,name))})))},process:{run:async argv=>{try{return {exitCode:0,...await exec(argv[0],argv.slice(1))};}catch(e){if(typeof e.code!=='number')throw e;return {exitCode:e.code};}}}};
  const ctx = {dataRoot:root,projectId:'a'.repeat(64),sessionId:'first',checkoutId:'b'.repeat(64)};
  const directory = join(root,'events',ctx.projectId,'2026-11');
  async function append(index, overrides={}) {const item={schemaVersion:1,id:await digest(String(index)),projectId:ctx.projectId,sessionId:'writer-'+index,agentId:null,kind:'tool.request',occurredAt:index,data:{toolCallId:'call-'+index,tool:'Read'},...overrides};await publish($,directory,item,ctx.signer);return item;}
  return {$,ctx,directory,append,reads:()=>reads};
}

test('project cache reuses verified finals while discovering another session append and changed metadata',async t=>{
  const f=await fixture(t);const first=await f.append(1);
  assert.equal((await events.readProject(f.$,f.ctx)).events.length,1);
  const before=f.reads();await events.readProject(f.$,f.ctx);
  assert.equal(f.reads(),before,'unchanged finals must not be read or rehashed');
  const second=await f.append(2);const afterWrite=f.reads();
  assert.deepEqual((await events.readProject(f.$,{...f.ctx,sessionId:'reader-two'})).events.map(e=>e.id),[first.id,second.id]);
  assert.equal(f.reads()-afterWrite,1,'only the new final is verified');
  await fs.writeFile(join(f.directory,first.id+'.json'),'{broken');
  const changed=await events.readProject(f.$,f.ctx);
  assert.deepEqual(changed.events.map(e=>e.id),[second.id]);assert.equal(changed.invalid.length,1);
});

test('cache isolates signer and epoch and returns independent result objects',async t=>{
  const f=await fixture(t);const secret='1'.repeat(64),keyId=await digest(secret);
  f.ctx.signer=await createSigner(secret,keyId);f.ctx.anchor=keyId;await f.append(1);
  const first=await events.readProject(f.$,f.ctx);first.events[0].data.tool='mutated';
  assert.equal((await events.readProject(f.$,f.ctx)).events[0].data.tool,'Read');
  const before=f.reads();await events.readProject(f.$,{...f.ctx,epoch:'new'});assert.ok(f.reads()>before);
  const other=await createSigner('2'.repeat(64),await digest('2'.repeat(64)));
  const rejected=await events.readProject(f.$,{...f.ctx,signer:other});
  assert.equal(rejected.events.length,0);assert.equal(rejected.invalid.length,1);
});

test('malformed final is quarantined with original bytes and report; later valid evidence remains readable',async t=>{
  const f=await fixture(t);const valid=await f.append(1);const bad='c'.repeat(64)+'.json';
  await fs.writeFile(join(f.directory,bad),'malformed evidence');
  const result=await events.readProject(f.$,f.ctx);
  assert.equal(result.events[0].id,valid.id);assert.equal(result.invalid.length,1);
  const issue=result.invalid[0];assert.ok(issue.quarantined);assert.equal(await fs.readFile(issue.quarantined,'utf8'),'malformed evidence');
  assert.equal(await f.$.fs.exists(join(f.directory,bad)),false);
  const report=JSON.parse(await fs.readFile(issue.report,'utf8'));assert.equal(report.source,join(f.directory,bad));assert.ok(report.reason);
  assert.equal((await events.readProject(f.$,f.ctx)).events.length,1);
});

test('explicit quarantine reports replay conflicts without deleting valid or unrelated files or following symlinks',async t=>{
  const f=await fixture(t);const first=await f.append(1);await f.append(2,{kind:'ledger.conflict',data:{targetId:first.id,rejectedHash:'d'.repeat(64)}});
  const outside=join(f.ctx.dataRoot,'outside');await fs.writeFile(outside,'untouched');
  const link='e'.repeat(64)+'.json';await fs.symlink(outside,join(f.directory,link));await fs.writeFile(join(f.directory,'notes.txt'),'notes');
  assert.equal(typeof events.quarantineProject,'function');
  const summary=await events.quarantineProject(f.$,f.ctx);
  assert.equal(summary.events,2);assert.ok(summary.conflicts.length);assert.ok(summary.issues.some(i=>i.name===link));
  assert.equal(await fs.readFile(outside,'utf8'),'untouched');assert.equal(await fs.readFile(join(f.directory,'notes.txt'),'utf8'),'notes');
  assert.equal((await fs.lstat(join(f.directory,link))).isSymbolicLink(),true);
  assert.deepEqual(replay((await events.readProject(f.$,f.ctx)).events).conflicts,summary.conflicts);
});


test('recovery summary retains prior automatic quarantine reports',async t=>{
  const f=await fixture(t);await f.append(1);const bad='c'.repeat(64)+'.json';
  await fs.writeFile(join(f.directory,bad),'bad prior record');
  const isolated=await events.readProject(f.$,f.ctx);
  const summary=await events.quarantineProject(f.$,f.ctx);
  assert.equal(summary.events,1);assert.ok(summary.paths.includes(isolated.invalid[0].quarantined));
  assert.ok(summary.issues.some(issue=>issue.source===join(f.directory,bad)));
});

test('quarantine refuses symlinked destination and leaves evidence in place',async t=>{
  const f=await fixture(t);await f.append(1);const bad='c'.repeat(64)+'.json';
  const outside=join(f.ctx.dataRoot,'outside');await fs.mkdir(outside);
  await fs.symlink(outside,join(f.ctx.dataRoot,'quarantine'));
  await fs.writeFile(join(f.directory,bad),'bad record');
  const read=await events.readProject(f.$,f.ctx);
  assert.equal(read.events.length,1);assert.match(read.invalid[0].quarantineError,/canonical/);
  assert.equal(await fs.readFile(join(f.directory,bad),'utf8'),'bad record');assert.deepEqual(await fs.readdir(outside),[]);
});

test('expired metadata lease rechecks content without trusting unchanged timestamps forever',async t=>{
  const f=await fixture(t);await f.append(1);await events.readProject(f.$,f.ctx);
  const before=f.reads(),now=Date.now;
  try{Date.now=()=>now()+30001;await events.readProject(f.$,f.ctx);}finally{Date.now=now;}
  assert.equal(f.reads()-before,1);
});

test('authenticated invalid evidence remains invalid until explicit quarantine recovery',async t=>{
  const f=await fixture(t),secret='1'.repeat(64),anchor=await digest(secret);
  f.ctx.signer=await createSigner(secret,anchor);f.ctx.anchor=anchor;
  const item=await f.append(1),path=join(f.directory,item.id+'.json');
  await fs.writeFile(path,'invalid signed evidence');
  assert.equal((await events.readProject(f.$,f.ctx)).invalid.length,1);
  assert.equal((await events.readProject(f.$,f.ctx)).invalid.length,1);
  assert.equal(await fs.readFile(path,'utf8'),'invalid signed evidence');
  const recovered=await events.quarantineProject(f.$,f.ctx);
  assert.equal(recovered.paths.length,1);assert.equal(await f.$.fs.exists(path),false);
  assert.equal((await events.readProject(f.$,f.ctx)).invalid.length,0);
});


test('a ledger larger than the bounded cache retains its verified working set',async t=>{
  const f=await fixture(t);await fs.mkdir(f.directory,{recursive:true});
  for(let start=0;start<4097;start+=64){
    await Promise.all(Array.from({length:Math.min(64,4097-start)},async(_,offset)=>{
      const index=start+offset,id=index.toString(16).padStart(64,'0');
      const body=canonical({schemaVersion:1,id,projectId:f.ctx.projectId,sessionId:'writer',agentId:null,kind:'tool.request',occurredAt:index,data:{}});
      await fs.writeFile(join(f.directory,id+'.json'),canonical({id,body,sha256:await digest(body)}));
    }));
  }
  const cache=new Map();await readLedger(f.$,f.directory,null,cache);assert.equal(cache.size,4096);
  const before=f.reads();await readLedger(f.$,f.directory,null,cache);
  assert.equal(f.reads()-before,1,'overflow must not evict the whole cached working set');
});
