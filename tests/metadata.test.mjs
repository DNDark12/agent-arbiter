import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileMetadata, redact } from '../plugins/agent-arbiter/hooks/privacy.js';
import { citizen } from '../plugins/agent-arbiter/hooks/citizens.js';
import { transcriptCoverage, gitSnapshot } from '../plugins/agent-arbiter/hooks/forensics.js';

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

test('masking covers common token shapes, credential URLs, key blocks and secret files',async()=>{
 const {redact,maskText,SECRET_FILE}=await import('../plugins/agent-arbiter/hooks/privacy.js');
 const samples=['xoxb-1234567890-abcdefghij','AIza'+'A'.repeat(35),'sk_live_'+'a'.repeat(24),'glpat-'+'b'.repeat(20),'npm_'+'c'.repeat(36),
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'];
 for(const sample of samples)assert.ok(!redact('value '+sample).includes(sample),sample);
 assert.equal(redact('mysql://app:hunter2@db:3306/x'),'mysql://[REDACTED]@db:3306/x');
 assert.match(redact('"client_secret": "abc123"'),/client_secret": "\[REDACTED\]/);
 assert.ok(!redact('Authorization: Basic dXNlcjpwYXNz').includes('dXNlcjpwYXNz'));
 const key='-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----';
 const masked=maskText('before\n'+key+'\nafter password=x1');
 assert.equal(masked,'before\n[REDACTED PRIVATE KEY]\nafter password=[REDACTED]');
 assert.equal(maskText('-----BEGIN PRIVATE KEY-----\nAAAA'),'[REDACTED PRIVATE KEY]','an unterminated block is masked to the end');
 assert.equal(maskText('plain code\nconst a = 1;'),'plain code\nconst a = 1;');
 for(const path of ['.env','.env.production','config/.npmrc','.netrc','certs/server.pem','keys/app.p8','id_ed25519','storage/credentials.json',
  'config/secrets.yml','gcp/service-account.json','infra/prod.tfvars','infra/terraform.tfstate','.ssh/config','.aws/credentials','auth.json'])assert.ok(SECRET_FILE.test(path),path);
 for(const path of ['src/app.js','config/app.php','README.md','src/keyboard.ts','docs/environment.md'])assert.ok(!SECRET_FILE.test(path),path);
});
