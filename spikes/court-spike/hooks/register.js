// Agent Court, Phase 0 spike (round 2).
//
// Purpose: find out what the engine really does at the points the court
// depends on. Everything here is inert unless a marker is present:
//   - a Bash command containing `SPIKE_...`
//   - an Agent prompt containing `[spike:...]` (this also registers the run:
//     only registered runs are logged)
//   - a Read path containing `spike-throw-nocatch`
// Calls of unregistered agents pass through untouched and unlogged.
//
// Logging: one file per event, written once and never rewritten, so no write
// can overwrite another. Every string is masked and cut before it is stored.

const DIR =
  '/private/tmp/claude-502/-Users-DNDark--claude-spares-spare-6VgD0p/76c81449-f142-4837-ac79-9816c9e1c562/scratchpad/court-spike/round2'
const BOOT = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

let seq = 0
let partSeq = 0
let composeCount = 0
const registered = new Map() // agentId -> { type, flags }: runs started with a [spike:...] prompt
const detained = new Set() // agentIds whose every further tool call is refused
const redone = new Set() // agentIds whose hand-back was already sent back once

const MASKS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private-key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[aws-key]'],
  [/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, '[key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[github-token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[slack-token]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [masked]'],
  [/(:\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1[masked]@'],
  [
    /((?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|authorization|credential|private[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^\s"'&;]+/gi,
    '$1[masked]',
  ],
  [/[A-Za-z0-9+_=-]{48,}/g, '[long-token]'],
]

function text(x) {
  try {
    return x instanceof Error ? `${x.name}: ${x.message}` : String(x)
  } catch {
    return 'unprintable'
  }
}

function mask(value) {
  let out = String(value)
  for (const [pattern, replacement] of MASKS) out = out.replace(pattern, replacement)
  return out.length > 240 ? out.slice(0, 240) + '…' : out
}

function scrub(value, depth) {
  if (typeof value === 'string') return mask(value)
  if (value === null || typeof value !== 'object') return value
  if (depth > 5) return '[deep]'
  if (Array.isArray(value)) return value.slice(0, 40).map(item => scrub(item, depth + 1))
  const out = {}
  for (const key of Object.keys(value)) out[key] = scrub(value[key], depth + 1)
  return out
}

async function log($, kind, data) {
  seq += 1
  const eventSeq = seq
  const name = BOOT + '-' + String(eventSeq).padStart(4, '0')
  const row = { t: Date.now(), boot: BOOT, seq: eventSeq, kind, ...scrub(data, 0) }
  try {
    const status = await publish($, DIR + '/log', name, row)
    if (status !== 'published' && status !== 'duplicate') throw new Error('log publication: ' + status)
  } catch (err) {
    try {
      await $.store.set('spike:log-error:' + BOOT + ':' + eventSeq, mask(text(err)))
    } catch {
      // nowhere left to write
    }
  }
}

function flagsOf(prompt) {
  return (prompt || '').match(/\[spike:[^\]]+\]/g) || []
}

function isRegistered(agentId) {
  return agentId !== undefined && registered.has(agentId)
}

function refusalIfDetained(e) {
  // One explicit exception: a bounded report to the parent, with no tool execution.
  if (e.tool === 'SubagentHandback' && typeof e.message === 'string' && e.message.length <= 8000) return undefined
  return e.agentId !== undefined && detained.has(e.agentId)
    ? { deny: 'court-spike: this agent is detained (test). Stop now and report what you did so far.' }
    : undefined
}

async function stopAgent($, agentId, why) {
  const out = { agentId, why }
  try {
    out.before = (await $.agent.list()).filter(a => a.id === agentId).map(a => a.status)
  } catch (err) {
    out.listError = text(err)
  }
  try {
    const stopped = await $.tool.call({ tool: 'TaskStop', task_id: agentId })
    out.stop = stopped.deny !== undefined ? { deny: stopped.deny } : { isError: stopped.isError, text: stopped.text }
  } catch (err) {
    out.stopError = text(err)
  }
  try {
    out.after = (await $.agent.list()).filter(a => a.id === agentId).map(a => a.status)
  } catch (err) {
    out.listError2 = text(err)
  }
  await log($, 'stop.attempt', out)
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Publish one complete record under its id, or learn that the id is taken.
// The record is written to a private part file, read back, and only then
// given its final name with a hard link, which the file system refuses when
// the name exists. A reader that lists final names never sees a partial record.
async function publish($, dir, id, payload) {
  const body = JSON.stringify(payload)
  const record = JSON.stringify({ id, sha256: await sha256(body), body }) + '\n'
  const finalPath = dir + '/' + id + '.json'
  partSeq += 1
  const partPath = dir + '/.part-' + id + '-' + BOOT + '-' + partSeq
  await $.fs.write(partPath, record)
  const back = await $.fs.read(partPath)
  if (back !== record) {
    await $.process.run(['rm', '-f', partPath])
    return 'write-mismatch'
  }
  const link = await $.process.run(['ln', partPath, finalPath])
  await $.process.run(['rm', '-f', partPath])
  if (link.exitCode === 0) return 'published'
  try {
    return (await $.fs.read(finalPath)) === record ? 'duplicate' : 'conflict'
  } catch {
    return 'link-failed'
  }
}

async function readLedger($, dir) {
  const out = { valid: 0, invalid: 0, parts: 0 }
  const entries = await $.fs.list(dir)
  for (const entry of entries) {
    if (entry.kind !== 'file') continue
    if (entry.name.startsWith('.part-')) {
      out.parts += 1
      continue
    }
    if (!entry.name.endsWith('.json')) continue
    try {
      const record = JSON.parse(await $.fs.read(dir + '/' + entry.name))
      if ((await sha256(record.body)) === record.sha256) out.valid += 1
      else out.invalid += 1
    } catch {
      out.invalid += 1
    }
  }
  return out
}

async function storageTests($, command) {
  const out = {}
  try {
    out.session = await $.session.id()
  } catch (err) {
    out.sessionError = text(err)
  }

  if (command.includes('SPIKE_FSDIR')) {
    const path = DIR + '/newdir-' + BOOT + '/2026-11/one-event.json'
    try {
      await $.fs.write(path, '{"ok":true}\n')
      out.newDir = { wrote: true, exists: await $.fs.exists(path) }
    } catch (err) {
      out.newDir = { error: text(err) }
    }
  }

  if (command.includes('SPIKE_PUBLISH_DUP')) {
    const dir = DIR + '/ledger-dup'
    try {
      const id = 'evt-dup-' + BOOT
      out.first = await publish($, dir, id, { n: 1 })
      out.sameAgain = await publish($, dir, id, { n: 1 })
      out.differentBody = await publish($, dir, id, { n: 2 })
      await $.fs.write(dir + '/.part-crashed-' + BOOT, '{"id":"crashed","sha')
      out.ledger = await readLedger($, dir)
    } catch (err) {
      out.dupError = text(err)
    }
  }

  const batch = command.match(/SPIKE_PUBLISH_BATCH_(\d+)_([a-z0-9-]{8,64})\b/)
  if (command.includes('SPIKE_PUBLISH_BATCH_') && !batch) {
    out.status = 'invalid-run-id'
    await log($, 'storage', out)
    return
  }
  if (batch) {
    const runId = batch[2]
    const dir = DIR + '/ledger-shared/' + runId
    const count = Math.min(Number(batch[1]), 400)
    out.runId = runId
    out.count = count
    const tally = {}
    let worstInvalid = 0
    try {
      // A fresh run id is shared by exactly two writers; the runner releases GO
      // only after both distinct session ids have published readiness.
      if (!out.session) throw new Error('session identity unavailable')
      await $.fs.write(dir + '/.ready-' + out.session, runId)
      const gate = await $.process.run(
        ['sh', '-c', 'i=0; while [ $i -lt 150 ]; do if [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; then exit 0; fi; sleep 0.2; i=$((i+1)); done; exit 1', 'sh', dir + '/GO', runId],
        { timeoutMs: 40000 },
      )
      out.gate = gate.exitCode
      if (gate.exitCode !== 0) {
        out.status = 'start-timeout'
        await log($, 'storage', out)
        return
      }
      out.startedAt = Date.now()
      for (let i = 0; i < count; i += 1) {
        const status = await publish($, dir, 'evt-' + String(i).padStart(4, '0'), { i })
        tally[status] = (tally[status] || 0) + 1
        await $.store.set('spike:batch:' + runId + ':' + out.session + ':' + i, i)
        if (i % 25 === 24) {
          const seen = await readLedger($, dir)
          if (seen.invalid > worstInvalid) worstInvalid = seen.invalid
        }
      }
      out.endedAt = Date.now()
      out.tally = tally
      out.worstInvalidSeenWhileWriting = worstInvalid
      out.ledger = await readLedger($, dir)
      out.storeKeysOfThisSession = (await $.store.keys()).filter(k => k.startsWith('spike:batch:' + runId + ':' + out.session + ':')).length
    } catch (err) {
      out.batchError = text(err)
      out.tally = tally
    }
  }

  await log($, 'storage', out)
}

/** @type {import('claude-code').Register} */
export const register = on => {
  on('session.start', async ($, e, next) => {
    const info = {}
    try {
      info.session = (await $.session.id()).slice(0, 8)
      info.version = (await $.session.version()).version
      const usage = await $.session.usage()
      info.rateLimits = usage.rateLimits
    } catch (err) {
      info.error = text(err)
    }
    try {
      // A registered no-op tool: calling it makes the engine reload an edited mod mid-turn.
      await $.tool.register({
        name: 'ping',
        description: 'court-spike: answers "pong". Used only to reload the spike mod while testing.',
        inputSchema: { type: 'object', properties: {} },
      })
      info.tool = 'registered'
    } catch (err) {
      info.toolError = text(err)
    }
    await log($, 'session.start', info)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__court-spike__ping' }, async $ => ({ result: 'pong from ' + $.plugin.name + ' ' + BOOT }))

  // Spawn gate: deny, change model, change type, prepend a lesson. Registers marked runs.
  on('agent.spawn', async ($, e, next) => {
    if (detained.has(e.parentAgentId) || (e.resume && detained.has(e.resume.agentId))) {
      return { deny: 'court-spike: a detained agent cannot delegate or resume (test).' }
    }
    const prompt = e.prompt || ''
    const flags = flagsOf(prompt)
    if (flags.length === 0) return next(e)

    const base = {
      subagentType: e.subagentType,
      model: e.model,
      parentModel: e.parentModel,
      parentAgentId: e.parentAgentId,
      background: e.background,
      permissionMode: e.permissionMode,
      flags,
    }
    if (flags.includes('[spike:deny-spawn]')) {
      await log($, 'agent.spawn.denied', base)
      return { deny: 'court-spike: this spawn was refused on purpose (test). Do not retry it.' }
    }

    let input = e
    if (flags.includes('[spike:background]')) input = { ...input, background: true }
    const model = prompt.match(/\[spike:model=([^\]]+)\]/)
    if (model) input = { ...input, model: model[1] }
    const type = prompt.match(/\[spike:type=([^\]]+)\]/)
    if (type) input = { ...input, subagentType: type[1] }
    if (flags.includes('[spike:lesson]')) {
      input = {
        ...input,
        prompt: 'COURT-SPIKE-LESSON: end your final answer with the exact token LESSON-7391.\n\n' + prompt,
      }
    }

    const result = await next(input)
    if (result.agentId) registered.set(result.agentId, { type: input.subagentType, flags })
    await log($, 'agent.spawn', { ...base, result: { model: result.model, agentId: result.agentId, deny: result.deny } })
    return result
  })

  // A single outer guard covers every tool, including Agent and TaskStop.
  // Court's own TaskStop runs in the main loop and has no detained agentId.
  on('tool.call', async ($, e, next) => {
    const refusal = refusalIfDetained(e)
    if (!refusal) return next(e)
    await log($, 'detained.refused', { agentId: e.agentId, tool: String(e.tool) })
    return refusal
  }).catch(async ($, e, next) => {
    if (next.called) return next(e)
    return refusalIfDetained(e) || next(e)
  })

  // Command gate. Fails closed for marked commands, open for everything else.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = e.command || ''
    const agentId = e.agentId

    const refusal = refusalIfDetained(e)
    if (refusal) {
      await log($, 'detained.refused', { agentId, tool: 'Bash' })
      return refusal
    }
    if (!command.includes('SPIKE_')) {
      if (isRegistered(agentId)) await log($, 'tool.call', { agentId, tool: 'Bash', runInBackground: e.run_in_background })
      return next(e)
    }

    await log($, 'tool.call.marked', { agentId, tool_use_id: e.tool_use_id, command })

    if (command.includes('SPIKE_DENY')) {
      return { deny: 'court-spike: refused before it ran (test). Do not retry; carry on with the rest of your task.' }
    }
    if (command.includes('SPIKE_THROW_CATCHFAIL')) throw new Error('spike: hook throws, and its catch will throw too')
    if (command.includes('SPIKE_THROW_CATCH')) throw new Error('spike: hook throws, its catch answers')
    if (command.includes('SPIKE_DETAIN')) {
      if (agentId !== undefined) detained.add(agentId)
      return { deny: 'court-spike: this agent is now detained (test). Stop and report what you did so far.' }
    }
    if (command.includes('SPIKE_STOP')) {
      if (agentId !== undefined) await stopAgent($, agentId, 'at its own tool call')
      return { deny: 'court-spike: a stop was attempted on this agent (test).' }
    }
    if (command.includes('SPIKE_LONGRUN')) {
      if (agentId !== undefined) {
        $.clock.after(4000, () => {
          stopAgent($, agentId, 'from a timer, while its command runs').catch(() => {})
        })
      }
      return next(e)
    }
    if (command.includes('SPIKE_FSDIR') || command.includes('SPIKE_PUBLISH')) {
      await storageTests($, command)
      return { deny: 'court-spike: the storage test ran (test); see the log.' }
    }
    if (command.includes('SPIKE_UIASK')) {
      // The other way to put a question to the person: hold the call inside tool.call.
      let answer = 'Refuse'
      let asked = 'answered'
      // Variant 2 puts the safe answer first, to tell a person from a first-option auto-answer.
      const isSecond = command.includes('SPIKE_UIASK2')
      const options = isSecond ? ['Refuse', 'Allow', 'Decide later'] : ['Allow', 'Refuse']
      const question = isSecond
        ? 'court-spike test 3: please pick the SECOND option, Allow.'
        : 'court-spike test: may this agent run its marked command? ' +
          (command.includes('SPIKE_UIASK_ALLOW') ? 'Please pick Allow.' : 'Please pick Refuse.')
      const began = Date.now()
      try {
        answer = await $.ui.ask(question, options)
      } catch (err) {
        asked = 'no answer: ' + text(err)
      }
      await log($, 'ui.ask', { agentId, asked, answer, waitedMs: Date.now() - began, options })
      if (answer !== 'Allow') return { deny: 'court-spike: the person did not allow this command (test).' }
      return next(e)
    }
    if (command.includes('SPIKE_CONTEXT')) {
      const ran = await next(e)
      if (ran.deny !== undefined) return ran
      return {
        ...ran,
        context: [...(ran.context ?? []), 'COURT-SPIKE-REMINDER: include the exact token REMINDER-4410 in your final answer.'],
      }
    }
    return next(e)
  }).catch(async ($, e, next) => {
    const command = e.command || ''
    if (command.includes('SPIKE_THROW_CATCHFAIL')) throw new Error('spike: the catch handler fails as well')
    if (next.called || !command.includes('SPIKE_')) return next(e)
    return { deny: 'court-spike: the guard failed (' + (next.error ? next.error.kind : 'unknown') + '), so the command was not run.' }
  })

  // A guard with no .catch: when it throws, the engine should skip it and the read goes ahead.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const refusal = refusalIfDetained(e)
    if (refusal) {
      await log($, 'detained.refused', { agentId: e.agentId, tool: 'Read' })
      return refusal
    }
    if ((e.file_path || '').includes('spike-throw-nocatch')) {
      await log($, 'read.throwing', { agentId: e.agentId })
      throw new Error('spike: a guard with no catch throws')
    }
    return next(e)
  })

  // Attribution: which loop edits which file.
  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const refusal = refusalIfDetained(e)
    if (refusal) {
      await log($, 'detained.refused', { agentId: e.agentId, tool: e.tool })
      return refusal
    }
    if (isRegistered(e.agentId)) await log($, 'file.write', { agentId: e.agentId, tool: e.tool, path: e.file_path })
    return next(e)
  })

  // Verdict channel 3 / forced rework: the subagent's own hand-back call.
  on('tool.call', { tool: /Handback/ }, async ($, e, next) => {
    if (!isRegistered(e.agentId)) return next(e)
    const meta = registered.get(e.agentId)
    const fields = Object.keys(e).filter(k => k !== 'tool' && k !== 'tool_use_id' && k !== 'agentId')
    await log($, 'handback.call', {
      agentId: e.agentId,
      tool: e.tool,
      isDetained: detained.has(e.agentId),
      fields: fields.map(k => (typeof e[k] === 'string' ? k + ':string:' + e[k].length : k + ':' + typeof e[k])),
    })
    if (meta.flags.includes('[spike:handback-deny]') && !redone.has(e.agentId)) {
      redone.add(e.agentId)
      return {
        deny: 'COURT-SPIKE-REDO: your report was sent back once (test). Hand it back again, ending it with the exact token REDO-3307.',
      }
    }
    let input = e
    if (meta.flags.includes('[spike:handback-note]')) {
      const key = fields.find(k => typeof e[k] === 'string' && e[k].length > 0)
      if (key) input = { ...e, [key]: e[key] + '\n\nCOURT-SPIKE-NOTE-6120: a court note appended to this report (test).' }
    }
    const ran = await next(input)
    await log($, 'handback.result', { agentId: e.agentId, keys: Object.keys(ran), denied: ran.deny, isError: ran.isError })
    return ran
  })

  // Verdict channel 1: a note attached to the Agent call's result in the parent loop.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const prompt = e.prompt || ''
    const ran = await next(e)
    if (prompt.includes('[spike:verdict]') && ran.deny === undefined && ran.isError !== true) {
      return {
        ...ran,
        context: [...(ran.context ?? []), 'COURT-SPIKE-VERDICT-5521: a court note attached to this Agent result (test).'],
      }
    }
    return ran
  })

  // Permission check: read the engine's own verdict, and turn a marked command into an ask.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const decided = await next(e)
    const command = e.input && typeof e.input === 'object' && typeof e.input.command === 'string' ? e.input.command : ''
    if (!command.includes('SPIKE_')) return decided
    await log($, 'tool.check', {
      agentId: e.agentId,
      approver: e.approver,
      isReadOnly: e.isReadOnly,
      core: { decision: decided.decision, reason: decided.reason, rule: decided.rule, hook: decided.hook },
      command,
    })
    if (command.includes('SPIKE_ASK_ALLOW')) {
      return { decision: 'ask', reason: 'court-spike test 1 of 2: please ALLOW this one.' }
    }
    if (command.includes('SPIKE_ASK_DENY')) {
      return { decision: 'ask', reason: 'court-spike test 2 of 2: please DENY this one.' }
    }
    return decided
  })

  // The agent's end: its cost by part, and how much of its transcript the mod can read.
  on('turn.complete', async ($, e, next) => {
    if (!isRegistered(e.agentId)) return next(e)
    const transcript = {}
    try {
      const rows = await $.session.messages({ agentId: e.agentId })
      if (Array.isArray(rows)) {
        const uses = rows.flatMap(r => r.toolUses || [])
        transcript.count = rows.length
        transcript.tools = uses.map(u => String(u.tool))
        transcript.answered = uses.filter(u => u.result !== undefined || u.text !== undefined).length
      } else {
        transcript.denied = true
      }
    } catch (err) {
      transcript.error = text(err)
    }
    await log($, 'turn.complete', {
      agentId: e.agentId,
      reason: e.reason,
      durationMs: e.durationMs,
      usage: e.usage,
      answerLength: (e.answer || '').length,
      transcript,
    })
    return next(e)
  })

  // Does the built-in guard still pass this one over?
  on('prompt.compose', async ($, e, next) => {
    if (composeCount < 3) {
      composeCount += 1
      await log($, 'prompt.compose', { n: composeCount, model: e.model })
    }
    return next(e)
  })
}
