import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import * as ledger from '../plugins/agent-arbiter/hooks/ledger.js';

const exec = promisify(execFile);
const projectId = 'a'.repeat(64);

function event(index, overrides = {}) {
  return {
    schemaVersion: 1,
    id: createHash('sha256').update(String(index)).digest('hex'),
    projectId,
    sessionId: 'session-a',
    agentId: null,
    kind: 'tool.request',
    occurredAt: index,
    data: { toolCallId: `call-${index}`, tool: 'Read' },
    ...overrides,
  };
}

async function stat(path) {
  const link = await fs.lstat(path);
  const info = link.isSymbolicLink() ? await fs.stat(path) : link;
  return {
    kind: info.isFile() ? 'file' : info.isDirectory() ? 'dir' : 'other',
    isLink: link.isSymbolicLink(),
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

function adapter() {
  return {
    fs: {
      read: path => fs.readFile(path, 'utf8'),
      async write(path, text) {
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(path, text);
      },
      async exists(path) {
        try { await fs.lstat(path); return true; }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      },
      async list(path) {
        const entries = await fs.readdir(path, { withFileTypes: true });
        const result = [];
        for (const entry of entries) {
          try {
            const info = await fs.lstat(join(path, entry.name));
            result.push({ name: entry.name, kind: info.isFile() ? 'file' :
              info.isDirectory() ? 'dir' : 'other', isLink: info.isSymbolicLink(),
            size: info.isFile() ? info.size : 0,
            mtimeMs: info.isFile() ? info.mtimeMs : 0 });
          } catch (error) {
            // Like a directory listing, a concurrently removed private part is absent.
            if (error.code !== 'ENOENT') throw error;
          }
        }
        return result;
      },
      stat,
    },
    process: {
      async run(argv) {
        try {
          const { stdout, stderr } = await exec(argv[0], argv.slice(1));
          return { exitCode: 0, stdout, stderr };
        } catch (error) {
          if (typeof error.code !== 'number') throw error;
          return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
        }
      },
    },
  };
}

async function temporary(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'agent-arbiter-ledger-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function envelope(item) {
  const body = ledger.canonical(item);
  return ledger.canonical({ id: item.id, sha256: await ledger.digest(body), body });
}

function api(name) {
  assert.equal(typeof ledger[name], 'function', `${name} is exported`);
  return ledger[name];
}

test('canonical sorts nested object keys and preserves JSON values', () => {
  const canonical = api('canonical');
  assert.equal(canonical({ z: [null, false, 'é', { b: 2, a: 1 }], a: -0 }),
    '{"a":0,"z":[null,false,"é",{"a":1,"b":2}]}');
  assert.equal(canonical({ 20: 'b', 3: 'a' }), '{"20":"b","3":"a"}');
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
});

test('canonical rejects non-JSON values instead of silently losing evidence', () => {
  const canonical = api('canonical');
  const cycle = {};
  cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, 1n, { a: undefined }, [undefined],
    new Array(1), new Date(), cycle, () => {}]) {
    assert.throws(() => canonical(value), /JSON|finite|cyclic/i);
  }
});

test('digest is lowercase SHA-256 of UTF-8 text', async () => {
  const digest = api('digest');
  for (const text of ['', 'abc', 'Sổ sự kiện']) {
    assert.equal(await digest(text), createHash('sha256').update(text).digest('hex'));
  }
});

test('publish is immutable, idempotent and preserves conflicting first evidence', async t => {
  const publish = api('publish');
  const readLedger = api('readLedger');
  const dir = join(await temporary(t), 'new-ledger');
  const $ = adapter();
  const original = event(1);
  assert.equal(await publish($, dir, original), 'published');
  const bytes = await fs.readFile(join(dir, `${original.id}.json`), 'utf8');
  assert.equal(bytes, await envelope(original));
  assert.equal(await publish($, dir, { ...original, data: { tool: 'Read', toolCallId: 'call-1' } }), 'duplicate');
  assert.equal(await publish($, dir, { ...original, data: { tool: 'Write' } }), 'conflict');
  assert.equal(await fs.readFile(join(dir, `${original.id}.json`), 'utf8'), bytes);
  assert.deepEqual(await readLedger($, dir), { events: [original], invalid: [], parts: [] });
});

test('two real concurrent writers publish 120 common IDs while a reader sees only complete finals', async t => {
  const publish = api('publish');
  const readLedger = api('readLedger');
  const dir = await temporary(t);
  const $ = adapter();
  const events = Array.from({ length: 120 }, (_, index) => event(index));
  let finished = false;
  let reads = 0;
  let previousCount = 0;
  const reader = (async () => {
    while (!finished) {
      const result = await readLedger($, dir);
      assert.deepEqual(result.invalid, []);
      assert.ok(result.events.length >= previousCount);
      previousCount = result.events.length;
      reads += 1;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  })();
  const write = async items => {
    const statuses = [];
    for (const item of items) statuses.push(await publish($, dir, item));
    return statuses;
  };
  let outcomes;
  try { outcomes = (await Promise.all([write(events), write([...events].reverse())])).flat(); }
  finally { finished = true; await reader; }
  assert.ok(reads > 2, 'reader ran continuously during writes');
  assert.equal(outcomes.filter(value => value === 'published').length, 120);
  assert.equal(outcomes.filter(value => value === 'duplicate').length, 120);
  const final = await readLedger($, dir);
  assert.deepEqual(final.events, events);
  assert.deepEqual(final.invalid, []);
  assert.deepEqual(final.parts, []);
});

test('publish rejects invalid schemas and traversal IDs before touching storage', async t => {
  const publish = api('publish');
  const dir = join(await temporary(t), 'untouched');
  for (const invalid of [event(1, { id: '../outside' }), event(1, { id: 'F'.repeat(64) }),
    event(1, { projectId: 'project' }), event(1, { schemaVersion: 2 }),
    event(1, { sessionId: '' }), event(1, { agentId: 123 }),
    event(1, { occurredAt: Infinity }), event(1, { data: [] }),
    event(1, { data: { lost: undefined } })]) {
    await assert.rejects(publish(adapter(), dir, invalid), /event|JSON|finite/i);
  }
  assert.equal(await adapter().fs.exists(dir), false);
});

test('publish detects failed readback and absent-final link failures', async t => {
  const publish = api('publish');
  const dir = await temporary(t);
  const badRead = adapter();
  badRead.fs.read = async () => 'truncated';
  await assert.rejects(publish(badRead, dir, event(1)), /readback/i);
  assert.equal(await adapter().fs.exists(join(dir, `${event(1).id}.json`)), false);
  const noLinks = adapter();
  const run = noLinks.process.run;
  noLinks.process.run = async argv => argv[0] === '/bin/ln'
    ? { exitCode: 1, stdout: '', stderr: 'link denied' } : run(argv);
  await assert.rejects(publish(noLinks, dir, event(2)), /link|publish/i);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('publish propagates filesystem and process failures', async t => {
  const publish = api('publish');
  const dir = await temporary(t);
  const writeDenied = adapter();
  writeDenied.fs.write = async () => { throw new Error('write denied'); };
  await assert.rejects(publish(writeDenied, dir, event(1)), /write denied/);
  const unlinkDenied = adapter();
  const run = unlinkDenied.process.run;
  unlinkDenied.process.run = async argv => argv[0] === '/bin/rm'
    ? { exitCode: 1, stdout: '', stderr: 'remove denied' } : run(argv);
  await assert.rejects(publish(unlinkDenied, dir, event(2)), /remove|cleanup/i);
  const result = await api('readLedger')(adapter(), dir);
  assert.deepEqual(result.events, [event(2)]);
  assert.equal(result.parts.length, 1);
});

test('reader reports corrupt final files and interrupted private parts explicitly', async t => {
  const readLedger = api('readLedger');
  const dir = await temporary(t);
  const $ = adapter();
  await $.fs.write(join(dir, `${event(1).id}.json`), await envelope(event(1)));
  const wrongHash = JSON.parse(await envelope(event(2)));
  wrongHash.sha256 = '0'.repeat(64);
  await $.fs.write(join(dir, `${event(2).id}.json`), JSON.stringify(wrongHash));
  await $.fs.write(join(dir, `${event(3).id}.json`), '{partial');
  await $.fs.write(join(dir, `${event(4).id}.json`), await envelope(event(5)));
  await $.fs.write(join(dir, `${event(6).id}.json`), await envelope(event(6, { schemaVersion: 2 })));
  const noncanonical = JSON.stringify(event(7));
  await $.fs.write(join(dir, `${event(7).id}.json`), JSON.stringify({ id: event(7).id,
    sha256: await ledger.digest(noncanonical), body: noncanonical }));
  const part = `.part-${event(8).id}-${'b'.repeat(32)}`;
  await $.fs.write(join(dir, part), 'interrupted');
  await $.fs.write(join(dir, 'unrelated.json'), 'unrelated');
  await fs.symlink(join(dir, `${event(1).id}.json`), join(dir, `${event(9).id}.json`));
  await fs.mkdir(join(dir, `${event(10).id}.json`));
  const result = await readLedger($, dir);
  assert.deepEqual(result.events, [event(1)]);
  assert.equal(result.invalid.length, 7);
  assert.ok(result.invalid.every(item => typeof item.reason === 'string' && item.reason.length));
  assert.deepEqual(result.parts.map(item => item.name), [part]);
});

test('reader treats absent directory as empty but propagates unreadable storage', async t => {
  const readLedger = api('readLedger');
  const dir = join(await temporary(t), 'absent');
  assert.deepEqual(await readLedger(adapter(), dir), { events: [], invalid: [], parts: [] });
  const deniedList = adapter();
  deniedList.fs.exists = async () => true;
  deniedList.fs.list = async () => { throw new Error('list denied'); };
  await assert.rejects(readLedger(deniedList, dir), /list denied/);
  await adapter().fs.write(join(dir, `${event(1).id}.json`), await envelope(event(1)));
  const deniedRead = adapter();
  deniedRead.fs.read = async () => { throw new Error('read denied'); };
  await assert.rejects(readLedger(deniedRead, dir), /read denied/);
});

test('explicit cleanup removes only own expired regular parts using an absolute age cutoff', async t => {
  const cleanupParts = api('cleanupParts');
  const dir = await temporary(t);
  const $ = adapter();
  const old = `.part-${event(1).id}-${'1'.repeat(32)}`;
  const fresh = `.part-${event(2).id}-${'2'.repeat(32)}`;
  const link = `.part-${event(3).id}-${'3'.repeat(32)}`;
  const folder = `.part-${event(4).id}-${'4'.repeat(32)}`;
  const malformed = `.part-${event(5).id}-unrelated`;
  const final = `${event(6).id}.json`;
  for (const name of [old, fresh, malformed, final]) await $.fs.write(join(dir, name), 'bytes');
  const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const name of [old, malformed, final]) await fs.utimes(join(dir, name), oldTime, oldTime);
  await fs.symlink(join(dir, final), join(dir, link));
  await fs.mkdir(join(dir, folder));
  await fs.utimes(join(dir, folder), oldTime, oldTime);
  assert.equal(await cleanupParts($, dir), 1);
  assert.deepEqual((await fs.readdir(dir)).sort(), [fresh, link, folder, malformed, final].sort());
  assert.equal(await cleanupParts($, dir), 0);
  assert.equal(await cleanupParts($, join(dir, 'absent')), 0);
});

test('cleanup checks current part metadata and rejects unsafe age arguments', async t => {
  const cleanupParts = api('cleanupParts');
  const dir = await temporary(t);
  const $ = adapter();
  const name = `.part-${event(1).id}-${'1'.repeat(32)}`;
  await $.fs.write(join(dir, name), 'active writer');
  const list = $.fs.list;
  $.fs.list = async path => (await list(path)).map(entry => ({ ...entry, mtimeMs: 1 }));
  assert.equal(await cleanupParts($, dir, 1000), 0);
  for (const age of [-1, Infinity, NaN, '1000']) {
    await assert.rejects(cleanupParts($, dir, age), /age|finite|non-negative/i);
  }
  const denied = adapter();
  denied.fs.list = async () => { throw new Error('cleanup list denied'); };
  await assert.rejects(cleanupParts(denied, dir), /cleanup list denied/);
});

test('replay deduplicates events and produces stable session/agent and tool attribution', () => {
  const replay = api('replay');
  const file = { path: 'src/app.js', scope: 'project' };
  const request = event(1, { agentId: 'agent-a', data: { toolCallId: 'same-call', tool: 'Write', file } });
  const result = event(2, { agentId: 'agent-a', kind: 'tool.result',
    data: { toolCallId: 'same-call', tool: 'Write', status: 'completed' } });
  const pending = event(3, { data: { toolCallId: 'pending-call', tool: 'Edit', file } });
  const orphan = event(4, { sessionId: 'session-b', kind: 'tool.result',
    data: { toolCallId: 'same-call', tool: 'Read', status: 'error' } });
  const other = event(5, { kind: 'turn.complete', data: {} });
  const events = [other, orphan, request, result, pending, request];
  const summary = replay(events);
  assert.deepEqual(replay([...events].reverse()), summary);
  assert.equal(summary.eventCount, 5);
  assert.deepEqual(summary.conflicts, []);
  assert.deepEqual(summary.runs, [
    { sessionId: 'session-a', agentId: 'agent-a', eventCount: 2, firstOccurredAt: 1, lastOccurredAt: 2 },
    { sessionId: 'session-a', agentId: null, eventCount: 2, firstOccurredAt: 3, lastOccurredAt: 5 },
    { sessionId: 'session-b', agentId: null, eventCount: 1, firstOccurredAt: 4, lastOccurredAt: 4 },
  ]);
  assert.equal(summary.toolCalls.length, 3);
  assert.deepEqual(summary.toolCalls[0], {
    sessionId: 'session-a', agentId: 'agent-a', toolCallId: 'same-call', tool: 'Write',
    requestIds: [request.id], resultIds: [result.id], status: 'completed', file,
  });
  assert.equal(summary.toolCalls[1].status, 'pending');
  assert.equal(summary.toolCalls[2].status, 'orphan-result');
  assert.deepEqual(summary.attribution, [
    { sessionId: 'session-a', agentId: 'agent-a', toolCallId: 'same-call', tool: 'Write',
      file, requestId: request.id, status: 'completed' },
    { sessionId: 'session-a', agentId: null, toolCallId: 'pending-call', tool: 'Edit',
      file, requestId: pending.id, status: 'pending' },
  ]);
  assert.equal(JSON.stringify(summary).match(/verdict|guilt|score/i), null);
});

test('replay exposes conflicting event IDs without deriving evidence from either body', () => {
  const replay = api('replay');
  const first = event(1);
  const altered = { ...first, agentId: 'other-actor' };
  const events = [first, event(2), altered, first];
  const summary = replay(events);
  assert.deepEqual(replay([...events].reverse()), summary);
  assert.equal(summary.eventCount, 2);
  assert.deepEqual(summary.conflicts, [{ type: 'event-id', id: first.id, variantCount: 2 }]);
  assert.equal(summary.runs[0].eventCount, 1);
  assert.equal(summary.toolCalls.length, 1);
});

test('replay makes ambiguous correlation and missing result status explicit', () => {
  const replay = api('replay');
  const first = event(1, { data: { toolCallId: 'duplicate', tool: 'Write' } });
  const second = event(2, { data: { toolCallId: 'duplicate', tool: 'Write' } });
  const result = event(3, { kind: 'tool.result', data: { toolCallId: 'duplicate', status: 'completed' } });
  const missing = event(4, { data: { tool: 'Read' } });
  const noStatusRequest = event(5);
  const noStatusResult = event(6, { kind: 'tool.result', data: { toolCallId: 'call-5' } });
  const summary = replay([first, second, result, missing, noStatusRequest, noStatusResult]);
  assert.equal(summary.toolCalls[0].status, 'conflict');
  assert.equal(summary.conflicts[0].type, 'tool-call');
  assert.equal(summary.toolCalls[1].status, 'uncorrelated');
  assert.equal(summary.toolCalls[1].toolCallId, null);
  assert.equal(summary.toolCalls[2].status, 'unknown');
  assert.throws(() => replay([event(1, { occurredAt: NaN })]), /event/);
});

test('replay marks contradictory actors under a session tool ID as conflict', () => {
  const a = event(101, { agentId: 'a', data: { toolCallId: 'collision', tool: 'Write' } });
  const b = event(102, { agentId: 'b', data: { toolCallId: 'collision', tool: 'Write' } });
  assert.equal(ledger.replay([a,b]).toolCalls.length, 1);
  assert.equal(ledger.replay([a,b]).toolCalls[0].status, 'conflict');
});
