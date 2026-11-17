import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonical, digest, readLedger, replay } from '../extension/hooks/ledger.js';

test('hook reload reuses persisted event time and reports a conflicting payload', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'court-reload-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const exec = promisify(execFile);
  let warnings = 0;
  async function stat(path) {
    const s = await fs.lstat(path);
    return { kind: s.isFile() ? 'file' : 'dir', isLink: s.isSymbolicLink(), mtimeMs: s.mtimeMs, realPath: path };
  }
  const $ = {
    settings:{read:async()=>({})}, env: { get: async k => k === 'CLAUDE_CONFIG_DIR' ? root : undefined }, plugin: { root }, session: { root: async () => '/fixture', id: async () => 'stable-session' },
    ui: { log: async () => { warnings += 1; } },
    fs: {
      stat, read: path => fs.readFile(path, 'utf8'),
      write: async (path, text) => { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, text); },
      exists: async path => { try { await fs.lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } },
      list: async path => Promise.all((await fs.readdir(path)).map(async name => ({ name, ...await stat(join(path, name)) }))),
    },
    process: { run: async argv => {
      try { return { exitCode: 0, ...await exec(argv[0], argv.slice(1)) }; }
      catch (e) { if (typeof e.code !== 'number') throw e; return { exitCode: e.code }; }
    } },
  };
  async function deliver(path) {
    const { register } = await import(`../extension/hooks/register.js?reload=${crypto.randomUUID()}`);
    let tool;
    register((name, match) => { if (name === 'tool.call') tool = match; return {catch(){}}; });
    return tool($, { tool: 'Write', tool_use_id: 'same-call', file_path: path }, async () => ({ result: 'unchanged' }));
  }
  await deliver('/fixture/a.js');
  const directory = join(root, 'plugins/data/agent-arbiter/v1/events', await digest('/fixture'), new Date().toISOString().slice(0, 7));
  // Simulate pre-migration evidence without checkoutId; a retry must preserve it.
  for (const filename of await fs.readdir(directory)) {
    const path = join(directory, filename);
    const envelope = JSON.parse(await fs.readFile(path, 'utf8'));
    const event = JSON.parse(envelope.body);
    delete event.data.checkoutId;
    envelope.body = canonical(event);
    envelope.sha256 = await digest(envelope.body);
    await fs.writeFile(path, canonical(envelope));
  }
  const first = await readLedger($, directory);
  await new Promise(resolve => setTimeout(resolve, 10));
  await deliver('/fixture/a.js');
  assert.deepEqual(await readLedger($, directory), first);
  assert.equal(warnings, 0);
  assert.deepEqual(await deliver('/fixture/b.js'), { result: 'unchanged' });
  assert.ok(warnings > 0);
  const after = await readLedger($, directory);
  assert.deepEqual(after.events.filter(e => e.kind !== 'ledger.conflict'), first.events);
  assert.equal(after.events.filter(e => e.kind === 'ledger.conflict').length, 2);
  assert.equal(replay(after.events).conflicts.filter(e => e.type === 'persisted-conflict').length, 2);
  assert.equal(replay(after.events).toolCalls[0].status, 'conflict');
  assert.equal(replay(after.events).attribution[0].status, 'conflict');
});
