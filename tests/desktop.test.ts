import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { KEY_PREFIX, tierOf, verifyLicence, type LicencePayload } from '../desktop/license.js'
import { allows, granted } from '../desktop/features.js'
import {
  clearStaged,
  compareVersions,
  digestOf,
  digestUrlFor,
  installerFor,
  parseDigest,
  pendingUpdate,
  recordStaged,
  releaseFrom,
  verifyOrDelete,
  type Release,
} from '../desktop/updates.js'

/* ------------------------------------------------------------------ */
/* Licensing                                                           */
/* ------------------------------------------------------------------ */

const keys = generateKeyPairSync('ed25519')
const PUBLIC_PEM = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const OTHER = generateKeyPairSync('ed25519')

function issue(payload: LicencePayload, privateKey = keys.privateKey): string {
  const segment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = sign(null, Buffer.from(`${KEY_PREFIX}.${segment}`, 'utf8'), privateKey)
  return `${KEY_PREFIX}.${segment}.${signature.toString('base64url')}`
}

const PRO: LicencePayload = { holder: 'C', tier: 'pro', issued: '2026-01-01' }

describe('licence verification', () => {
  it('accepts a key signed by the matching private key', () => {
    const status = verifyLicence(issue(PRO), new Date('2026-06-01'), PUBLIC_PEM)
    expect(status.state).toBe('licensed')
    expect(tierOf(status)).toBe('pro')
  })

  it('rejects a key signed by a different key', () => {
    const status = verifyLicence(issue(PRO, OTHER.privateKey), new Date('2026-06-01'), PUBLIC_PEM)
    expect(status.state).toBe('invalid')
    expect(tierOf(status)).toBe('free')
  })

  /** The whole point of signing: the payload cannot be edited after the fact. */
  it('rejects a key whose payload was edited to upgrade the tier', () => {
    const honest = issue({ ...PRO, tier: 'free' })
    const [prefix, , signature] = honest.split('.')
    const forged = Buffer.from(JSON.stringify({ ...PRO, tier: 'pro' }), 'utf8').toString(
      'base64url',
    )
    const status = verifyLicence(
      `${prefix}.${forged}.${signature}`,
      new Date('2026-06-01'),
      PUBLIC_PEM,
    )
    expect(status.state).toBe('invalid')
  })

  it('treats an expired key as expired, not as an error, and grants the free tier', () => {
    const status = verifyLicence(
      issue({ ...PRO, expires: '2026-03-01' }),
      new Date('2026-06-01'),
      PUBLIC_PEM,
    )
    expect(status.state).toBe('expired')
    expect(tierOf(status)).toBe('free')
  })

  it('reports how long a dated licence has left', () => {
    const status = verifyLicence(
      issue({ ...PRO, expires: '2026-06-11' }),
      new Date('2026-06-01'),
      PUBLIC_PEM,
    )
    expect(status.state).toBe('licensed')
    if (status.state === 'licensed') expect(status.expiresInDays).toBe(10)
  })

  it('is unlicensed rather than invalid when there is no key at all', () => {
    for (const empty of [undefined, null, '', '   ']) {
      expect(verifyLicence(empty, new Date(), PUBLIC_PEM).state).toBe('unlicensed')
    }
  })

  it('survives arbitrary junk in the key box', () => {
    for (const junk of [
      'hello',
      'a.b.c',
      `${KEY_PREFIX}.!!!.!!!`,
      `${KEY_PREFIX}.` + 'x'.repeat(5000),
    ]) {
      const status = verifyLicence(junk, new Date(), PUBLIC_PEM)
      expect(['invalid', 'unlicensed']).toContain(status.state)
      expect(tierOf(status)).toBe('free')
    }
  })

  /**
   * A build with no real public key must verify nothing. The dangerous failure would be an
   * empty or malformed key meaning "accept everything".
   */
  it('accepts nothing when the build carries no public key', () => {
    const status = verifyLicence(issue(PRO), new Date('2026-06-01'), 'not a key')
    expect(status.state).toBe('invalid')
    expect(tierOf(status)).toBe('free')
  })

  it('gates only the extras, never the analyzer', () => {
    const free = verifyLicence(undefined, new Date(), PUBLIC_PEM)
    const pro = verifyLicence(issue(PRO), new Date('2026-06-01'), PUBLIC_PEM)
    expect(granted(free)).toEqual([])
    expect(allows(free, 'scan-history')).toBe(false)
    expect(allows(pro, 'scan-history')).toBe(true)
    expect(granted(pro)).toContain('batch-scan')
  })
})

/* ------------------------------------------------------------------ */
/* Updates                                                             */
/* ------------------------------------------------------------------ */

describe('update checking', () => {
  it('compares versions without being confused by v prefixes or missing segments', () => {
    expect(compareVersions('0.8.0', '0.7.0')).toBeGreaterThan(0)
    expect(compareVersions('v0.8.0', '0.8.0')).toBe(0)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0)
    expect(compareVersions('0.8.0-rc.1', '0.8.0')).toBe(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
  })

  it('reads a digest from either sidecar shape and refuses anything else', () => {
    const digest = 'a'.repeat(64)
    expect(parseDigest(digest)).toBe(digest)
    expect(parseDigest(`${digest}  RepoScope-Setup.exe\n`)).toBe(digest)
    expect(parseDigest(`\n\n${digest} *file\n`)).toBe(digest)
    expect(parseDigest('A'.repeat(64))).toBe('a'.repeat(64))
    for (const bad of [undefined, '', 'not-a-digest', 'z'.repeat(64), 'a'.repeat(63)]) {
      expect(parseDigest(bad)).toBeUndefined()
    }
  })

  const release: Release = {
    version: '0.8.0',
    tag: 'v0.8.0',
    url: 'https://example.invalid/tag',
    notes: '',
    assets: [
      { name: 'RepoScope-Setup-0.8.0.exe', url: 'https://example.invalid/setup.exe', size: 1 },
      {
        name: 'RepoScope-Setup-0.8.0.exe.sha256',
        url: 'https://example.invalid/setup.exe.sha256',
        size: 1,
      },
      { name: 'RepoScope-0.8.0.dmg', url: 'https://example.invalid/app.dmg', size: 1 },
    ],
  }

  it('never mistakes a checksum file for the installer', () => {
    expect(installerFor(release, 'win32')?.name).toBe('RepoScope-Setup-0.8.0.exe')
    expect(installerFor(release, 'darwin')?.name).toBe('RepoScope-0.8.0.dmg')
    expect(installerFor(release, 'linux')).toBeUndefined()
  })

  it('prefers a published sidecar asset over a guessed URL', () => {
    const exe = installerFor(release, 'win32')!
    expect(digestUrlFor(exe, release)).toBe('https://example.invalid/setup.exe.sha256')
    const dmg = installerFor(release, 'darwin')!
    expect(digestUrlFor(dmg, release)).toBe('https://example.invalid/app.dmg.sha256')
  })

  it('ignores drafts and strips the tag prefix', () => {
    expect(releaseFrom({ tag_name: 'v1.2.3' })?.version).toBe('1.2.3')
    expect(releaseFrom({ tag_name: 'v1.2.3', draft: true })).toBeUndefined()
    expect(releaseFrom({})).toBeUndefined()
  })

  it('deletes a download that does not match its checksum', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rs-upd-'))
    const payload = path.join(dir, 'setup.exe')
    await fsp.writeFile(payload, 'pretend installer')
    const real = await digestOf(payload)

    const good = await verifyOrDelete(payload, real)
    expect(good.ok).toBe(true)
    expect(await fsp.readFile(payload, 'utf8')).toBe('pretend installer')

    const bad = await verifyOrDelete(payload, 'b'.repeat(64))
    expect(bad.ok).toBe(false)
    expect(bad.message).toMatch(/did not match/)
    await expect(fsp.stat(payload)).rejects.toThrow()
  })

  /**
   * The manifest records a check made in an earlier run. Between then and launch the
   * installer sat on a disk anything with write access could reach, so it is checked again.
   */
  it('re-verifies a staged installer at launch and rejects a tampered one', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rs-stage-'))
    const payload = path.join(dir, 'setup.exe')
    await fsp.writeFile(payload, 'genuine installer')
    const sha256 = await digestOf(payload)
    await recordStaged(dir, {
      version: '0.9.0',
      asset: 'setup.exe',
      sha256,
      payloadPath: payload,
      stagedAt: new Date().toISOString(),
    })

    const first = await pendingUpdate(dir, '0.8.0')
    expect(first.staged?.version).toBe('0.9.0')

    // Someone replaces the installer after it was staged.
    await fsp.writeFile(payload, 'malicious installer')
    const second = await pendingUpdate(dir, '0.8.0')
    expect(second.staged).toBeUndefined()
    expect(second.problem).toMatch(/rejected at launch/)
    // And the manifest is gone, so the next launch does not retry the same bad payload.
    expect((await pendingUpdate(dir, '0.8.0')).staged).toBeUndefined()
  })

  it('discards a staged update that is not newer than the running build', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rs-stale-'))
    const payload = path.join(dir, 'setup.exe')
    await fsp.writeFile(payload, 'installer')
    await recordStaged(dir, {
      version: '0.8.0',
      asset: 'setup.exe',
      sha256: await digestOf(payload),
      payloadPath: payload,
      stagedAt: new Date().toISOString(),
    })
    expect((await pendingUpdate(dir, '0.8.0')).staged).toBeUndefined()
  })

  it('reports nothing pending when no update was ever staged', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rs-empty-'))
    expect(await pendingUpdate(dir, '0.8.0')).toEqual({})
    await clearStaged(dir) // must not throw when there is nothing to clear
  })
})
