import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * RepoScope's own version.
 *
 * `app.getVersion()` is right in a packaged build and wrong everywhere else: run as
 * `electron main.js`, the "app" is Electron, so it returns Electron's version. The smoke
 * test caught this reporting `33.4.11` — which the updater would have compared against the
 * latest release and concluded RepoScope was thirty-two major versions ahead of itself,
 * silently never offering an update.
 */
export function appVersion(): string {
  if (app.isPackaged) return app.getVersion()

  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const candidate of ['../package.json', '../../package.json', '../../../package.json']) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(here, candidate), 'utf8')) as {
        name?: string
        version?: string
      }
      if (parsed.name === 'reposcope' && parsed.version) return parsed.version
    } catch {
      // Try the next candidate.
    }
  }
  // Nothing found: report Electron's version rather than inventing one, and let the caller's
  // version comparison be visibly odd rather than quietly wrong.
  return app.getVersion()
}
