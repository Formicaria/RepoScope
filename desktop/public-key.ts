/**
 * The public half of the licence signing key.
 *
 * This file is committed with a placeholder, and the release build **overwrites the compiled
 * copy** in `dist-electron/` with the real key (see `scripts/embed-public-key.ts`, run as
 * part of `npm run desktop:compile`). The key is a build input, not a runtime one: reading it
 * from the environment when the app starts would mean an installed app on someone else's
 * machine has no key at all, and every licence would read as invalid.
 *
 * A build that still carries the placeholder verifies nothing — `verifyLicence` reports every
 * key as invalid and the app runs unlicensed. That is the correct direction to fail: an
 * unconfigured build must not accept everything.
 */
export const PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nPLACEHOLDER\n-----END PUBLIC KEY-----\n'
