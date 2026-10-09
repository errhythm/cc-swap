export type CcswapWindow = { pct: number; countdown: string | null }

export type CcswapScoped = { name: string; pct: number }

export type CcswapGates = {
  threshold: number
  threshold5h: number | null
  threshold7d: number | null
  windows: string
  models: string[]
  modelThresholds: Record<string, number>
}

export type CcswapAccount = {
  number: number
  email: string
  active: boolean
  status: string
  fiveHour: CcswapWindow | null
  sevenDay: CcswapWindow | null
  scoped: CcswapScoped[]
}

export type CcswapSnapshot = {
  active: number | null
  threshold: number
  gates: CcswapGates
  accounts: CcswapAccount[]
  error: string | null
}

// 'dark' / 'light' use ccswap's hex palette; 'theme' falls back to theme keys.
export type CcswapTone = 'dark' | 'light' | 'theme'

export type CcswapTab = 'claude' | 'codex' | 'history' | 'settings'

export type CcswapCodexAccount = { number: number; email: string; label: string; active: boolean }

export type CcswapCodexView = { accounts: CcswapCodexAccount[]; error: string | null }

export type CcswapSwitchEntry = { from: number; to: number; at: string }

export type CcswapHistoryView = { entries: CcswapSwitchEntry[]; error: string | null }

export type CcswapSettingsView = {
  threshold: number
  threshold5h: number | null
  threshold7d: number | null
  modelThresholds: string | null
  strategy: string
  windows: string
  statusline: boolean
  mod: boolean
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    ccswap: {
      snapshot: CcswapSnapshot | null
      tone: CcswapTone
      switching: boolean
      tab: CcswapTab
      codex: CcswapCodexView | null
      history: CcswapHistoryView | null
      settings: CcswapSettingsView | null
    }
  }
}
