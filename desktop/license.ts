import { createPublicKey, verify } from 'node:crypto'
import { PUBLIC_KEY_PEM } from './public-key.js'

/**
 * Offline licence verification.
 *
 * A licence is a signed statement, not a permission slip fetched from a server. The holder's
 * details and tier are signed with an Ed25519 private key that lives only with whoever issues
 * keys; the app carries the matching public key and checks the signature. That means no
 * licence server to host, no network dependency, and nothing to break when someone is offline
 * or the endpoint is down.
 *
 * What this is NOT: tamper-proof. RepoScope is MIT-licensed and its source is public, so
 * anyone may fork it and delete this file — legally. This is a gate for people who want to
 * pay, kept deliberately simple and honest about what it is, rather than an obfuscated lock
 * that would inconvenience paying users and stop nobody else.
 *
 * Key format — three dot-separated parts, so a key is one copy-pasteable line:
 *
 *     rsl1.<base64url(payload JSON)>.<base64url(signature)>
 */

export interface LicencePayload {
  /** Who the licence is for, shown in the UI so a key is identifiable. */
  holder: string
  /** Tier name; `FEATURES` maps capabilities to the tiers that include them. */
  tier: string
  /** ISO date of issue. */
  issued: string
  /** ISO date after which the licence no longer grants its tier. Omit for perpetual. */
  expires?: string
  /** Free-form note from the issuer (order reference, seat count, …). Never shown as trusted. */
  note?: string
}

export type LicenceStatus =
  | { state: 'unlicensed' }
  | { state: 'licensed'; payload: LicencePayload; expiresInDays?: number }
  | { state: 'expired'; payload: LicencePayload }
  /** Present but not trustworthy: wrong signature, wrong shape, wrong prefix. */
  | { state: 'invalid'; reason: string }

export const KEY_PREFIX = 'rsl1'

export { PUBLIC_KEY_PEM }

function decode(part: string): Buffer {
  return Buffer.from(part, 'base64url')
}

/** The bytes that are signed: the payload segment exactly as it appears in the key. */
function signedBytes(payloadSegment: string): Buffer {
  return Buffer.from(`${KEY_PREFIX}.${payloadSegment}`, 'utf8')
}

/**
 * Verify a licence key against the embedded public key.
 *
 * Every failure path returns a status rather than throwing: a malformed key pasted into a
 * settings box is a normal event, not an exception, and the app must keep working as
 * unlicensed whatever the string was.
 */
export function verifyLicence(
  key: string | undefined | null,
  now: Date = new Date(),
  publicKeyPem: string = PUBLIC_KEY_PEM,
): LicenceStatus {
  const trimmed = (key ?? '').trim()
  if (!trimmed) return { state: 'unlicensed' }

  const parts = trimmed.split('.')
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) {
    return { state: 'invalid', reason: 'This does not look like a RepoScope licence key.' }
  }

  let publicKey
  try {
    publicKey = createPublicKey(publicKeyPem)
  } catch {
    // A build without a real public key cannot verify anything, and must not pretend to.
    return {
      state: 'invalid',
      reason: 'This build carries no licence public key, so keys cannot be verified.',
    }
  }

  let signatureOk = false
  try {
    signatureOk = verify(null, signedBytes(parts[1]), publicKey, decode(parts[2]))
  } catch {
    signatureOk = false
  }
  if (!signatureOk) {
    return {
      state: 'invalid',
      reason: 'The signature on this key is not valid. Check it was pasted in full.',
    }
  }

  let payload: LicencePayload
  try {
    payload = JSON.parse(decode(parts[1]).toString('utf8')) as LicencePayload
  } catch {
    return { state: 'invalid', reason: 'The key is signed but its contents could not be read.' }
  }
  if (!payload || typeof payload.holder !== 'string' || typeof payload.tier !== 'string') {
    return { state: 'invalid', reason: 'The key is signed but does not name a holder and tier.' }
  }

  if (payload.expires) {
    const expires = new Date(payload.expires)
    if (Number.isNaN(expires.getTime())) {
      return { state: 'invalid', reason: 'The key has an expiry date that cannot be read.' }
    }
    if (expires.getTime() <= now.getTime()) return { state: 'expired', payload }
    return {
      state: 'licensed',
      payload,
      expiresInDays: Math.ceil((expires.getTime() - now.getTime()) / 86_400_000),
    }
  }

  return { state: 'licensed', payload }
}

/** The tier in force. An expired or invalid key grants the free tier, never an error state. */
export function tierOf(status: LicenceStatus): string {
  return status.state === 'licensed' ? status.payload.tier : 'free'
}
