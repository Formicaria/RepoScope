/**
 * Bake the licence public key into the compiled desktop build.
 *
 * Run after `tsc` as part of `npm run desktop:compile`. It rewrites the *compiled*
 * `public-key.js`, leaving the source tree clean — a build step that edits tracked files
 * makes every release look like it has uncommitted changes.
 *
 * With `REPOSCOPE_LICENCE_PUBKEY` unset this does nothing and says so. That build cannot
 * verify any licence, which is deliberate: the alternative failure — an unconfigured build
 * accepting every key — is the one that matters.
 */
import { createPublicKey } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const TARGET = path.join('dist-electron', 'desktop', 'public-key.js')
const pem = process.env.REPOSCOPE_LICENCE_PUBKEY

if (!pem?.trim()) {
  console.log(
    'embed-public-key: REPOSCOPE_LICENCE_PUBKEY is not set, so this build keeps the\n' +
      '  placeholder key and will treat every licence key as invalid.',
  )
  process.exit(0)
}

// Fail here rather than shipping a build that rejects every customer's key.
try {
  createPublicKey(pem)
} catch (error) {
  console.error(
    `embed-public-key: REPOSCOPE_LICENCE_PUBKEY is not a valid public key — ${(error as Error).message}`,
  )
  process.exit(1)
}

if (!fs.existsSync(TARGET)) {
  console.error(
    `embed-public-key: ${TARGET} does not exist. Run tsc -p tsconfig.electron.json first.`,
  )
  process.exit(1)
}

fs.writeFileSync(
  TARGET,
  `// Generated at build time by scripts/embed-public-key.ts. Do not edit.\n` +
    `export const PUBLIC_KEY_PEM = ${JSON.stringify(pem)};\n`,
  'utf8',
)
console.log('embed-public-key: licence public key embedded.')
