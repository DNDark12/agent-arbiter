import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileMetadata, redact } from '../extension/hooks/privacy.js';
import { citizen } from '../extension/hooks/citizens.js';
import { transcriptCoverage, gitSnapshot } from '../extension/hooks/forensics.js';

test('paths normalize traversal and external paths become digests; common secrets are redacted', async () => {
  assert.equal((await fileMetadata('/repo', '/repo/a/../b.js')).path, 'b.js');
  const outside = await fileMetadata('/repo', '/repo/../private/password=secret.txt');
  assert.equal(outside.scope, 'external');
  assert.match(outside.path, /^sha256:/);
  for (const raw of ['Bearer abcdef123', 'api_key=abcdef123', 'https://user:pass@host', 'ghp_abcdefghijklmnop', 'AKIAABCDEFGHIJKLMNOP']) {
    assert.notEqual(redact(raw), raw);
  }
});

test('identity uses actual definition bytes and resolved model, unknown remains unknown', async () => {
  const $ = { fs: { read: async () => '---\nname: review\n---\nfull definition', list: async () => [{name:'different-filename.md',kind:'file'}] }, env: { get: async k => k === 'HOME' ? '/home/user' : undefined } };
  const base = { subagentType: 'review', provider: { plugin: 'engine', tier: 'core' } };
  const known = await citizen($, '/repo', 'engine-v1', base, { source: 'projectSettings', provider: base.provider }, 'resolved-v1');
  assert.match(known.definitionHash, /^[0-9a-f]{64}$/);
  assert.match(known.id, /^[0-9a-f]{64}$/);
  const unknown = await citizen($, '/repo', 'engine-v1', base, null, 'resolved-v1');
  assert.equal(unknown.id, null);
  assert.equal(unknown.definitionHash, null);
  const builtin = await citizen($, '/repo', 'engine-v1', base, { source: 'built-in', provider: base.provider }, 'resolved-v1');
  assert.equal(builtin.definitionHash, null);
  assert.equal(builtin.engineVersion, 'engine-v1');
});

test('transcript coverage never asserts completeness; errors and cap remain explicit', async () => {
  assert.equal((await transcriptCoverage({ session: { messages: async () => ({ deny: 'missing' }) } }, 'a')).status, 'unavailable');
  assert.equal((await transcriptCoverage({ session: { messages: async () => Array(4096).fill({}) } }, 'a')).status, 'possibly-truncated');
  assert.equal((await transcriptCoverage({ session: { messages: async () => [] } }, 'a')).complete, false);
});

test('git snapshot reports unavailable diff without executing host Git or storing content', async () => {
  const $ = { process: { run: async argv => ({ exitCode: 0, stdout: argv.includes('rev-parse') ? 'head' : 'password=private', stderr: '', isStdoutTruncated: true }) } };
  const snap = await gitSnapshot($, '/repo');
  assert.equal(snap.status, 'partial');
  assert.equal(snap.diffHash,null);
  assert.equal(snap.reason,'host-git-execution-disabled');
  assert.equal(JSON.stringify(snap).includes('password=private'), false);
});

test('mismatched frontmatter cannot identify another agent; builtin ID has explicit weak binding', async () => {
 const $={fs:{list:async()=>[{name:'review.md',kind:'file'}],read:async()=> '---\nname: someone-else\n---\nbody'}};
 const input={subagentType:'review',provider:{plugin:'engine',tier:'core'}};
 assert.equal((await citizen($,'/repo','v1',input,{source:'projectSettings'},'actual')).id,null);
 const a=await citizen($,'/repo','v1',input,{source:'built-in'},'actual');
 const b=await citizen($,'/repo','v2',input,{source:'built-in'},'actual');
 assert.ok(a.id);assert.notEqual(a.id,b.id);assert.equal(a.definitionHash,null);assert.equal(a.identityStrength,'engine-version');
});
test('file path reached through symlink root resolves inside project', async()=>{
 const $={fs:{stat:async path=>({realPath:path.replace('/link','/actual')})}};
 const file=await fileMetadata('/actual','/link/a.js',$,'/link');
 assert.equal(file.scope,'project');assert.equal(file.path,'a.js');assert.equal(file.pathResolution,'realpath');
});

test('user definitions follow CLAUDE_CONFIG_DIR, and two matching names stay ambiguous', async()=>{
 const directories=[];
 const $={env:{get:async k=>k==='CLAUDE_CONFIG_DIR'?'/custom-config':undefined},fs:{
   list:async dir=>{directories.push(dir);return [{name:'unrelated-filename.md',kind:'file'}]},
   read:async()=> '---\nname: review\n---\nbody'
 }};
 const input={subagentType:'review'};
 assert.ok((await citizen($,'/repo','v1',input,{source:'userSettings'},'actual')).id);
 assert.deepEqual(directories,['/custom-config/agents']);
 $.fs.list=async()=>[{name:'a.md',kind:'file'},{name:'b.md',kind:'file'}];
 assert.equal((await citizen($,'/repo','v1',input,{source:'userSettings'},'actual')).id,null);
});
