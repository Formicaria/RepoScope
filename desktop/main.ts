import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { createApp } from '../server/app.js'
import { verifyLicence } from './license.js'
import { FEATURES, granted } from './features.js'
import { readSettings, writeSettings } from './settings.js'
import { appVersion } from './version.js'
import { PROBE_SOURCE, smokePassed, type SmokeReport } from './smoke.js'
import {
  clearStaged,
  compareVersions,
  digestUrlFor,
  installerFor,
  parseDigest,
  pendingUpdate,
  recordStaged,
  releaseFrom,
  verifyOrDelete,
  type GitHubReleaseJson,
  type Release,
  type UpdateMode,
} from './updates.js'

/**
 * The desktop shell.
 *
 * It hosts the same Express analyzer the web build uses, in this process, and points a
 * window at it. That is the whole trick: there is one analyzer, one set of routes and one
 * UI, so the desktop app cannot drift from the browser app.
 *
 * Two deliberate choices worth knowing:
 *
 * - The server binds **127.0.0.1 on an ephemeral port**. The web build listens on all
 *   interfaces because someone chose to run a server; an installed desktop app doing that
 *   would quietly expose a repository scanner to the local network.
 * - The renderer gets no Node access at all (`contextIsolation`, no `nodeIntegration`) and
 *   reaches the few things it needs through the narrow preload bridge below.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = 'Formicaria/RepoScope'
const LATEST_RELEASE = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases`

let window: BrowserWindow | undefined
/** Declining a `notify` prompt is remembered for this run only — see updates.ts. */
let declinedThisRun = false

const dataDir = () => app.getPath('userData')
const stagingDir = () => path.join(dataDir(), 'updates')

function licenceStatus() {
  return verifyLicence(readSettings(dataDir()).licenceKey)
}

/* ------------------------------------------------------------------ */
/* The analyzer, in-process                                            */
/* ------------------------------------------------------------------ */

async function startAnalyzer(): Promise<string> {
  process.env.NODE_ENV ??= 'production'
  const server = createApp().listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

/**
 * Scanning a URL shells out to `git` for a shallow clone. A desktop user has no terminal
 * output to read, so the absence of git is reported as a fact about what will work rather
 * than left to surface as a failed scan.
 */
function gitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn('git', ['--version'], { stdio: 'ignore' })
    probe.on('error', () => resolve(false))
    probe.on('close', (code) => resolve(code === 0))
  })
}

/* ------------------------------------------------------------------ */
/* Updates                                                            */
/* ------------------------------------------------------------------ */

async function fetchLatest(): Promise<Release | undefined> {
  const response = await fetch(LATEST_RELEASE, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': `RepoScopeDesktop/${appVersion()}`,
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) return undefined
  return releaseFrom((await response.json()) as GitHubReleaseJson)
}

async function text(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    return response.ok ? await response.text() : undefined
  } catch {
    return undefined
  }
}

export interface CheckOutcome {
  status: 'up-to-date' | 'available' | 'staged' | 'unavailable' | 'error'
  latest?: string
  current: string
  message: string
  releaseUrl?: string
}

/**
 * Download the installer and keep it only if it matches the checksum the release publishes.
 *
 * The digest is fetched *first*. A release with no `.sha256` sidecar is not installed at
 * all — there would be nothing to check the download against, and an updater that runs
 * unverified binaries is a worse problem than an out-of-date app.
 */
async function stage(release: Release): Promise<CheckOutcome> {
  const current = appVersion()
  const asset = installerFor(release, process.platform)
  if (!asset) {
    return {
      status: 'unavailable',
      current,
      latest: release.version,
      releaseUrl: release.url,
      message: `Version ${release.version} is available, but this release has no installer for ${process.platform}. Update from the release page.`,
    }
  }

  const digest = parseDigest(await text(digestUrlFor(asset, release) ?? ''))
  if (!digest) {
    return {
      status: 'unavailable',
      current,
      latest: release.version,
      releaseUrl: release.url,
      message: `Version ${release.version} is available, but it publishes no SHA-256 checksum, so the download could not be verified and was not kept. Update from the release page instead.`,
    }
  }

  const dir = stagingDir()
  await fsp.mkdir(dir, { recursive: true })
  const payload = path.join(dir, asset.name)
  try {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(600_000) })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    await fsp.writeFile(payload, Buffer.from(await response.arrayBuffer()))
  } catch (error) {
    await fsp.rm(payload, { force: true })
    return {
      status: 'error',
      current,
      latest: release.version,
      releaseUrl: release.url,
      message: `Version ${release.version} could not be downloaded (${(error as Error).message}).`,
    }
  }

  const verdict = await verifyOrDelete(payload, digest)
  if (!verdict.ok) {
    return {
      status: 'error',
      current,
      latest: release.version,
      releaseUrl: release.url,
      message: `Version ${release.version} was downloaded but rejected: ${verdict.message}.`,
    }
  }

  await recordStaged(dir, {
    version: release.version,
    asset: asset.name,
    sha256: digest,
    payloadPath: payload,
    stagedAt: new Date().toISOString(),
  })
  return {
    status: 'staged',
    current,
    latest: release.version,
    releaseUrl: release.url,
    message: `Version ${release.version} has been downloaded and its checksum verified. It installs the next time you start RepoScope — your scans and settings are kept.`,
  }
}

async function check(mode: UpdateMode, manual: boolean): Promise<CheckOutcome> {
  const current = appVersion()
  if (mode === 'off' && !manual) {
    return { status: 'up-to-date', current, message: 'Update checks are switched off.' }
  }

  let release: Release | undefined
  try {
    release = await fetchLatest()
  } catch (error) {
    return {
      status: 'error',
      current,
      message: `Could not reach GitHub to check for updates (${(error as Error).message}).`,
    }
  }
  if (!release) {
    return { status: 'error', current, message: 'GitHub returned no published release.' }
  }
  if (compareVersions(release.version, current) <= 0) {
    return {
      status: 'up-to-date',
      current,
      latest: release.version,
      message: `You are on ${current} — the latest release.`,
    }
  }

  if (mode === 'auto') return stage(release)

  if (!manual && declinedThisRun) {
    return {
      status: 'available',
      current,
      latest: release.version,
      releaseUrl: release.url,
      message: `Version ${release.version} is available.`,
    }
  }

  const answer = await dialog.showMessageBox(window!, {
    type: 'info',
    buttons: ['Download and install at next launch', 'Not now', 'View release notes'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update available',
    message: `RepoScope ${release.version} is available — you are on ${current}.`,
    detail:
      'The download is checked against the checksum published with the release, and installs the next time you start RepoScope. Your scans and settings are kept.',
  })
  if (answer.response === 2) {
    await shell.openExternal(release.url || RELEASES_PAGE)
    return {
      status: 'available',
      current,
      latest: release.version,
      releaseUrl: release.url,
      message: `Version ${release.version} is available.`,
    }
  }
  if (answer.response !== 0) {
    declinedThisRun = true
    return {
      status: 'available',
      current,
      latest: release.version,
      releaseUrl: release.url,
      message: `Version ${release.version} is available. You will be asked again next time RepoScope starts.`,
    }
  }
  return stage(release)
}

/**
 * Run a staged installer, if one is waiting and still passes its checksum.
 *
 * This is the only code in the desktop build that executes a downloaded file, and it
 * verifies immediately before doing so — `pendingUpdate` re-hashes the payload rather than
 * trusting the manifest written by an earlier run.
 */
async function applyStagedIfAny(): Promise<boolean> {
  const dir = stagingDir()
  const { staged, problem } = await pendingUpdate(dir, appVersion())
  if (problem) console.error(`[update] ${problem}`)
  if (!staged) return false

  await clearStaged(dir)
  const args = process.platform === 'win32' ? ['/S'] : []
  try {
    spawn(staged.payloadPath, args, { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch (error) {
    console.error(`[update] the staged installer could not be started: ${(error as Error).message}`)
    return false
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                             */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('licence:status', () => {
    const status = licenceStatus()
    return { status, granted: granted(status), features: FEATURES }
  })

  ipcMain.handle('licence:set', async (_event, key: unknown) => {
    const candidate = typeof key === 'string' ? key.trim() : ''
    const status = verifyLicence(candidate)
    // An unusable key is not written: a settings file holding a key the app rejects on
    // every launch is just a way to be told off repeatedly.
    if (status.state === 'invalid') return { status, saved: false }
    const settings = readSettings(dataDir())
    await writeSettings(dataDir(), { ...settings, licenceKey: candidate || undefined })
    return { status, saved: true, granted: granted(status) }
  })

  ipcMain.handle('update:mode', async (_event, mode: unknown) => {
    const settings = readSettings(dataDir())
    if (mode === 'off' || mode === 'notify' || mode === 'auto') {
      await writeSettings(dataDir(), { ...settings, updateMode: mode })
      return mode
    }
    return settings.updateMode
  })

  ipcMain.handle('update:check', () => check(readSettings(dataDir()).updateMode, true))

  ipcMain.handle('app:info', async () => ({
    version: appVersion(),
    platform: process.platform,
    updateMode: readSettings(dataDir()).updateMode,
    git: await gitAvailable(),
    dataDir: dataDir(),
  }))

  ipcMain.handle('app:open-releases', () => shell.openExternal(RELEASES_PAGE))
}

async function createWindow(url: string) {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0d10',
    title: 'RepoScope',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  window.once('ready-to-show', () => window?.show())
  // Links to GitHub, docs and share URLs belong in the user's browser, not in this window.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  await window.loadURL(url)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    window?.show()
    window?.focus()
  })

  app.whenReady().then(async () => {
    // Before anything else: if an update is waiting, hand over to it rather than starting
    // an app that is about to be replaced.
    if (await applyStagedIfAny()) {
      app.quit()
      return
    }

    registerIpc()
    const url = await startAnalyzer()
    await createWindow(url)

    // `--smoke` is a launch-and-report check: it exercises the window, the preload bridge
    // and the embedded analyzer, prints what it found, and exits. It is how CI (and a
    // headless container) can tell the shell actually works, rather than only that it
    // compiles.
    if (process.argv.includes('--smoke')) {
      const report = (await window!.webContents.executeJavaScript(PROBE_SOURCE)) as
        SmokeReport | undefined
      const shot = process.argv.find((a) => a.startsWith('--smoke-shot='))?.split('=')[1]
      if (shot && window)
        await fsp.writeFile(shot, (await window.webContents.capturePage()).toPNG())
      console.log('SMOKE ' + JSON.stringify(report))
      app.exit(smokePassed(report) ? 0 : 1)
      return
    }

    const mode = readSettings(dataDir()).updateMode
    if (mode !== 'off') {
      // A few seconds in, so a slow network never delays the window appearing.
      setTimeout(() => void check(mode, false).catch(() => {}), 4_000)
    }
  })

  app.on('window-all-closed', () => app.quit())
}
