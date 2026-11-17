import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

// These tests use the installed engine's hook chain, with no model requests.
function storage(on: On) {
  const files = new Map<string, string>()
  mock.store(on)
  on('fs.write', (_$, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('process.run', (_$, e) => {
    let exitCode = 0
    if (e.argv[0] === 'ln') {
      if (files.has(e.argv[2])) exitCode = 1
      else files.set(e.argv[2], files.get(e.argv[1]) ?? '')
    } else if (e.argv[0] === 'rm') files.delete(e.argv[2])
    else throw new Error('Unexpected test process')
    return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return files
}

test('detained loop cannot execute any tool, including delegation or TaskStop', async ($, on) => {
  storage(on)
  let executed = 0
  on('tool.call', () => { executed += 1; return { result: 'unexpected execution' } })
  await $.tool.call({ tool: 'Bash', agentId: 'detained', command: 'echo SPIKE_DETAIN' })
  for (const tool of ['Bash', 'Write', 'Agent', 'TaskStop', 'mcp__fixture__write']) {
    const result = await $.tool.call({ tool, agentId: 'detained', command: 'echo harmless', file_path: '/fixture', content: 'fixture', prompt: 'fixture', task_id: 'other' })
    expect(result.deny).toContain('detained')
  }
  expect(executed).toBe(0)
})

test('detention preserves bounded reporting and the court own stop call', async ($, on) => {
  storage(on)
  const executed: string[] = []
  on('tool.call', (_$, e) => { executed.push(e.tool); return { result: 'test result' } })
  await $.tool.call({ tool: 'Bash', agentId: 'detained', command: 'echo SPIKE_DETAIN' })
  await $.tool.call({ tool: 'SubagentHandback', agentId: 'detained', message: 'Stopped.' })
  await $.tool.call({ tool: 'TaskStop', task_id: 'detained' })
  const oversized = await $.tool.call({ tool: 'SubagentHandback', agentId: 'detained', message: 'x'.repeat(8001) })
  expect(oversized.deny).toContain('detained')
  expect(executed).toEqual(['SubagentHandback', 'TaskStop'])
})

test('registered handback note and one-time rework run through the native hook chain', async ($, on) => {
  storage(on)
  let id = 0
  on('agent.spawn', () => ({ model: 'fixture', agentId: 'agent-' + ++id }))
  const delivered: string[] = []
  on('tool.call', (_$, e) => { delivered.push(String(e.message)); return { result: 'delivered' } })
  const base = { description: 'fixture', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'fixture', background: true, fork: false }
  await $.agent.spawn({ ...base, prompt: '[spike:handback-note]' })
  await $.agent.spawn({ ...base, prompt: '[spike:handback-deny]' })
  await $.tool.call({ tool: 'SubagentHandback', agentId: 'agent-1', message: 'base' })
  const first = await $.tool.call({ tool: 'SubagentHandback', agentId: 'agent-2', message: 'first' })
  expect(first.deny).toContain('COURT-SPIKE-REDO')
  await $.tool.call({ tool: 'SubagentHandback', agentId: 'agent-2', message: 'second REDO-3307' })
  expect(delivered).toEqual(['base\n\nCOURT-SPIKE-NOTE-6120: a court note appended to this report (test).', 'second REDO-3307'])
})
