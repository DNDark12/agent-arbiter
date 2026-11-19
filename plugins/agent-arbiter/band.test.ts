import { test, expect } from 'claude-code/testing'
import { world } from './testing/world'
import { digest } from './hooks/ledger.js'

const preferences = async () => '/fixture-home/.claude/plugins/data/agent-arbiter/v1/projects/' + await digest('/fixture') + '/preferences.json'
const BAND = { plugin: 'agent-arbiter', component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, bodyColumns: 90, maxRows: 4, scroll: { offset: 0, bodyRows: 4 }, view: {} } } as const
const PANE = { plugin: 'agent-arbiter', component: 'Pane', requestId: 'arbiter-rules',
  props: { title: 'Agent Arbiter', isFocused: true, bodyColumns: 80, placement: 'inline' } } as const

test('a new detention shows in the band once, flashes, and Open goes to it without a chat line', async ($, on) => {
  const w = world(on)
  w.files.set(await preferences(), JSON.stringify({ rules: [{ id: 'user:secret', action: 'file.write', target: 'secrets/**', effect: 'jail' }] }))
  const toasts: string[] = [], opened: string[] = [], ran: string[] = []
  on('tool.call', () => ({ result: 'ran' }))
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.open', (_$, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  // Beneath the plugins: a command another plugin's hook ran would land here.
  on('command.run', (_$, e) => { ran.push(e.command); return { text: '' } })
  const settle = async (done: () => boolean) => { for (let n = 0; n < 400 && !done(); n++) await new Promise(resolve => setTimeout(resolve, 2)) }

  // Nothing waits yet: the band draws nothing of its own, and counts in the background.
  let band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ key: 'band-open' })).toBeUndefined()
  await band.unmount()
  for (let n = 0; n < 20; n++) await new Promise(resolve => setTimeout(resolve, 2))

  expect((await $.tool.call({ tool: 'Write', agentId: 'j-child', tool_use_id: 'jw', file_path: '/fixture/secrets/key', content: 'x' })).deny).toContain('detained')
  await settle(() => toasts.length > 0)
  expect(toasts.at(-1)).toContain('1 agent(s) detained')

  band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.findAll({ type: 'Svg' })).map(graphic => graphic.props.alt)).toContain('1 agent(s) detained')
  const flashing = (await band.findAll({ type: 'Svg' })).filter(graphic => graphic.props.isInteractive)
  expect(flashing.map(graphic => graphic.props.alt)).toEqual(['1 agent(s) detained'])
  expect(String(flashing[0]?.props.source)).toMatch(/prefers-reduced-motion: no-preference/)
  // The small band shows the one bar that matters most; pressing the bar lists every bar, and again folds it back.
  expect(await band.find({ key: 'band-expand' })).toBeUndefined()
  await band.press({ key: 'band-toggle-jail' })
  expect(await band.find({ key: 'band-toggle-jail' })).toBeDefined()
  await band.press({ key: 'band-toggle-jail' })
  expect(await band.find({ key: 'band-toggle-jail' })).toBeDefined()
  await band.press({ key: 'band-open' })
  await settle(() => opened.length > 0)
  expect(opened).toEqual(['arbiter-rules'])
  expect(ran).toEqual([])
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ key: 'violation-filter' }))?.props.value).toBe('active')
  await pane.unmount()

  // Closed by the person, the band stays closed until something new waits.
  band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: '⛓' }))?.text).toBe('⛓')
  await band.press({ key: 'band-hide' })
  expect(await band.find({ key: 'band-open' })).toBeUndefined()
  await band.unmount()
})

test('the rule that stopped a call, and what came of it, shows under its row', async ($, on) => {
  const w = world(on)
  w.files.set(await preferences(), JSON.stringify({ rules: [{ id: 'user:secret', action: 'file.write', target: 'secrets/**', effect: 'deny' }] }))
  on('tool.call', () => ({ result: 'ran' }))
  await $.tool.call({ tool: 'Write', tool_use_id: 'denied-call', file_path: '/fixture/secrets/key', content: 'x' })
  await $.tool.call({ tool: 'Write', tool_use_id: 'plain-call', file_path: '/fixture/src/a.js', content: 'x' })
  const row = (id: string) => ({ plugin: 'agent-arbiter', surface: 'desktop', component: 'ToolUse',
    props: { tool_use_id: id, tool: 'Write', input: {}, isRunning: false, isErrored: true, isInterrupted: false } } as const)
  let ui = await $.ui.mount(row('denied-call'))
  expect((await ui.find({ type: 'Text', text: /⚖/ }))?.text).toBe('⚖ custom rule · denied by rule')
  await ui.unmount()
  ui = await $.ui.mount(row('plain-call'))
  expect(await ui.find({ type: 'Text', text: /⚖/ })).toBeUndefined()
  await ui.unmount()
})

test('the right-click menu opens the panel in place', async ($, on) => {
  world(on)
  const opened: string[] = []
  on('ui.open', (_$, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  const menu = await $.ui.mount({ plugin: 'agent-arbiter', component: 'ContextMenu', surface: 'desktop', props: {} })
  await menu.press({ key: 'arbiter-open' })
  for (let n = 0; n < 50 && !opened.length; n++) await new Promise(resolve => setTimeout(resolve, 1))
  expect(opened).toEqual(['arbiter-rules'])
  await menu.unmount()
})

test('the pane opens on an overview: a state pill, figures under small labels, and a chip for each kind that waits', async ($, on) => {
  const w = world(on)
  w.files.set(await preferences(), JSON.stringify({ rules: [{ id: 'user:secret', action: 'file.write', target: 'secrets/**', effect: 'jail' }] }))
  on('tool.call', () => ({ result: 'ran' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  let pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (let n = 0; n < 20; n++) await new Promise(resolve => setTimeout(resolve, 2))
  await pane.unmount()
  pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: 'WAITING ON YOU' }))?.text).toBe('WAITING ON YOU')
  expect((await pane.find({ type: 'Text', text: 'Nothing waits on you.' }))?.text).toBe('Nothing waits on you.')
  await pane.unmount()

  await $.tool.call({ tool: 'Write', agentId: 'j-child', tool_use_id: 'jw', file_path: '/fixture/secrets/key', content: 'x' })
  for (let n = 0; n < 40; n++) await new Promise(resolve => setTimeout(resolve, 2))
  pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.findAll({ type: 'Svg' })).map(graphic => graphic.props.alt)).toContain('1 waiting on you')
  expect(await pane.find({ type: 'Text', text: 'Nothing waits on you.' })).toBeUndefined()
  await pane.press({ key: 'overview-jail' })
  expect((await pane.find({ key: 'violation-filter' }))?.props.value).toBe('active')
  await pane.unmount()
})
