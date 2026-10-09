import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { nextFableThresholds, parseHistory } from '../hooks/register.js'

type Acct = { number: number; email: string; five: number; seven: number }

function listJson(active: number, accounts: Acct[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    activeAccountNumber: active,
    accounts: accounts.map(a => ({
      number: a.number,
      email: a.email,
      active: a.number === active,
      usageStatus: 'ok',
      usage: {
        fiveHour: { pct: a.five, countdown: '2h 19m' },
        sevenDay: { pct: a.seven, countdown: '3d 1h' },
      },
    })),
  })
}

const TWO: Acct[] = [
  { number: 1, email: 'one@example.com', five: 0, seven: 1 },
  { number: 2, email: 'two@example.com', five: 22, seven: 69 },
]

/** Stubs `ccswap`: list answers from `state()`, switch records its argv. */
function fakeCcswap(on: On, state: () => { active: number; accounts: Acct[] }, calls: string[][] = []) {
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    expect(e.init?.timeoutMs).toBeDefined()
    if (argv[1] === 'list') {
      const s = state()
      return { value: { exitCode: 0, stdout: listJson(s.active, s.accounts), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv[1] === 'config') {
      return { value: { exitCode: 0, stdout: '{"schemaVersion":1,"key":"autoswitch.threshold","value":90.0,"isSet":false}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const stdout = JSON.stringify({
      schemaVersion: 1,
      switched: true,
      from: { number: 2, email: 'two@example.com' },
      to: { number: 1, email: 'one@example.com' },
      message: 'Switched to Account-1 (one@example.com)',
      warnings: [],
    })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

function collectToasts(on: On): string[] {
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return toasts
}

/** `/ccswap <args>` as typed at the composer. */
function slash($: Engine, args: string) {
  return $.command.run({
    command: 'ccswap',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
}

const BAND = {
  plugin: 'ccswap',
  component: 'AbovePrompt',
  viewport: { columns: 120, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 110, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

const PANE = {
  plugin: 'ccswap',
  component: 'Pane',
  requestId: 'ccswap',
  viewport: { columns: 140, rows: 30 },
  props: { title: 'ccswap', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('/ccswap lists accounts from ccswap list --json', async ($, on) => {
  const calls: string[][] = []
  fakeCcswap(on, () => ({ active: 2, accounts: TWO }), calls)
  const out = await slash($, '')
  expect(calls[0]).toEqual(['ccswap', 'list', '--provider', 'claude', '--json'])
  expect(out.text).toContain('switch threshold 90%')
  expect(out.text).toMatch(/● #2 {2}two@example\.com\s+5h {2}22% \(2h 19m\) {3}7d {2}69% \(3d 1h\)/)
  expect(out.text).toMatch(/○ #1 {2}one@example\.com/)
})

test('/ccswap best and /ccswap 2 run the right switch argv', async ($, on) => {
  const calls: string[][] = []
  fakeCcswap(on, () => ({ active: 2, accounts: TWO }), calls)
  collectToasts(on)
  const best = await slash($, 'best')
  expect(calls[0]).toEqual(['ccswap', 'switch', '--strategy', 'best', '--json'])
  expect(best.text).toContain('Switched to Account-1')
  expect(best.text).toContain('~30s')
  calls.length = 0
  await slash($, '2')
  expect(calls[0]).toEqual(['ccswap', 'switch', '2', '--json'])
  calls.length = 0
  await slash($, 'next')
  expect(calls[0]).toEqual(['ccswap', 'switch', '--strategy', 'next-available', '--json'])
  const usage = await slash($, 'bogus')
  expect(usage.text).toContain('Usage: /ccswap')
})

test('ccswap missing from PATH gives the install hint, no toast', async ($, on) => {
  on('process.run', () => ({ deny: 'spawn ccswap ENOENT' }))
  const toasts = collectToasts(on)
  const out = await slash($, '')
  expect(out.text).toBe('ccswap not found on PATH. Install: uv tool install ccswap')
  const sw = await slash($, 'best')
  expect(sw.text).toBe('ccswap not found on PATH. Install: uv tool install ccswap')
  expect(toasts).toEqual([])
})

test('toast fires only when the active account changes', async ($, on) => {
  let active = 2
  fakeCcswap(on, () => ({ active, accounts: TWO }))
  const toasts = collectToasts(on)
  await slash($, 'refresh')
  await slash($, 'refresh')
  expect(toasts).toEqual([])
  active = 1
  await slash($, 'refresh')
  await slash($, 'refresh')
  expect(toasts).toEqual(['ccswap: now on #1 one@example.com (5h 0%)'])
})

test('the 60s poll timer picks up a switch made elsewhere', async ($, on) => {
  const clock = mock.clock(on)
  let active = 2
  fakeCcswap(on, () => ({ active, accounts: TWO }))
  const toasts = collectToasts(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'ccswap' } }))
  on('config.list', () => ({ value: [] }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()
  active = 1
  await clock.advance(60_000)
  expect(toasts).toEqual(['ccswap: now on #1 one@example.com (5h 0%)'])
})

test('band shows only at or above the threshold', async ($, on) => {
  let accounts = TWO
  const calls: string[][] = []
  fakeCcswap(on, () => ({ active: 2, accounts }), calls)
  collectToasts(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))

  await slash($, 'refresh')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
    await ui.unmount()
  }

  accounts = [TWO[0]!, { number: 2, email: 'two@example.com', five: 93, seven: 69 }]
  await slash($, 'refresh')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '5h 93%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'best: #1 (1%)' })).toBeDefined()
    calls.length = 0
    await ui.press({ key: 'switch-best' })
    expect(calls[0]).toEqual(['ccswap', 'switch', '--strategy', 'best', '--json'])
    await ui.unmount()
  }
})

test('pane draws a row per account on terminal and desktop', async ($, on) => {
  const calls: string[][] = []
  fakeCcswap(on, () => ({ active: 2, accounts: TWO }), calls)
  collectToasts(on)
  await slash($, 'refresh')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /#1 one@example\.com/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#2 two@example\.com/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 69%  ' })).toBeDefined()
    expect(await ui.find({ key: 'switch-1' })).toBeDefined()
    expect(await ui.find({ key: 'switch-2' })).toBeUndefined()
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    calls.length = 0
    await ui.press({ key: 'switch-1' })
    expect(calls[0]).toEqual(['ccswap', 'switch', '1', '--json'])
    await ui.unmount()
  }
})

test('pane shows the error line when ccswap is missing', async ($, on) => {
  on('process.run', () => ({ deny: 'spawn ccswap ENOENT' }))
  await slash($, 'refresh')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /not found on PATH/ })).toBeDefined()
  await ui.unmount()
})

function ran(stdout: string) {
  return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}
const THRESHOLD = '{"schemaVersion":1,"key":"autoswitch.threshold","value":90.0,"isSet":false}'

test('a stale poll that resolves late is dropped, with no toast', async ($, on) => {
  const clock = mock.clock(on)
  let lists = 0
  on('process.run', async ($, e) => {
    if (e.argv[1] === 'config') return ran(THRESHOLD)
    lists += 1
    // call 2 is a timer poll that read #1 just before the switch and answers late
    if (lists === 2) {
      await clock.sleep(1000)
      return ran(listJson(1, TWO))
    }
    return ran(listJson(lists === 1 ? 1 : 2, TWO))
  })
  const toasts = collectToasts(on)

  await slash($, 'refresh') // active #1, first poll: no toast
  const late = slash($, 'refresh') // stale: will say #1
  await clock.settle()
  await slash($, 'refresh') // fresh: #2
  expect(toasts).toEqual(['ccswap: now on #2 two@example.com (5h 22%)'])
  await clock.advance(1000)
  await late
  await slash($, 'refresh') // still #2
  expect(toasts).toEqual(['ccswap: now on #2 two@example.com (5h 22%)'])
  expect((await slash($, '')).text).toMatch(/● #2 {2}two@example\.com/)
})

test('a second switch while one is pending spawns no second process', async ($, on) => {
  const clock = mock.clock(on)
  const switches: string[][] = []
  on('process.run', async ($, e) => {
    if (e.argv[1] === 'config') return ran(THRESHOLD)
    if (e.argv[1] === 'list') return ran(listJson(2, TWO))
    switches.push([...e.argv])
    await clock.sleep(1000)
    return ran(JSON.stringify({ schemaVersion: 1, switched: false, message: 'Already on Account-2', warnings: [] }))
  })
  collectToasts(on)
  await slash($, 'refresh')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const first = ui.press({ key: 'switch-1' })
  await clock.settle()
  expect(switches).toHaveLength(1)
  // the buttons are hidden while it runs
  expect(await ui.find({ key: 'switch-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'switching…' })).toBeDefined()
  // a typed switch is refused too
  expect((await slash($, 'best')).text).toBe('a switch is already running')
  expect(switches).toHaveLength(1)

  await clock.advance(1000)
  await first
  expect(await ui.find({ key: 'switch-1' })).toBeDefined()
  await ui.unmount()
})

const LOG = [
  '2026-10-08 12:51:21,478 - INFO - Switched from account 1 to 2',
  '2026-10-08 12:51:30,000 - INFO - Something else',
  '2026-10-08 12:51:42,415 - INFO - Switched from account 2 to 1',
].join('\n')

const SETTINGS = JSON.stringify({
  schemaVersion: 1,
  settings: [
    { key: 'autoswitch.threshold', value: 90.0, isSet: false },
    { key: 'autoswitch.strategy', value: 'best', isSet: false },
    { key: 'autoswitch.windows', value: 'both', isSet: false },
    { key: 'claude.statusline', value: true, isSet: true },
    { key: 'claude.mod', value: true, isSet: true },
  ],
})

/** Stubs every ccswap call the tabs make, and the switch log read. */
function fakeTabs(on: On, codex: unknown[], calls: string[][]) {
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const sub = argv.slice(1).join(' ')
    if (sub === 'list --provider claude --json') return ran(listJson(2, TWO))
    if (sub === 'list --provider codex --json') return ran(JSON.stringify({ provider: 'codex', activeAccountNumber: 1, accounts: codex }))
    if (sub === 'config get autoswitch.threshold --json') return ran(THRESHOLD)
    if (sub === 'config path') return ran('/backup/settings.json\n')
    if (sub === 'config list --json') return ran(SETTINGS)
    if (argv[1] === 'config' && argv[2] === 'set') return ran(`${argv[3]} = ${argv[4]}\n`)
    if (argv[1] === 'codex' && argv[2] === 'switch') {
      return ran(JSON.stringify({ switched: true, from: { number: 1 }, to: { number: Number(argv[3]), email: 'cx2@example.com' } }))
    }
    return ran('{}')
  })
  on('fs.read', ($, e) => (e.path === '/backup/claude-swap.log' ? { value: LOG } : { deny: 'ENOENT' }))
}

const CODEX = [
  { number: 1, email: 'cx1@example.com', label: 'Codex Team', authMode: 'chatgpt', active: true },
  { number: 2, email: 'cx2@example.com', label: 'Codex Plus', authMode: 'chatgpt', active: false },
]

test('tab bar switches the pane between all four tabs on terminal and desktop', async ($, on) => {
  const calls: string[][] = []
  fakeTabs(on, CODEX, calls)
  const toasts = collectToasts(on)
  await slash($, 'refresh')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    for (const id of ['tab-claude', 'tab-codex', 'tab-history', 'tab-settings']) {
      expect(await ui.find({ key: id })).toBeDefined()
    }
    expect(await ui.find({ key: 'switch-1' })).toBeDefined()

    calls.length = 0
    await ui.press({ key: 'tab-codex' })
    expect(calls).toContainEqual(['ccswap', 'list', '--provider', 'codex', '--json'])
    expect(await ui.find({ type: 'Text', text: /#2 cx2@example\.com/ })).toBeDefined()
    expect(await ui.find({ key: 'codex-switch-1' })).toBeUndefined()
    calls.length = 0
    await ui.press({ key: 'codex-switch-2' })
    expect(calls[0]).toEqual(['ccswap', 'codex', 'switch', '2', '--json'])
    expect(toasts.at(-1)).toBe('ccswap: Switched Codex to #2 cx2@example.com. Restart Codex to use it.')

    await ui.press({ key: 'tab-history' })
    expect(await ui.find({ type: 'Text', text: '2026-10-08 12:51  ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  one@example.com' })).toBeDefined()

    await ui.press({ key: 'tab-settings' })
    expect(await ui.find({ type: 'Text', text: '90%' })).toBeDefined()
    calls.length = 0
    await ui.press({ key: 'setting-threshold' })
    expect(calls[0]).toEqual(['ccswap', 'config', 'set', 'autoswitch.threshold', '95'])
    calls.length = 0
    await ui.press({ key: 'setting-statusline' })
    expect(calls[0]).toEqual(['ccswap', 'config', 'set', 'claude.statusline', 'off'])
    calls.length = 0
    await ui.press({ key: 'setting-windows' })
    expect(calls[0]).toEqual(['ccswap', 'config', 'set', 'autoswitch.windows', '5h'])

    await ui.press({ key: 'tab-claude' })
    expect(await ui.find({ key: 'switch-1' })).toBeDefined()
    await ui.unmount()
  }
})

test('codex tab says how to add an account when there are none', async ($, on) => {
  fakeTabs(on, [], [])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-codex' })
  expect(await ui.find({ type: 'Text', text: /No Codex accounts/ })).toBeDefined()
  await ui.press({ key: 'tab-claude' })
  await ui.unmount()
})

test('history lists only switch lines, newest first', async () => {
  expect(parseHistory(LOG)).toEqual([
    { at: '2026-10-08 12:51', from: 2, to: 1 },
    { at: '2026-10-08 12:51', from: 1, to: 2 },
  ])
  expect(parseHistory('')).toEqual([])
})

test('the Fable gate keeps other model thresholds', async () => {
  expect(nextFableThresholds('Fable=70,Opus=60')).toBe('Opus=60,Fable=80')
  expect(nextFableThresholds('Opus=60')).toBe('Opus=60,Fable=70')
  expect(nextFableThresholds('Fable=40,Opus=60')).toBe('Opus=60,Fable=70')
  expect(nextFableThresholds('Fable=95')).toBe(null)
  expect(nextFableThresholds('Fable=95,Opus=60')).toBe('Opus=60')
  expect(nextFableThresholds(null)).toBe('Fable=70')
})
