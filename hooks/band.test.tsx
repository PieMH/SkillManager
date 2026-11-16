// The band's own check: run with `claude plugin test .` (the Node self-check in tests/ covers the scripts).
import { expect, test } from 'claude-code/testing'

const DAY = 24 * 3600 * 1000
const NOW = Date.parse('2026-11-16T12:00:00Z')
const SURFACES = ['terminal', 'desktop'] as const

const band = (surface: (typeof SURFACES)[number]) => ({
  plugin: 'skillset',
  surface,
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 7 }, view: {} },
} as const)

// The engine beneath the band: a project folder, a config dir and the state file in it.
type World = { tiered: boolean; state?: object; ran: string[] }
// The engine normalises a path before a hook sees it, so match on its end.
const ends = (path: string, tail: string) => path.replace(/\\/g, '/').toLowerCase().endsWith(tail)
type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1] // the body overload, not the options one
function engine(on: On, w: World) {
  on('session.cwd', () => ({ value: 'C:\\Projects\\demo' }))
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? 'C:\\cfg' : undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.exists', (_, e) => ({ value: w.tiered && ends(e.path, 'demo/skillset.md') }))
  on('fs.read', (_, e) => {
    if (w.state && ends(e.path, 'cfg/skillset/state.json')) return { value: JSON.stringify(w.state) }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('command.run', (_, e) => {
    w.ran.push(e.command)
    return { text: '' }
  })
}

test('a due pass is marked, the pending count leaves out skipped versions, and the button opens the board', async ($, on) => {
  const w: World = {
    tiered: true,
    ran: [],
    state: {
      passAt: new Date(NOW - 9 * DAY).toISOString(),
      updates: [{ id: 'plugin:a@m', latest: '2.0.0' }, { id: 'skill:b', latest: 'abc1234' }],
      skipped: { 'skill:b': { latest: 'abc1234' } },
    },
  }
  engine(on, w)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect((await ui.find({ type: 'Text', text: /^1 update$/ }))?.text).toBe('1 update')
    expect((await ui.find({ type: 'Text', text: /update pass due/ }))?.text).toBe('update pass due')
    expect((await ui.find({ type: 'Text', text: /days ago/ }))?.text).toBe('last 9 days ago')
    await ui.press({ key: 'board' })
    await ui.unmount()
  }
  expect(w.ran).toEqual(['skillset:skillset-status', 'skillset:skillset-status'])
})

test('a recent pass and nothing pending leave only the button', async ($, on) => {
  const w: World = { tiered: true, ran: [], state: { passAt: new Date(NOW - 2 * DAY).toISOString(), updates: [] } }
  engine(on, w)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ type: 'Text', text: /update pass due|update/ })).toBe(undefined)
    expect(await ui.find({ type: 'Button', key: 'board' })).not.toBe(undefined)
    await ui.unmount()
  }
})

test('no state file reads as a pass never run', async ($, on) => {
  engine(on, { tiered: true, ran: [] })
  const ui = await $.ui.mount(band('terminal'))
  expect((await ui.find({ type: 'Text', text: /never run/ }))?.text).toBe('never run')
  await ui.unmount()
})

test('an untiered project offers set-up, and a dismissed one gets no row', async ($, on) => {
  const w: World = { tiered: false, ran: [], state: {} }
  engine(on, w)
  let ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'configure' })
  expect(w.ran).toEqual(['skillset:skillset-configure'])
  await ui.unmount()

  w.state = { dismissed: ['c:/projects/DEMO/'] } // the hook writes forward slashes; Windows paths ignore case
  ui = await $.ui.mount(band('desktop'))
  expect(await ui.find({ type: 'Button', key: 'configure' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /skillset/ })).toBe(undefined)
  await ui.unmount()
})
