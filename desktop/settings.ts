import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { UpdateMode } from './updates.js'

/**
 * Desktop settings, stored as one small JSON file in the per-user data directory.
 *
 * Deliberately not in the repository's `.env` or next to the executable: an installed app
 * may live somewhere the user cannot write, and settings that vanish on update are worse
 * than no settings.
 */
export interface DesktopSettings {
  /** How updates behave. `notify` is the default: nothing installs without being asked. */
  updateMode: UpdateMode
  /** The licence key as pasted, verified on every read rather than trusted from disk. */
  licenceKey?: string
}

export const DEFAULTS: DesktopSettings = { updateMode: 'notify' }

const FILE = 'settings.json'

export function readSettings(dir: string): DesktopSettings {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, FILE), 'utf8'),
    ) as Partial<DesktopSettings>
    return {
      updateMode: ['off', 'notify', 'auto'].includes(raw.updateMode as string)
        ? (raw.updateMode as UpdateMode)
        : DEFAULTS.updateMode,
      licenceKey: typeof raw.licenceKey === 'string' ? raw.licenceKey : undefined,
    }
  } catch {
    // Missing or corrupt settings are not an error worth stopping for: the defaults are safe.
    return { ...DEFAULTS }
  }
}

export async function writeSettings(dir: string, settings: DesktopSettings): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, FILE), JSON.stringify(settings, null, 2), 'utf8')
}
