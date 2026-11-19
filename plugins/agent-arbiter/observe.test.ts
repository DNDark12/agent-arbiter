import { test, expect } from 'claude-code/testing'
import { world } from './testing/world'


test('observe attributes concurrent writes and leaves arguments and answers unchanged', async ($, on) => {
  const w = world(on)
  const seen: unknown[] = []
  on('tool.call', (_$, e) => { seen.push(e); return { result: { ok: true }, context: ['original'] } })
  const inputs = ['a', 'b'].map(agentId => ({ tool: 'Write', agentId, tool_use_id: 'write-' + agentId, file_path: '/fixture/shared.js', content: 'password=PRIVATE-FIXTURE' }))
  const results = await Promise.all(inputs.map(e => $.tool.call(e)))
  expect(seen).toHaveLength(2)
  expect(results.map(r => r.context)).toEqual([['original'], ['original']])
  const requests = w.events().filter(e => e.kind === 'tool.request')
  expect(requests.map(e => e.agentId).sort()).toEqual(['a', 'b'])
  expect(requests.every(e => e.data.file.path === 'shared.js')).toBe(true)
  expect(w.events().filter(e => e.kind === 'tool.result')).toHaveLength(2)
  expect(JSON.stringify(w.events())).not.toContain('PRIVATE-FIXTURE')
})

test('ledger outage is visible and does not execute a tool twice or change its answer', async ($, on) => {
  const w = world(on, true)
  let executions = 0
  on('tool.call', () => { executions += 1; return { result: 'original result' } })
  const result = await $.tool.call({ tool: 'Bash', tool_use_id: 'once', command: 'echo private' })
  expect(executions).toBe(1)
  expect(result.result).toBe('original result')
  expect(w.warnings.length).toBeGreaterThan(0)
})

test('a denied spawn is recorded without inventing an agent id or citizen', async ($, on) => {
  const w = world(on)
  on('agent.spawn', () => ({ deny: 'fixture rejection' }))
  const result = await $.agent.spawn({ tool_use_id: 'spawn-1', prompt: 'private brief', description: 'fixture', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'actual-parent', background: true, fork: false })
  expect(result.deny).toBe('fixture rejection')
  const outcomes = w.events().filter(e => e.kind === 'spawn.result')
  expect(outcomes).toHaveLength(1)
  expect(outcomes[0].data.status).toBe('denied')
  expect(outcomes[0].data.childAgentId).toBe(null)
  expect(JSON.stringify(w.events())).not.toContain('private brief')
})

test('missing transcript produces explicit unknown coverage, no accusation', async ($, on) => {
  const w = world(on, false, { deny: 'not available' })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ agentId: 'a', turnId: 'turn-1', isAborted: false, reason: 'answer', answer: 'private answer', durationMs: 1, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'model' } })
  const ends = w.events().filter(e => e.kind === 'turn.complete')
  expect(ends).toHaveLength(1)
  expect(ends[0].data.transcript.status).toBe('unavailable')
  expect(ends[0].data.verdict).toBeUndefined()
  expect(JSON.stringify(w.events())).not.toContain('private answer')
})

test('a main-only turn is reviewed with usage and appears in the desktop Agents pane', async ($, on) => {
  const w = world(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: 'fixture' }))
  on('model.complete', () => ({ value: { isAnswered: true, text: JSON.stringify({
    scores: { completeness: 4, verification: 4 }, findings: [], exemplar: { worthy: false, why: '' },
  }) } }))
  await $.turn.start({ turnId: 'main-test', text: 'Read the fixture and summarize it.' })
  await $.tool.call({ tool: 'Read', file_path: '/fixture/notes.txt', tool_use_id: 'main-read' })
  await $.turn.complete({ turnId: 'main-test', isAborted: false, reason: 'answer', answer: 'Read it.',
    durationMs: 800, usage: { input_tokens: 4, output_tokens: 9, cache_creation_input_tokens: 1,
      cache_read_input_tokens: 10, model: 'claude-haiku-5-5' } })
  for (let n = 0; n < 400 && !w.events().some(e => e.kind === 'judge.review'); n++) {
    await $.command.run({ command: 'arbiter', args: 'help' })
  }
  expect(w.events().find(e => e.kind === 'tool.request').data.turnId).toBe('main-test')
  expect(w.events().find(e => e.kind === 'judge.review').data.citizen.kind).toBe('main')
  expect(w.events().some(e => e.kind === 'spawn.result')).toBe(false)
  await $.command.run({ command: 'arbiter', args: 'rules' })
  const ui = await $.ui.mount({ plugin: 'agent-arbiter', surface: 'desktop', component: 'Pane',
    requestId: 'arbiter-rules', props: { title: 'Agent Arbiter', isFocused: true, bodyColumns: 80, placement: 'inline' } })
  await ui.press({ key: 'tab-citizens' })
  await ui.select({ key: 'score-kind', value: 'main' })
  expect(await ui.find({ text: 'Main agent' })).toBeDefined()
  expect(await ui.find({ text: 'claude-haiku-5-5 · 1 turns' })).toBeDefined()
  expect(await ui.find({ text: '80/100' })).toBeDefined()
  expect(await ui.find({ text: 'cache read 10, cache write 1', exact: false })).toBeDefined()
  await ui.select({ key: 'score-kind', value: 'subagent' })
  expect(await ui.find({ text: 'No agent runs recorded yet.' })).toBeDefined()
  await ui.unmount()
})

test('duplicate delivery keeps one event pair and different payload cannot silently replace it', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: 'ok' }))
  const input = { tool: 'Write', tool_use_id: 'retry', file_path: '/fixture/first.js', content: 'private' }
  await $.tool.call(input)
  await $.tool.call({ content: input.content, file_path: input.file_path, tool_use_id: input.tool_use_id, tool: input.tool })
  expect(w.events().filter(e => e.kind === 'tool.request')).toHaveLength(1)
  await $.tool.call({ ...input, file_path: '/fixture/second.js' })
  expect(w.warnings.length).toBeGreaterThan(0)
  expect(w.events().find(e => e.kind === 'tool.request').data.file.path).toBe('first.js')
})

test('tool denial and tool error are preserved and recorded separately', async ($, on) => {
  const w = world(on)
  on('tool.call', (_$, e) => e.tool_use_id === 'denied' ? { deny: 'no' } : { result: 'failed', isError: true })
  expect((await $.tool.call({ tool: 'Bash', tool_use_id: 'denied', command: 'true' })).deny).toBe('no')
  expect((await $.tool.call({ tool: 'Bash', tool_use_id: 'error', command: 'false' })).isError).toBe(true)
  expect(w.events().filter(e => e.kind === 'tool.result').map(e => e.data.status).sort()).toEqual(['denied', 'error'])
})

test('startup registers the court command and verify reads the observed project', async ($, on) => {
  const w = world(on)
  let registered = false
  on('command.register', () => { registered = true; return { value: undefined } })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/fixture', surface: null, isInteractive: false })
  expect(registered).toBe(true)
  expect(w.events().filter(e => e.kind === 'session.start')).toHaveLength(1)
  const result = await $.command.run({ command: 'arbiter', args: 'verify' })
  expect(result.text).toContain('Events: 1')
  expect(result.text).toContain('Invalid: 0')
  expect(w.warnings).toHaveLength(0)
})

test('overlapping identical delivery does not manufacture a conflict', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: 'same' }))
  const e = { tool: 'Write', tool_use_id: 'concurrent-duplicate', file_path: '/fixture/a.js', content: 'same' }
  await Promise.all([$.tool.call(e), $.tool.call(e)])
  expect(w.events().filter(e => e.kind === 'tool.request')).toHaveLength(1)
  expect(w.events().filter(e => e.kind === 'ledger.conflict')).toHaveLength(0)
  expect(w.warnings).toHaveLength(0)
})

test('resume stores only agent ID and built-in identity is version-bound', async ($, on) => {
  const w = world(on)
  on('agent.offer', () => ({ isOffered: true }))
  on('agent.spawn', () => ({ agentId: 'existing-agent', model: 'actual-resolved-model' }))
  await $.agent.offer({ agent: 'Explore', description: 'fixture', source: 'built-in', provider: { plugin: 'engine', tier: 'core' } })
  await $.agent.spawn({ tool_use_id: 'resume-1', prompt: 'private', description: 'fixture', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'parent', background: true, fork: false, resume: { agentId: 'existing-agent' } })
  const request = w.events().find(e => e.kind === 'spawn.request')
  const result = w.events().find(e => e.kind === 'spawn.result')
  expect(request.data.resumeAgentId).toBe('existing-agent')
  expect(result.data.citizen.id).toBeTruthy()
  expect(result.data.citizen.identityStrength).toBe('engine-version')
  expect(result.data.citizen.definitionHash).toBe(null)
})
