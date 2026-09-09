import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Update checking against GitHub releases, following the shape Anthill uses.
 *
 * Three properties are the point, and they are the ones auto-updaters usually get wrong:
 *
 * 1. **The checksum is fetched before the payload.** A download with nothing to check it
 *    against is a download this updater will not keep, and finding that out costs one small
 *    request instead of a hundred megabytes.
 * 2. **The payload is re-verified at launch**, not only after downloading. Between the two,
 *    the installer sat on a disk that anything with write access could reach.
 * 3. **Nothing here executes anything.** Staging writes a file and a manifest; the only code
 *    that runs an installer is the apply step, and it verifies again first.
 *
 * Three modes, stored in settings: `off` never checks, `notify` asks before installing,
 * `auto` stages silently and applies at the next launch. Declining a `notify` prompt is
 * remembered for the session only — a second, invisible "stop asking" would leave someone
 * with an app that had quietly stopped updating and no setting saying so.
 */

export type UpdateMode = 'off' | 'notify' | 'auto'

export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

export interface Release {
  version: string
  tag: string
  url: string
  notes: string
  assets: ReleaseAsset[]
}

export interface StagedUpdate {
  version: string
  asset: string
  sha256: string
  payloadPath: string
  stagedAt: string
}

export const MANIFEST_NAME = 'staged-update.json'

/* ------------------------------------------------------------------ */
/* Versions                                                            */
/* ------------------------------------------------------------------ */

/**
 * Compare two dotted numeric versions, ignoring a leading `v` and any pre-release suffix.
 * Returns >0 when `a` is newer. Segments missing on one side count as zero, so `1.2` and
 * `1.2.0` are equal rather than one being mysteriously newer.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

/* ------------------------------------------------------------------ */
/* Checksums                                                           */
/* ------------------------------------------------------------------ */

/**
 * Read a SHA-256 out of a `sha256sum`-style sidecar: the digest is the first token of the
 * first non-empty line, so both `<digest>` and `<digest>  filename` work. Anything that is
 * not exactly 64 hex characters is rejected rather than guessed at.
 */
export function parseDigest(sidecar: string | undefined | null): string | undefined {
  const first = (sidecar ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!first) return undefined
  const token = first.split(/\s+/)[0]
  if (!token || token.length !== 64 || !/^[0-9a-f]{64}$/i.test(token)) return undefined
  return token.toLowerCase()
}

export async function digestOf(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

/**
 * Confirm a downloaded file matches its published digest, and delete it if not. A payload
 * that failed its check is not kept for inspection: the next run would find it on disk and
 * have to decide about it all over again.
 */
export async function verifyOrDelete(
  file: string,
  expected: string,
): Promise<{ ok: boolean; message: string }> {
  let actual: string
  try {
    actual = await digestOf(file)
  } catch (error) {
    await fsp.rm(file, { force: true })
    return {
      ok: false,
      message: `the download could not be read to verify it (${(error as Error).message}); it was discarded`,
    }
  }
  if (actual.toLowerCase() === expected.toLowerCase()) {
    return { ok: true, message: `verified sha256 ${actual}` }
  }
  await fsp.rm(file, { force: true })
  return {
    ok: false,
    message: `the download did not match its published checksum (expected ${expected}, got ${actual}); it was discarded`,
  }
}

/* ------------------------------------------------------------------ */
/* Releases                                                            */
/* ------------------------------------------------------------------ */

export interface GitHubReleaseJson {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
  assets?: { name?: string; browser_download_url?: string; size?: number }[]
}

export function releaseFrom(json: GitHubReleaseJson): Release | undefined {
  const tag = json.tag_name ?? ''
  if (!tag || json.draft) return undefined
  return {
    version: tag.replace(/^v/i, ''),
    tag,
    url: json.html_url ?? '',
    notes: json.body ?? '',
    assets: (json.assets ?? [])
      .filter((a) => a.name && a.browser_download_url)
      .map((a) => ({ name: a.name!, url: a.browser_download_url!, size: a.size ?? 0 })),
  }
}

/**
 * The installer for this platform, and the sidecar that must accompany it. Assets whose name
 * ends `.sha256` are checksums, never payloads — picking one of those as the installer would
 * be an easy and very confusing bug.
 */
export function installerFor(
  release: Release,
  platform: NodeJS.Platform,
): ReleaseAsset | undefined {
  const wanted =
    platform === 'win32' ? /\.exe$/i : platform === 'darwin' ? /\.dmg$/i : /\.(AppImage|deb)$/i
  return release.assets.find((a) => !/\.sha256$/i.test(a.name) && wanted.test(a.name))
}

export function digestUrlFor(asset: ReleaseAsset, release: Release): string | undefined {
  const sidecar = release.assets.find((a) => a.name === `${asset.name}.sha256`)
  return sidecar?.url ?? `${asset.url}.sha256`
}

/* ------------------------------------------------------------------ */
/* Staging                                                             */
/* ------------------------------------------------------------------ */

export async function recordStaged(dir: string, staged: StagedUpdate): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, MANIFEST_NAME), JSON.stringify(staged, null, 2), 'utf8')
}

export async function clearStaged(dir: string): Promise<void> {
  await fsp.rm(path.join(dir, MANIFEST_NAME), { force: true })
}

/**
 * The staged update waiting for this launch, or undefined.
 *
 * Re-verifies the payload on the way out. The manifest records that a digest was checked when
 * the file was downloaded; that was a different run, and the file has been sitting on disk
 * since. A manifest for a version we are already running (or newer than the download) is
 * stale and cleared.
 */
export async function pendingUpdate(
  dir: string,
  currentVersion: string,
): Promise<{ staged?: StagedUpdate; problem?: string }> {
  const manifest = path.join(dir, MANIFEST_NAME)
  let staged: StagedUpdate
  try {
    staged = JSON.parse(await fsp.readFile(manifest, 'utf8')) as StagedUpdate
  } catch {
    return {}
  }

  if (!staged?.payloadPath || !staged.sha256 || !staged.version) {
    await clearStaged(dir)
    return { problem: 'the staged update manifest was unreadable and has been discarded' }
  }
  if (compareVersions(staged.version, currentVersion) <= 0) {
    await clearStaged(dir)
    return {}
  }
  if (!fs.existsSync(staged.payloadPath)) {
    await clearStaged(dir)
    return { problem: 'the staged installer is no longer on disk' }
  }

  const verdict = await verifyOrDelete(staged.payloadPath, staged.sha256)
  if (!verdict.ok) {
    await clearStaged(dir)
    return { problem: `the staged installer was rejected at launch: ${verdict.message}` }
  }
  return { staged }
}
