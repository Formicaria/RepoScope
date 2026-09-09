/**
 * The desktop bridge, as the renderer sees it.
 *
 * `window.reposcope` exists only in the Electron build (see `desktop/preload.cts`). The web
 * build has no bridge at all, and every consumer here goes through `desktop()`, which
 * returns undefined in a browser — so the desktop-only UI is absent rather than broken.
 */

export type UpdateMode = 'off' | 'notify' | 'auto'

export interface LicencePayload {
  holder: string
  tier: string
  issued: string
  expires?: string
  note?: string
}

export type LicenceStatus =
  | { state: 'unlicensed' }
  | { state: 'licensed'; payload: LicencePayload; expiresInDays?: number }
  | { state: 'expired'; payload: LicencePayload }
  | { state: 'invalid'; reason: string }

export interface FeatureInfo {
  tiers: string[]
  title: string
  blurb: string
}

export interface AppInfo {
  version: string
  platform: string
  updateMode: UpdateMode
  /** Whether `git` is on the PATH. Without it, URL scanning cannot clone. */
  git: boolean
  dataDir: string
}

export interface CheckOutcome {
  status: 'up-to-date' | 'available' | 'staged' | 'unavailable' | 'error'
  latest?: string
  current: string
  message: string
  releaseUrl?: string
}

export interface DesktopBridge {
  desktop: true
  info(): Promise<AppInfo>
  licence: {
    status(): Promise<{
      status: LicenceStatus
      granted: string[]
      features: Record<string, FeatureInfo>
    }>
    set(key: string): Promise<{ status: LicenceStatus; saved: boolean; granted?: string[] }>
  }
  updates: {
    setMode(mode: UpdateMode): Promise<UpdateMode>
    check(): Promise<CheckOutcome>
    openReleases(): Promise<void>
  }
}

declare global {
  interface Window {
    reposcope?: DesktopBridge
  }
}

export function desktop(): DesktopBridge | undefined {
  return typeof window !== 'undefined' ? window.reposcope : undefined
}

export function isDesktop(): boolean {
  return !!desktop()
}
