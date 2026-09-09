import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { getScan, startGitHubScan, startUploadScan } from './scans.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Build the Express app without binding a port.
 *
 * Split out from `index.ts` so the desktop build can host the same analyzer in-process
 * rather than shipping a second copy of it. There is exactly one implementation of every
 * route, whether it is reached from a browser or from the Electron shell.
 */
export function createApp() {
  const app = express()

  app.use(express.json({ limit: '60mb' }))

  const scanBody = z.object({ url: z.string().min(3).max(300) })
  const uploadBody = z.object({
    name: z.string().min(1).max(120),
    files: z
      .array(
        z.object({
          path: z.string().min(1).max(600),
          size: z.number().nonnegative(),
          content: z.string().optional(),
        }),
      )
      .max(8000),
  })

  /** Start a GitHub scan. Responds with the initial status; poll GET /api/scan/:id. */
  app.post('/api/scan', (req, res) => {
    const parsed = scanBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Provide a repository URL.' })
      return
    }
    res.json(startGitHubScan(parsed.data.url))
  })

  /** Scan a folder uploaded from the browser (already filtered client-side, filtered again here). */
  app.post('/api/scan/upload', (req, res) => {
    const parsed = uploadBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Upload payload was not understood.' })
      return
    }
    res.json(startUploadScan(parsed.data.name, parsed.data.files))
  })

  app.get('/api/scan/:id', (req, res) => {
    const scan = getScan(req.params.id)
    if (!scan) {
      res.status(404).json({
        error: 'Scan not found. Results live in memory and are cleared when the server restarts.',
      })
      return
    }
    res.json(scan)
  })

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  // Serve the built client in production.
  /**
   * Where the built client lives, relative to wherever this module ended up.
   *
   * Two layouts have to work: `server/app.ts` run by tsx, where the client is `../dist`,
   * and the compiled desktop build at `dist-electron/server/app.js`, where it is one level
   * further up. Hard-coding `../dist` served a 404 to the Electron window — the app opened
   * blank — so the candidates are checked instead of assumed.
   */
  const dist = ['../dist', '../../dist', '../../../dist']
    .map((candidate) => path.resolve(__dirname, candidate))
    .find((candidate) => existsSync(path.join(candidate, 'index.html')))

  if (process.env.NODE_ENV === 'production' && dist) {
    app.use(express.static(dist))
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))
  }

  return app
}
