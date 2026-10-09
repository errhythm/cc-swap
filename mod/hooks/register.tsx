import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  CcswapAccount,
  CcswapCodexView,
  CcswapGates,
  CcswapHistoryView,
  CcswapScoped,
  CcswapSettingsView,
  CcswapSnapshot,
  CcswapSwitchEntry,
  CcswapTab,
  CcswapTone,
  CcswapWindow,
} from '../types'

type $ = EngineInterface

const PANE = 'ccswap'
const POLL_MS = 60_000
const NOT_FOUND = 'ccswap not found on PATH. Install: uv tool install ccswap'
const KEYCHAIN_NOTE =
  "Claude Code may take ~30s to pick up the new login (macOS Keychain cache); restart if it doesn't."
const USAGE = [
  'Usage: /ccswap [best | next | <number|email> | pane | refresh]',
  '  (no args)   list accounts',
  '  best        switch to the account with the most headroom',
  '  next        rotate to the next account that is not at its limit',
  '  <n|email>   switch to that account',
  '  pane        open the accounts pane',
  '  refresh     re-read usage now',
].join('\n')

const snapshot = atom({ plugin: 'ccswap', key: 'snapshot' } as const, null)
const tone = atom({ plugin: 'ccswap', key: 'tone' } as const, 'theme')
const switching = atom({ plugin: 'ccswap', key: 'switching' } as const, false)
const tab = atom({ plugin: 'ccswap', key: 'tab' } as const, 'claude')
const codexView = atom({ plugin: 'ccswap', key: 'codex' } as const, null)
const historyView = atom({ plugin: 'ccswap', key: 'history' } as const, null)
const settingsView = atom({ plugin: 'ccswap', key: 'settings' } as const, null)

const PALETTES = {
  dark: { accent: '#d7875f', fg: '#e8e4de', muted: '#8a8a8a', ok: '#87af87', warn: '#d7af5f', crit: '#d75f5f', track: '#3a3a3a' },
  light: { accent: '#954c2a', fg: '#2b2723', muted: '#635d55', ok: '#3d6b3d', warn: '#795911', crit: '#ad3128', track: '#cec7ba' },
  theme: { accent: 'claude', fg: 'text', muted: 'inactive', ok: 'success', warn: 'warning', crit: 'error', track: 'subtle' },
} as const

// Letters, so the digits stay free to switch to that slot on the open tab.
const TABS: { id: CcswapTab; label: string; hotkey: string }[] = [
  { id: 'claude', label: 'Claude', hotkey: 'c' },
  { id: 'codex', label: 'Codex', hotkey: 'x' },
  { id: 'history', label: 'History', hotkey: 'h' },
  { id: 'settings', label: 'Settings', hotkey: 's' },
]

// What each Settings press moves to next.
const THRESHOLDS = [70, 80, 85, 90, 95]
const GATE_PCTS: (number | null)[] = [null, 70, 80, 85, 90, 95]
const FABLE_GATES = [null, 'Fable=70', 'Fable=80', 'Fable=85', 'Fable=90', 'Fable=95']
const STRATEGIES = ['best', 'consume-first']
const WINDOWS = ['both', '5h', '7d']

function defaultGates(threshold = 90): CcswapGates {
  return {
    threshold,
    threshold5h: null,
    threshold7d: null,
    windows: 'both',
    models: [],
    modelThresholds: {},
  }
}

type Raw = { ok: true; stdout: string; stderr: string; exitCode: number } | { ok: false; error: string }
type Ran = { ok: true; data: any } | { ok: false; error: string }

/** Runs `ccswap <args>`; never throws. */
async function runRaw($: $, args: string[]): Promise<Raw> {
  try {
    const out = await $.process.run(['ccswap', ...args], { timeoutMs: 20_000 })
    if (out.exitCode === 127) return { ok: false, error: NOT_FOUND }
    return { ok: true, stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: /timed? ?out|still running/i.test(msg) ? `ccswap timed out: ${msg}` : NOT_FOUND }
  }
}

/** Runs `ccswap <args>` expecting JSON on stdout; never throws. */
async function ccswap($: $, args: string[]): Promise<Ran> {
  const out = await runRaw($, args)
  if (!out.ok) return out
  let data: any
  try {
    data = JSON.parse(out.stdout)
  } catch {
    return { ok: false, error: out.stderr.trim() || `ccswap exited ${out.exitCode} without JSON` }
  }
  if (data?.error) return { ok: false, error: String(data.error.message ?? data.error) }
  return { ok: true, data }
}

function toWindow(w: any): CcswapWindow | null {
  return typeof w?.pct === 'number' ? { pct: Math.round(w.pct), countdown: w.countdown ?? null } : null
}

function toScoped(list: any): CcswapScoped[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((s: any) =>
    typeof s?.name === 'string' && typeof s?.pct === 'number'
      ? [{ name: s.name, pct: Math.round(s.pct) }]
      : [],
  )
}

function toSnapshot(data: any, gates: CcswapGates): CcswapSnapshot {
  const accounts: CcswapAccount[] = (Array.isArray(data?.accounts) ? data.accounts : []).map((a: any) => ({
    number: Number(a.number),
    email: String(a.email ?? ''),
    active: a.active === true,
    status: String(a.usageStatus ?? 'ok'),
    fiveHour: toWindow(a.usage?.fiveHour),
    sevenDay: toWindow(a.usage?.sevenDay),
    scoped: toScoped(a.usage?.scoped),
  }))
  const active = typeof data?.activeAccountNumber === 'number' ? data.activeAccountNumber : null
  return { active, threshold: gates.threshold, gates, accounts, error: null }
}

function parseModels(value: unknown): string[] {
  if (typeof value !== 'string') return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of value.split(',')) {
    const name = part.trim()
    const key = name.toLowerCase()
    if (name && !seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

function parseModelThresholds(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (typeof value !== 'string') return out
  for (const part of value.split(',')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim().toLowerCase()
    const pct = Number(part.slice(eq + 1).trim())
    if (name && Number.isFinite(pct) && !(name in out)) out[name] = pct
  }
  return out
}

/** null when this label is not a gate (windows filter, or an unwatched model). */
function gateThreshold(label: string, cfg: CcswapGates): number | null {
  const key = label.toLowerCase()
  if (key === '5h') return cfg.windows === '7d' ? null : (cfg.threshold5h ?? cfg.threshold)
  if (key === '7d') return cfg.windows === '5h' ? null : (cfg.threshold7d ?? cfg.threshold)
  if (key in cfg.modelThresholds) return cfg.modelThresholds[key] ?? null
  if (cfg.models.includes('all') || cfg.models.includes(key)) return cfg.threshold
  return null
}

/** The gate closest to its own wall: the one that binds. */
export function binding(a: CcswapAccount, cfg: CcswapGates = defaultGates()): { label: string; pct: number; threshold: number } | null {
  const hits: { label: string; pct: number; threshold: number }[] = []
  const push = (label: string, pct: number | undefined) => {
    if (pct === undefined) return
    const threshold = gateThreshold(label, cfg)
    if (threshold === null) return
    hits.push({ label, pct, threshold })
  }
  push('5h', a.fiveHour?.pct)
  push('7d', a.sevenDay?.pct)
  for (const scoped of a.scoped ?? []) push(scoped.name, scoped.pct)
  if (hits.length === 0) return null
  let worst = hits[0]!
  let margin = worst.threshold - worst.pct
  for (const hit of hits.slice(1)) {
    const next = hit.threshold - hit.pct
    if (next < margin || (next === margin && hit.pct > worst.pct)) {
      worst = hit
      margin = next
    }
  }
  return worst
}

function bestOther(snap: CcswapSnapshot): CcswapAccount | null {
  const cfg = snap.gates ?? defaultGates(snap.threshold)
  let best: CcswapAccount | null = null
  let bestMargin = -Infinity
  for (const a of snap.accounts) {
    const b = binding(a, cfg)
    if (a.active || a.status !== 'ok' || b === null) continue
    const margin = b.threshold - b.pct
    if (best === null || margin > bestMargin) {
      best = a
      bestMargin = margin
    }
  }
  return best
}

async function readConfig($: $, key: string): Promise<{ value: unknown } | null> {
  const cfg = await ccswap($, ['config', 'get', key, '--json'])
  if (!cfg.ok || cfg.data?.key !== key) return null
  return { value: cfg.data.value }
}

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

async function loadGates($: $): Promise<CcswapGates> {
  const [threshold, t5, t7, windows, model, modelThresholds] = await Promise.all([
    readConfig($, 'autoswitch.threshold'),
    readConfig($, 'autoswitch.threshold5h'),
    readConfig($, 'autoswitch.threshold7d'),
    readConfig($, 'autoswitch.windows'),
    readConfig($, 'autoswitch.model'),
    readConfig($, 'autoswitch.modelThresholds'),
  ])
  const win = windows?.value
  return {
    threshold: finiteOr(threshold?.value, 90),
    threshold5h: finiteOrNull(t5?.value),
    threshold7d: finiteOrNull(t7?.value),
    windows: win === '5h' || win === '7d' || win === 'both' ? win : 'both',
    models: parseModels(model?.value),
    modelThresholds: parseModelThresholds(modelThresholds?.value),
  }
}

// Polls overlap (timer, Refresh, post-switch, /ccswap). Each takes a number when it
// starts; a result older than the last one written is dropped, toast included.
let issued = 0
let applied = 0

async function poll($: $): Promise<CcswapSnapshot> {
  const gen = ++issued
  const [list, gates] = await Promise.all([
    ccswap($, ['list', '--provider', 'claude', '--json']),
    loadGates($),
  ])
  const threshold = gates.threshold
  let prev: CcswapSnapshot | null = null
  let snap: CcswapSnapshot | null = null
  // update() re-runs this on a version miss, so the staleness check and the
  // write it guards happen together.
  await update($, snapshot, p => {
    prev = p
    if (gen < applied) {
      snap = null
      return p
    }
    applied = gen
    snap = list.ok
      ? toSnapshot(list.data, gates)
      : { active: p?.active ?? null, threshold, gates, accounts: [], error: list.error }
    return snap
  })
  const was = prev as CcswapSnapshot | null
  const now = snap as CcswapSnapshot | null
  if (now === null) return was ?? { active: null, threshold, gates, accounts: [], error: null }

  if (was && was.active !== null && now.active !== null && was.active !== now.active) {
    const acct = now.accounts.find(a => a.number === now.active)
    const five = acct?.fiveHour ? ` (5h ${acct.fiveHour.pct}%)` : ''
    $.ui.toast(`ccswap: now on #${now.active} ${acct?.email ?? ''}${five}`)
  }
  return now
}

function pollQuietly($: $): void {
  poll($).catch(() => undefined)
}

async function loadCodex($: $): Promise<void> {
  const ran = await ccswap($, ['list', '--provider', 'codex', '--json'])
  const view: CcswapCodexView = ran.ok
    ? {
        accounts: (Array.isArray(ran.data?.accounts) ? ran.data.accounts : []).map((a: any) => ({
          number: Number(a.number),
          email: String(a.email ?? ''),
          label: String(a.label ?? a.authMode ?? ''),
          active: a.active === true,
        })),
        error: null,
      }
    : { accounts: [], error: ran.error }
  await update($, codexView, () => view)
}

const SWITCH_LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d).* - Switched from account (\d+) to (\d+)/

/** Claude Code switches in ccswap's log, newest first, as the menu bar lists them. */
export function parseHistory(text: string, limit = 15): CcswapSwitchEntry[] {
  const out: CcswapSwitchEntry[] = []
  for (const line of text.split('\n')) {
    const m = SWITCH_LINE.exec(line)
    if (m) out.push({ at: m[1]!, from: Number(m[2]), to: Number(m[3]) })
  }
  return out.slice(-limit).reverse()
}

async function loadHistory($: $): Promise<void> {
  // The log sits next to settings.json in ccswap's backup folder.
  const where = await runRaw($, ['config', 'path'])
  let view: CcswapHistoryView
  if (!where.ok || where.exitCode !== 0) {
    view = { entries: [], error: where.ok ? where.stderr.trim() || 'ccswap config path failed' : where.error }
  } else {
    const settingsPath = where.stdout.trim()
    const log = settingsPath.replace(/[^\\/]+$/, 'claude-swap.log')
    let text = ''
    try {
      text = String(await $.fs.read(log))
    } catch {
      // no log yet: nothing has been switched
    }
    view = { entries: parseHistory(text), error: null }
  }
  await update($, historyView, () => view)
}

async function loadSettings($: $): Promise<void> {
  const ran = await ccswap($, ['config', 'list', '--json'])
  const rows: any[] = ran.ok && Array.isArray(ran.data?.settings) ? ran.data.settings : []
  const value = (key: string) => rows.find(r => r?.key === key)?.value
  const rawThresholds = value('autoswitch.modelThresholds')
  const view: CcswapSettingsView = {
    threshold: Number(value('autoswitch.threshold') ?? 90),
    threshold5h: finiteOrNull(value('autoswitch.threshold5h')),
    threshold7d: finiteOrNull(value('autoswitch.threshold7d')),
    modelThresholds: typeof rawThresholds === 'string' && rawThresholds.trim() ? rawThresholds : null,
    strategy: String(value('autoswitch.strategy') ?? 'best'),
    windows: String(value('autoswitch.windows') ?? 'both'),
    statusline: value('claude.statusline') === true,
    mod: value('claude.mod') === true,
    error: ran.ok ? null : ran.error,
  }
  await update($, settingsView, () => view)
}

async function loadTab($: $, t: CcswapTab): Promise<void> {
  if (t === 'claude') await poll($)
  else if (t === 'codex') await loadCodex($)
  else if (t === 'history') await loadHistory($)
  else await loadSettings($)
}

function nextOf<T>(list: readonly T[], current: T): T {
  const i = list.indexOf(current)
  return list[(i + 1) % list.length]!
}

/** `ccswap config set` or `unset` (null), then re-reads the Settings tab. */
async function setSetting($: $, key: string, value: string | null): Promise<void> {
  const out = value === null
    ? await runRaw($, ['config', 'unset', key])
    : await runRaw($, ['config', 'set', key, value])
  if (!out.ok) $.ui.toast(`ccswap: ${out.error}`)
  else if (out.exitCode !== 0) $.ui.toast(`ccswap: ${(out.stderr.trim() || out.stdout.trim()).split('\n')[0]}`)
  await loadSettings($)
  if (key.startsWith('autoswitch.')) await poll($).catch(() => undefined)
}

async function readTone($: $): Promise<CcswapTone> {
  try {
    const row = (await $.config.list()).find(r => r.key === 'theme')
    const value = String(row?.value ?? '')
    if (value.startsWith('light')) return 'light'
    if (value.startsWith('dark')) return 'dark'
  } catch {
    // no config rows reachable: theme keys follow the person's theme anyway
  }
  return 'theme'
}

function cell(w: CcswapWindow | null): string {
  if (w === null) return '  -'
  return `${String(w.pct).padStart(3)}%${w.countdown ? ` (${w.countdown})` : ''}`
}

function listText(snap: CcswapSnapshot): string {
  if (snap.error) return snap.error
  if (snap.accounts.length === 0) return 'ccswap manages no Claude accounts yet. Run: ccswap add'
  const width = Math.max(...snap.accounts.map(a => a.email.length))
  const rows = snap.accounts.map(a => {
    const mark = a.active ? '●' : '○'
    const usage = a.status === 'ok' ? `5h ${cell(a.fiveHour)}   7d ${cell(a.sevenDay)}` : a.status
    return `${mark} #${a.number}  ${a.email.padEnd(width)}  ${usage}`
  })
  return [`accounts (● active, switch threshold ${snap.threshold}%)`, ...rows].join('\n')
}

const BUSY = 'a switch is already running'
// Module-level so the guard is synchronous; the `switching` atom mirrors it for drawing.
let switchInFlight = false

async function doSwitch(
  $: $,
  target: 'best' | 'next' | string,
  provider: 'claude' | 'codex' = 'claude',
): Promise<{ text: string; switched: boolean }> {
  if (switchInFlight) return { text: BUSY, switched: false }
  switchInFlight = true
  await update($, switching, () => true).catch(() => undefined)
  try {
    if (provider === 'codex') {
      const ran = await ccswap($, ['codex', 'switch', target, '--json'])
      if (!ran.ok) return { text: ran.error, switched: false }
      await loadCodex($).catch(() => undefined)
      const to = ran.data?.to
      return ran.data?.switched === true
        ? { text: `Switched Codex to #${to?.number} ${to?.email ?? ''}. Restart Codex to use it.`, switched: true }
        : { text: `Codex is already on #${to?.number ?? target}.`, switched: false }
    }
    const args =
      target === 'best'
        ? ['switch', '--strategy', 'best', '--json']
        : target === 'next'
          ? ['switch', '--strategy', 'next-available', '--json']
          : ['switch', target, '--json']
    const ran = await ccswap($, args)
    if (!ran.ok) return { text: ran.error, switched: false }
    await poll($).catch(() => undefined)
    const warnings: string[] = Array.isArray(ran.data.warnings) ? ran.data.warnings.map(String) : []
    const lines = [String(ran.data.message ?? (ran.data.switched ? 'Switched.' : 'No switch.')), ...warnings]
    if (ran.data.switched) lines.push(KEYCHAIN_NOTE)
    return { text: lines.join('\n'), switched: ran.data.switched === true }
  } finally {
    switchInFlight = false
    await update($, switching, () => false).catch(() => undefined)
  }
}

// Slots 1-9 double as hotkeys: the slot's own digit switches to it.
function slotKey(n: number): string | undefined {
  return n >= 1 && n <= 9 ? String(n) : undefined
}

function severity(pct: number, threshold: number): 'ok' | 'warn' | 'crit' {
  return pct >= Math.min(90, threshold) ? 'crit' : pct >= 70 ? 'warn' : 'ok'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // $.state outlives a reload, switchInFlight does not: clear a flag a reload left set.
    await update($, switching, () => false).catch(() => undefined)
    await $.command.register({
      name: 'ccswap',
      description: 'ccswap accounts: list, switch (best, next, a slot or email), pane, refresh',
      argumentHint: '[best|next|<n|email>|pane|refresh]',
      immediate: true,
    })
    void (async () => {
      const t = await readTone($)
      await update($, tone, () => t)
      await poll($)
    })().catch(() => undefined)
    $.clock.every(POLL_MS, () => pollQuietly($))

    return next(e)
  })

  on('command.run', { command: 'ccswap' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === '' || arg === 'refresh') {
      const snap = await poll($)
      return { text: arg === '' ? listText(snap) : snap.error ?? `Refreshed: ${snap.accounts.length} accounts, active #${snap.active ?? '?'}.` }
    }
    if (arg === 'pane') {
      void loadTab($, await read($, tab)).catch(() => undefined)
      // focus so the buttons get keys; Esc hands them back to the prompt and closes
      await $.ui.open({ id: PANE, title: 'ccswap', focus: true, closeOnEscape: true })
      return { text: 'pane opened.' }
    }
    if (arg === 'best' || arg === 'next' || /^\d+$/.test(arg) || arg.includes('@')) {
      return { text: (await doSwitch($, arg)).text }
    }
    return { text: USAGE }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const c = PALETTES[await read($, tone)]
    const busy = await read($, switching)
    const open = await read($, tab)

    const tabBar = (
      <Box flexDirection="row" columnGap={3}>
        {TABS.map(t => (
          <Button
            key={`tab-${t.id}`}
            label={t.label}
            hotkey={t.hotkey}
            plain
            {...(t.id === open ? {} : { dimColor: true })}
            onPress={async () => {
              await update($, tab, () => t.id)
              await loadTab($, t.id).catch(() => undefined)
            }}
          />
        ))}
      </Box>
    )
    const refresh = (
      <Button key="refresh" label="Refresh" hotkey="r" plain onPress={() => loadTab($, open).catch(() => undefined)} />
    )
    const page = (...body: JSX.Element[]) => (
      <Box flexDirection="column">
        {tabBar}
        <Text> </Text>
        {...body}
        {busy && <Text color={c.muted}>switching…</Text>}
        {refresh}
      </Box>
    )
    const switchButton = (n: number, provider: 'claude' | 'codex') => (
      <Button
        key={`${provider === 'codex' ? 'codex-' : ''}switch-${n}`}
        label={`Switch to #${n}`}
        plain
        {...(slotKey(n) ? { hotkey: slotKey(n) } : {})}
        onPress={async () => {
          const done = await doSwitch($, String(n), provider)
          // a real Claude switch already raised poll()'s "now on #N" toast
          if (!done.switched || provider === 'codex') $.ui.toast(`ccswap: ${done.text.split('\n')[0] ?? ''}`)
        }}
      />
    )

    if (open === 'codex') {
      const view = await read($, codexView)
      if (view === null) return page(<Text color={c.muted}>Reading Codex accounts…</Text>)
      if (view.error) return page(<Text color={c.crit}>{view.error}</Text>)
      if (view.accounts.length === 0) {
        return page(<Text color={c.muted}>No Codex accounts. Run `codex login`, then `ccswap codex add`.</Text>)
      }
      const width = Math.max(...view.accounts.map(a => a.email.length))
      return page(
        ...view.accounts.map(a => (
          <Box key={`codex-row-${a.number}`} flexDirection="row">
            <Text color={a.active ? c.accent : c.muted}>{a.active ? '● ' : '○ '}</Text>
            <Text color={a.active ? c.accent : c.fg} bold={a.active}>
              #{a.number} {a.email.padEnd(width)}{'  '}
            </Text>
            <Text color={c.muted}>{a.label}  </Text>
            {!a.active && !busy && switchButton(a.number, 'codex')}
          </Box>
        )),
        <Text color={c.muted}>Codex reads its login once at start: restart it after a switch.</Text>,
      )
    }

    if (open === 'history') {
      const view = await read($, historyView)
      if (view === null) return page(<Text color={c.muted}>Reading the switch log…</Text>)
      if (view.error) return page(<Text color={c.crit}>{view.error}</Text>)
      if (view.entries.length === 0) return page(<Text color={c.muted}>No switches logged yet.</Text>)
      const emails = new Map((await read($, snapshot))?.accounts.map(a => [a.number, a.email]) ?? [])
      return page(
        ...view.entries.map((s, i) => (
          <Text key={`switch-log-${i}`}>
            <Text color={c.muted}>{s.at}  </Text>
            <Text color={c.fg}>#{s.from}</Text>
            <Text color={c.muted}> → </Text>
            <Text color={c.accent}>#{s.to}</Text>
            <Text color={c.muted}>{emails.has(s.to) ? `  ${emails.get(s.to)}` : ''}</Text>
          </Text>
        )),
      )
    }

    if (open === 'settings') {
      const view = await read($, settingsView)
      if (view === null) return page(<Text color={c.muted}>Reading ccswap settings…</Text>)
      if (view.error) return page(<Text color={c.crit}>{view.error}</Text>)
      const row = (key: string, hotkey: string, label: string, value: string, onPress: () => Promise<void>) => (
        <Box key={`setting-row-${key}`} flexDirection="row" columnGap={2}>
          <Button key={`setting-${key}`} label={label} hotkey={hotkey} plain onPress={() => onPress().catch(() => undefined)} />
          <Text color={c.accent}>{value}</Text>
        </Box>
      )
      return page(
        row('threshold', 't', 'Auto-switch threshold', `${view.threshold}%`, () =>
          setSetting($, 'autoswitch.threshold', String(nextOf(THRESHOLDS, view.threshold) ?? 90)),
        ),
        row('threshold5h', '5', '5h gate', view.threshold5h === null ? 'inherit' : `${view.threshold5h}%`, () => {
          const next = nextOf(GATE_PCTS, view.threshold5h)
          return setSetting($, 'autoswitch.threshold5h', next === null ? null : String(next))
        }),
        row('threshold7d', '7', 'Weekly gate', view.threshold7d === null ? 'inherit' : `${view.threshold7d}%`, () => {
          const next = nextOf(GATE_PCTS, view.threshold7d)
          return setSetting($, 'autoswitch.threshold7d', next === null ? null : String(next))
        }),
        row('fable', 'f', 'Fable gate', view.modelThresholds ?? 'inherit', () =>
          setSetting($, 'autoswitch.modelThresholds', nextOf(FABLE_GATES, view.modelThresholds)),
        ),
        row('strategy', 'g', 'Auto-switch strategy', view.strategy, () =>
          setSetting($, 'autoswitch.strategy', nextOf(STRATEGIES, view.strategy)),
        ),
        row('windows', 'w', 'Windows that bind', view.windows, () =>
          setSetting($, 'autoswitch.windows', nextOf(WINDOWS, view.windows)),
        ),
        row('statusline', 'l', 'Claude statusline', view.statusline ? 'on' : 'off', () =>
          setSetting($, 'claude.statusline', view.statusline ? 'off' : 'on'),
        ),
        <Box key="setting-row-mod" flexDirection="row" columnGap={2}>
          <Text color={c.fg}>Claude Code mod</Text>
          <Text color={c.accent}>{view.mod ? 'on' : 'off'}</Text>
          <Text color={c.muted}>(turn off with: ccswap config set claude.mod off)</Text>
        </Box>,
        <Text color={c.muted}>Press a setting's key to move it to its next value.</Text>,
      )
    }

    const snap = await read($, snapshot)
    if (snap === null || snap.error) {
      return page(<Text color={snap?.error ? c.crit : c.muted}>{snap?.error ?? 'Reading ccswap…'}</Text>)
    }
    const bar = (w: CcswapWindow | null, label: string) => {
      if (w === null) return <Text color={c.muted}>{label} -   </Text>
      const filled = Math.max(0, Math.min(10, Math.round(w.pct / 10)))
      return (
        <Text>
          <Text color={c.muted}>{label} </Text>
          <Text color={c[severity(w.pct, snap.threshold)]}>{'━'.repeat(filled)}</Text>
          <Text color={c.track}>{'─'.repeat(10 - filled)}</Text>
          <Text color={c.fg}> {String(w.pct).padStart(3)}%  </Text>
        </Text>
      )
    }
    const width = Math.max(...snap.accounts.map(a => a.email.length))
    return page(
      ...snap.accounts.map(a => (
        <Box key={`row-${a.number}`} flexDirection="row">
          <Text color={a.active ? c.accent : c.muted}>{a.active ? '● ' : '○ '}</Text>
          <Text color={a.active ? c.accent : c.fg} bold={a.active}>
            #{a.number} {a.email.padEnd(width)}{'  '}
          </Text>
          {a.status === 'ok' ? (
            <Text>
              {bar(a.fiveHour, '5h')}
              {bar(a.sevenDay, '7d')}
            </Text>
          ) : (
            <Text color={c.warn}>{a.status}  </Text>
          )}
          {!a.active && !busy && switchButton(a.number, 'claude')}
        </Box>
      )),
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const snap = await read($, snapshot)
    const active = snap?.accounts.find(a => a.active)
    const bound = active ? binding(active, snap.gates ?? defaultGates(snap.threshold)) : null
    if (!snap || snap.error || !active || bound === null || bound.pct < bound.threshold) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const c = PALETTES[await read($, tone)]
    const busy = await read($, switching)
    const best = bestOther(snap)
    const bestPct = best ? binding(best, snap.gates ?? defaultGates(snap.threshold))?.pct : undefined
    return (
      <Box flexDirection="row">
        <Text>
          <Text color={c.accent} bold>ccswap</Text>
          <Text color={c.muted}> · </Text>
          <Text color={c[severity(bound.pct, bound.threshold)]}>
            {bound.label} {bound.pct}%
          </Text>
          <Text color={c.fg}> on #{active.number}</Text>
          <Text color={c.muted}> · </Text>
          <Text color={best ? c.ok : c.muted}>{best ? `best: #${best.number} (${bestPct}%)` : 'no account with more headroom'}</Text>
          <Text> </Text>
        </Text>
        {busy && <Text color={c.muted}>switching…</Text>}
        {best && !busy && (
          <Button
            key="switch-best"
            label={`Switch to #${best.number}`}
            plain
            // a digit hotkey on the band also fires from an empty prompt
            {...(slotKey(best.number) ? { hotkey: slotKey(best.number) } : {})}
            onPress={async () => {
              const done = await doSwitch($, 'best')
              if (!done.switched) $.ui.toast(`ccswap: ${done.text.split('\n')[0] ?? ''}`)
            }}
          />
        )}
      </Box>
    )
  })
}
