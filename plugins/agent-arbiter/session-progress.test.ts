import { expect, mock, test } from 'claude-code/testing'
import type { PluginTier } from 'claude-code'
import { digest } from './hooks/ledger.js'
import { world } from './testing/world'

const config = async () => '/fixture-home/.claude/plugins/data/agent-arbiter/v1/projects/' + await digest('/fixture') + '/preferences.json'
const pane = { plugin: 'agent-arbiter', surface: 'desktop', component: 'Pane', requestId: 'arbiter-rules',
  props: { title: 'Agent Arbiter', isFocused: true, bodyColumns: 68, placement: 'inline' } } as const
const band = { hasSurvey: false, isCollapsed: false, isWorking: false, bodyColumns: 70, maxRows: 6,
  scroll: { offset: 0, bodyRows: 6 }, view: {} } as const

test('a check failure and its successful retry reach the desktop history while context comes from the engine', async ($, on) => {
  const w = world(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/fixture' }))
  on('session.usage', () => ({ value: { context: { window: 100, percent: 85 } } }))
  on('tool.call', (_$, e) => e.tool_use_id === 'fail-check'
    ? { isError: true, result: 'Exit code 1\nprivate output' }
    : { result: { stdout: 'private output', stderr: '', interrupted: false } })
  const run = (key: string, file: string) => $.tool.call({ tool: 'Bash', tool_use_id: key, command: 'npm test -- ' + file })
  await run('fail-check', 'fixture-a')
  await run('different', 'fixture-b')
  await $.command.run({ command: 'arbiter', args: '' })
  const ui = await $.ui.mount(pane)
  await ui.press({ key: 'tab-citizens' })
  await ui.select({ key: 'agent-section', value: 'history' })
  expect(await ui.find({ text: 'Test · Failed', exact: false })).toBeDefined()
  expect(await ui.find({ text: 'Context 85% full' })).toBeDefined()
  await run('retry-check', 'fixture-a')
  await ui.press({ key: 'refresh-rules' })
  expect(await ui.find({ text: 'Passed on retry', exact: false })).toBeDefined()
  expect(JSON.stringify(w.events())).not.toContain('private output')
  expect(JSON.stringify(w.events())).not.toContain('fixture-a')
  await ui.unmount()
})

test('an Arbiter prompt appears in Inbox while open and its interval is recorded when dismissed', async ($, on) => {
  const w = world(on)
  mock.clock(on, { now: Date.now() })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const started = Promise.withResolvers<void>(), answer = Promise.withResolvers<void>()
  let dispatched = false
  on('tool.call', async (_$, e) => {
    if (e.tool !== 'AskUserQuestion') { dispatched = true; return { result: 'ran' } }
    started.resolve()
    await answer.promise
    return { deny: 'fixture dismissed' }
  })
  const ui = await $.ui.mount(pane)
  const call = $.tool.call({ tool: 'Bash', tool_use_id: 'fixture-approval', command: 'git reset --hard' })
  try {
    await started.promise
    expect(await ui.find({ text: 'Arbiter approval', exact: false })).toBeDefined()
  } finally {
    answer.resolve()
  }
  expect((await call).deny).toBeDefined()
  expect(dispatched).toBe(false)
  expect(await ui.find({ text: 'Arbiter approval', exact: false })).toBeUndefined()
  expect(w.events().filter(event => event.kind === 'progress.wait')).toHaveLength(1)
  await ui.unmount()
})

for (const tier of ['prepend', 'append'] as const satisfies readonly PluginTier[]) {
  for (const composition of ['own row', 'wrap next'] as const) {
    test(`native prompt rows coexist with a ${tier} mod using ${composition}`, {
      plugins: composition === 'own row' ? [{
        name: 'compat-progress', tier,
        register(on) {
          on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
            if (e.props.hasSurvey) return next(e)
            const h = $.ui.resolve(e)
            return h.Text({ key: 'compat-progress-row', children: 'Other progress' })
          })
        },
      }] : [{
        name: 'compat-progress', tier,
        register(on) {
          on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
            if (e.props.hasSurvey) return next(e)
            const h = $.ui.resolve(e), below = await next(e)
            return h.Box({ flexDirection: 'column', children: [
              h.Text({ key: 'compat-progress-row', children: 'Other progress' }),
              ...(below ? [below] : []),
            ] })
          })
        },
      }],
    }, async ($, on) => {
      const w = world(on)
      mock.clock(on, { now: Date.now() })
      w.files.set(await config(), JSON.stringify({ rules: [{ id: 'user:fixture', action: 'file.write', target: 'private/**', effect: 'jail' }] }))
      on('tool.call', () => ({ result: 'fixture' }))
      on('ui.toast', () => ({ value: undefined }))
      await $.tool.call({ tool: 'Write', agentId: 'fixture-agent', tool_use_id: 'hold', file_path: '/fixture/private/file', content: 'fixture' })
      const ui = await $.ui.mount(pane)
      await ui.press({ key: 'refresh-rules' })
      await ui.unmount()
      for (const surface of ['desktop', 'terminal'] as const) {
        const joined = await $.ui.mount({ plugin: 'agent-arbiter', surface, component: 'AbovePrompt', props: band })
        const tree = JSON.stringify(await joined.drawn())
        expect(tree).toContain('band-toggle-jail')
        expect(tree).toContain('Other progress')
        expect(tree.indexOf('Other progress') < tree.indexOf('band-toggle-jail')).toBe(tier === 'prepend')
        await joined.unmount()
        const survey = await $.ui.mount({ plugin: 'agent-arbiter', surface, component: 'AbovePrompt',
          props: { ...band, hasSurvey: true } })
        expect(await survey.find({ key: 'band-toggle-jail' })).toBeUndefined()
        await survey.unmount()
      }
    })
  }
}
