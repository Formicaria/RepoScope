/**
 * Regenerates src/data/demo.json by scanning a real public repository.
 * Usage: npm run demo:generate -- https://github.com/owner/repo
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { analyzeRepository } from '../server/analyzer/index.js'
import { readRepositoryFromDisk } from '../server/analyzer/ingest.js'

const url = process.argv[2] ?? 'https://github.com/gothinkster/node-express-realworld-example-app'
const m = url.match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
if (!m) throw new Error('Expected a GitHub URL')
const [, owner, repo] = m
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reposcope-demo-'))
console.log(`cloning ${owner}/${repo}…`)
await simpleGit().clone(`https://github.com/${owner}/${repo}.git`, dir, ['--depth', '1'])
const files = await readRepositoryFromDisk(dir)
const result = await analyzeRepository(
  {
    name: repo,
    fullName: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`,
    source: 'demo',
    scannedAt: new Date().toISOString(),
  },
  files,
)
result.id = 'demo'
const out = path.resolve('src/data/demo.json')
await fs.writeFile(out, JSON.stringify(result))
await fs.rm(dir, { recursive: true, force: true })
console.log(
  `wrote ${out}: ${result.stats.files} files, ${result.stats.modules} modules, ${result.nodes.length} nodes, ${result.edges.length} edges, health ${result.health.score}`,
)
