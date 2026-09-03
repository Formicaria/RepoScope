import type { ScanResult } from '../../shared/types'

const LAST_SCAN_KEY = 'reposcope:last-scan'
const SETTINGS_KEY = 'reposcope:settings'

export interface Settings {
  direction: 'LR' | 'TB'
  showTests: boolean
  showConfig: boolean
  showDocs: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  direction: 'LR',
  showTests: true,
  showConfig: false,
  showDocs: false,
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw
      ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
      : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

export function saveLastScan(result: ScanResult) {
  try {
    localStorage.setItem(LAST_SCAN_KEY, JSON.stringify(result))
  } catch {
    // Quota exceeded for very large scans — the in-memory copy is still fine.
  }
}

export function loadLastScan(): ScanResult | undefined {
  try {
    const raw = localStorage.getItem(LAST_SCAN_KEY)
    return raw ? (JSON.parse(raw) as ScanResult) : undefined
  } catch {
    return undefined
  }
}
