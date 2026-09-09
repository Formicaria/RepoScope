/**
 * Licence key issuance.
 *
 *   npm run licence -- keypair                       generate a signing keypair
 *   npm run licence -- issue --holder "Name" [opts]  sign a key
 *
 * The private key never belongs in this repository. `keypair` writes it wherever you point
 * `--out` and prints the public half for you to paste into `desktop/license.ts` (or supply
 * as REPOSCOPE_LICENCE_PUBKEY at build time). `issue` reads the private key from
 * `REPOSCOPE_LICENCE_PRIVKEY` (PEM contents) or `--key <path>`.
 *
 * Options for `issue`:
 *   --holder <name>     required; shown in the app so a key is identifiable
 *   --tier <name>       default `pro`; must match a tier in desktop/features.ts
 *   --expires <date>    ISO date; omit for a perpetual key
 *   --note <text>       order reference or similar, for your own records
 */
import { generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { KEY_PREFIX, verifyLicence, type LicencePayload } from '../desktop/license.js'

const args = process.argv.slice(2)
const command = args.find((a) => !a.startsWith('-'))

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1]
  const inline = args.find((a) => a.startsWith(`--${name}=`))
  return inline?.slice(name.length + 3)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

if (command === 'keypair') {
  const out = flag('out') ?? path.join(process.cwd(), '..', 'reposcope-licence-private.pem')
  if (fs.existsSync(out)) {
    fail(
      `${out} already exists. Refusing to overwrite it — every key you have issued was signed\n` +
        'with that private key, and replacing it invalidates all of them. Pass --out elsewhere.',
    )
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

  fs.writeFileSync(out, privatePem, { mode: 0o600 })
  console.log(`Private key written to ${out} (mode 600). Back it up; it cannot be recovered.`)
  console.log('\nPaste this public key into desktop/license.ts as PUBLIC_KEY_PEM:\n')
  console.log(JSON.stringify(publicPem))
  console.log(
    '\nA build carrying the placeholder key verifies nothing and treats every licence as\n' +
      'invalid, which is the safe failure — but it also means nobody can activate.',
  )
  process.exit(0)
}

if (command === 'issue') {
  const holder = flag('holder')
  if (!holder) fail('Usage: npm run licence -- issue --holder "Name" [--tier pro] [--expires ISO]')

  const keyPath = flag('key')
  const privatePem =
    process.env.REPOSCOPE_LICENCE_PRIVKEY ??
    (keyPath ? fs.readFileSync(keyPath, 'utf8') : undefined)
  if (!privatePem) {
    fail('No private key. Set REPOSCOPE_LICENCE_PRIVKEY to its PEM contents, or pass --key <path>.')
  }

  const expires = flag('expires')
  if (expires && Number.isNaN(new Date(expires).getTime()))
    fail(`--expires is not a date: ${expires}`)

  const payload: LicencePayload = {
    holder,
    tier: flag('tier') ?? 'pro',
    issued: new Date().toISOString().slice(0, 10),
    ...(expires ? { expires } : {}),
    ...(flag('note') ? { note: flag('note')! } : {}),
  }

  const segment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = sign(null, Buffer.from(`${KEY_PREFIX}.${segment}`, 'utf8'), privatePem)
  const key = `${KEY_PREFIX}.${segment}.${signature.toString('base64url')}`

  // Verify against the public key this build carries, so a mismatched pair is caught here
  // rather than by the customer.
  const check = verifyLicence(key)
  if (check.state !== 'licensed') {
    console.error(
      `\nWarning: this key does not verify against the public key in desktop/license.ts\n` +
        `(${check.state}${check.state === 'invalid' ? `: ${check.reason}` : ''}).\n` +
        'The key is printed below anyway, but check you are signing with the matching private key.\n',
    )
  }

  console.log(key)
  process.exit(0)
}

fail(
  'Usage: npm run licence -- <keypair|issue> [options]  (see the comment at the top of this file)',
)
