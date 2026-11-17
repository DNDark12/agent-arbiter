import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const target = process.env.COURT_MOD_PATH || new URL('./hooks/register.js', import.meta.url).pathname

async function fixture() {
  const source = await fs.readFile(target, 'utf8')
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { log, publish, readLedger, storageTests };').toString('base64') + '#' + randomUUID())
  const hooks = []
  mod.register((event, match, fn) => {
    if (typeof match === 'function') { fn = match; match = undefined }
    const hook = { event, match, fn }
    hooks.push(hook)
    return { catch(handler) { hook.catch = handler } }
  })
  const files = new Map()
  const store = new Map()
  let gateExit = 0
  let partialObserved = false
  const publications = []
  function inspect() {
    for (const [name, value] of files) {
      if (!path.basename(name).startsWith('.') && name.endsWith('.json')) {
        try { JSON.parse(value) } catch { partialObserved = true }
      }
    }
  }
  const $ = {
    fs: {
      async write(name, value) {
        files.set(name, value.slice(0, Math.floor(value.length / 2)))
        inspect()
        await Promise.resolve()
        files.set(name, value)
      },
      async read(name) { if (!files.has(name)) throw Error('ENOENT'); return files.get(name) },
      async list(dir) { return [...files.keys()].filter(p => p.startsWith(dir + '/')).map(p => ({ name: p.slice(dir.length + 1), kind: 'file' })) },
      async exists(name) { return files.has(name) },
    },
    store: { async set(k, v) { store.set(k, v) }, async keys() { return [...store.keys()] } },
    session: { async id() { return 'mock-session-' + randomUUID() }, async messages() { return [] } },
    process: {
      async run(argv) {
        if (argv[0] === 'sh') return { exitCode: gateExit, stdout: '', stderr: '' }
        if (argv[0] === 'ln') {
          if (files.has(argv[2])) return { exitCode: 1 }
          files.set(argv[2], files.get(argv[1])); publications.push(argv[2]); inspect()
          return { exitCode: 0 }
        }
        if (argv[0] === 'rm') { files.delete(argv[2]); return { exitCode: 0 } }
        throw Error('Unexpected process: ' + argv[0])
      },
    },
  }
  function matches(m, e) {
    if (!m) return true
    const pattern = m.tool
    return Array.isArray(pattern) ? pattern.includes(e.tool) : pattern instanceof RegExp ? pattern.test(e.tool) : pattern === e.tool
  }
  async function dispatch(event, input, core = async () => ({ result: 'mock core' })) {
    const chain = hooks.filter(h => h.event === event && matches(h.match, input))
    async function next(i, e) {
      if (i === chain.length) return core(e)
      const downstream = n => next(i + 1, n)
      return chain[i].fn($, e, downstream)
    }
    return next(0, input)
  }
  async function detain() {
    await dispatch('agent.spawn', { prompt: '[spike:detain]', subagentType: 'general-purpose' }, async () => ({ agentId: 'subject', model: 'test' }))
    await dispatch('tool.call', { tool: 'Bash', agentId: 'subject', command: 'echo SPIKE_DETAIN', tool_use_id: 'detain' })
  }
  return { $, mod, files, store, publications, dispatch, detain, setGate(code) { gateExit = code }, get partialObserved() { return partialObserved } }
}

test('detention prevents delegation, stopping another agent, writes and connector calls', async () => {
  const f = await fixture(); await f.detain()
  for (const tool of ['Bash', 'Write', 'Agent', 'TaskStop', 'mcp__probe__write']) {
    let reached = false
    const result = await f.dispatch('tool.call', { tool, agentId: 'subject', command: 'echo harmless', prompt: 'ordinary', task_id: 'another', file_path: '/mock' }, async () => { reached = true; return {} })
    assert.ok(result.deny, tool); assert.equal(reached, false, tool)
  }
})

test('detained parent cannot spawn directly and a detained agent cannot resume', async () => {
  const f = await fixture(); await f.detain()
  for (const input of [{ parentAgentId: 'subject', prompt: 'ordinary' }, { resume: { agentId: 'subject' } }]) {
    let reached = false
    const result = await f.dispatch('agent.spawn', input, async () => { reached = true; return { agentId: 'new' } })
    assert.ok(result.deny); assert.equal(reached, false)
  }
})

test('background fixture explicitly requests the native background path', async () => {
  const f = await fixture()
  let observed
  await f.dispatch('agent.spawn', { prompt: '[spike:background]', background: false }, async e => { observed = e.background; return { agentId: 'bg' } })
  assert.equal(observed, true)
})

test('Court stop call and bounded report handback remain available', async () => {
  const f = await fixture(); await f.detain()
  for (const input of [{ tool: 'TaskStop', task_id: 'subject' }, { tool: 'SubagentHandback', agentId: 'subject', message: 'Stopped; no more work.' }]) {
    let reached = false
    await f.dispatch('tool.call', input, async () => { reached = true; return {} })
    assert.equal(reached, true)
  }
})

test('logger only publishes complete final records', async () => {
  const f = await fixture()
  await Promise.all([f.mod.log(f.$, 'a', { n: 1 }), f.mod.log(f.$, 'b', { n: 2 })])
  assert.equal(f.partialObserved, false)
  assert.equal([...f.files.keys()].filter(p => p.endsWith('.json')).length, 2)
})

test('logger masks errors in its fallback store', async () => {
  const f = await fixture()
  f.$.fs.write = async () => { throw Error('Authorization: Bearer FAKE_SECRET_FOR_REGRESSION') }
  await f.mod.log(f.$, 'a', {})
  assert.ok(f.store.size > 0)
  assert.equal(JSON.stringify([...f.store.values()]).includes('FAKE_SECRET_FOR_REGRESSION'), false)
})

test('unregistered ordinary agent is not logged', async () => {
  const f = await fixture()
  await f.dispatch('tool.call', { tool: 'Bash', agentId: 'ordinary', command: 'echo unmarked' })
  await f.dispatch('turn.complete', { agentId: 'ordinary', answer: 'private' })
  assert.equal(f.files.size, 0)
})

test('failed batch start gate publishes no ledger events', async () => {
  const f = await fixture(); f.setGate(1)
  await f.mod.storageTests(f.$, 'SPIKE_PUBLISH_BATCH_2_round2-test-001')
  assert.equal(f.publications.filter(p => p.includes('/ledger-shared/')).length, 0)
})

test('batch refuses missing unique run id', async () => {
  const f = await fixture()
  await f.mod.storageTests(f.$, 'SPIKE_PUBLISH_BATCH_2')
  assert.equal(f.publications.filter(p => p.includes('/ledger-shared')).length, 0)
})

test('hard-link publication handles real concurrent writers, duplicates and conflicts', async () => {
  const f = await fixture(); const other = await fixture()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'court-regression-'))
  const real = {
    fs: {
      async write(p, body) {
        await fs.mkdir(path.dirname(p), { recursive: true })
        const handle = await fs.open(p, 'w')
        const middle = Math.floor(body.length / 2)
        await handle.write(body.slice(0, middle)); await new Promise(resolve => setTimeout(resolve, 1))
        await handle.write(body.slice(middle)); await handle.close()
      },
      read: p => fs.readFile(p, 'utf8'),
      async list(p) { return (await fs.readdir(p)).map(name => ({ name, kind: 'file' })) },
    },
    process: { async run(argv) { try { const out = await run(argv[0], argv.slice(1)); return { exitCode: 0, ...out } } catch (e) { return { exitCode: e.code, stdout: e.stdout, stderr: e.stderr } } } },
  }
  let active = true; let invalid = 0
  const reader = (async () => { while (active) { invalid += (await f.mod.readLedger(real, dir)).invalid; await new Promise(resolve => setTimeout(resolve, 1)) } })()
  const results = await Promise.all([f.mod, other.mod].map(async m => {
    const statuses = []
    for (let i = 0; i < 32; i++) statuses.push(await m.publish(real, dir, 'evt-' + i, { i }))
    return statuses
  }))
  active = false; await reader
  assert.equal(invalid, 0)
  assert.equal(results.flat().filter(s => s === 'published').length, 32)
  assert.equal(results.flat().filter(s => s === 'duplicate').length, 32)
  assert.equal(await f.mod.publish(real, dir, 'evt-0', { i: 999 }), 'conflict')
  await fs.writeFile(path.join(dir, '.part-interrupted'), '{')
  assert.deepEqual(await f.mod.readLedger(real, dir), { valid: 32, invalid: 0, parts: 1 })
  await fs.rm(dir, { recursive: true, force: true })
})
