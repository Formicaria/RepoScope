import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  readRepositoryFromDisk,
  filterUploadedFiles,
  stripCommonRoot,
} from '../server/analyzer/ingest.js'
import {
  detectEntryPoints,
  detectLanguages,
  detectManifests,
  detectRoutes,
  detectStorage,
} from '../server/analyzer/detect.js'
import { analyzeImports, extractSpecifiers, stripJsonComments } from '../server/analyzer/imports.js'
import { buildGraph, moduleKeyFor } from '../server/analyzer/graph.js'
import { findCycles } from '../server/analyzer/warnings.js'
import { computeHealth } from '../server/analyzer/score.js'
import { analyzeRepository } from '../server/analyzer/index.js'
import { aggregateEdges, topLevelIds } from '../shared/graph.js'
import type { RepoFile } from '../shared/types.js'

const FIXTURE = path.resolve(__dirname, 'fixtures/sample-app')
const repo = {
  name: 'sample-app',
  fullName: 'tests/sample-app',
  source: 'upload' as const,
  scannedAt: '2026-01-01T00:00:00Z',
}

describe('repository parsing', () => {
  it('ignores node_modules and never reads secret files', async () => {
    const files = await readRepositoryFromDisk(FIXTURE)
    const paths = files.map((f) => f.path)
    expect(paths).not.toContain('node_modules/leftpad/index.js')
    expect(paths).toContain('.env')
    expect(files.find((f) => f.path === '.env')?.content).toBeUndefined()
    expect(files.find((f) => f.path === 'src/server.ts')?.content).toContain('express')
  })

  it('applies the same rules to uploaded files and strips the common root', () => {
    const uploaded: RepoFile[] = [
      { path: 'proj/node_modules/x/index.js', size: 1, content: 'x' },
      { path: 'proj/dist/bundle.js', size: 1, content: 'x' },
      { path: 'proj/src/a.ts', size: 1, content: 'x' },
      { path: 'proj/.env', size: 1, content: 'SECRET=1' },
    ]
    const out = filterUploadedFiles(stripCommonRoot(uploaded))
    expect(out.map((f) => f.path)).toEqual(['src/a.ts', '.env'])
    expect(out[1].content).toBeUndefined()
  })

  it('detects languages, frameworks, dependencies and entry points', async () => {
    const files = await readRepositoryFromDisk(FIXTURE)
    const langs = detectLanguages(files)
    expect(langs[0].name).toBe('TypeScript')
    const manifests = detectManifests(files)
    expect(manifests.frameworks).toContain('Express')
    expect(manifests.dependencies.map((d) => d.name)).toEqual(
      expect.arrayContaining(['express', 'pg', 'stripe', 'lodash']),
    )
    expect(manifests.packageName).toBe('sample-app')
    const entries = detectEntryPoints(files, manifests.entryHints)
    expect(entries).toEqual(['src/server.ts'])
  })

  it('detects API routes and storage layers', async () => {
    const files = await readRepositoryFromDisk(FIXTURE)
    const routes = detectRoutes(files)
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /users', 'POST /users'])
    const storage = detectStorage(files, detectManifests(files).dependencies)
    expect(storage.map((s) => s.name)).toContain('PostgreSQL')
  })

  it('extracts import specifiers across languages', () => {
    expect(
      extractSpecifiers({
        path: 'a.ts',
        size: 1,
        content: "import x from './x'\nconst y = require('y')\nexport * from '../z'",
      }),
    ).toEqual(['./x', '../z', 'y'])
    expect(
      extractSpecifiers({
        path: 'a.py',
        size: 1,
        content: 'import os, sys\nfrom app.core import config',
      }),
    ).toEqual(['os', 'sys', 'app.core'])
    expect(
      extractSpecifiers({
        path: 'a.go',
        size: 1,
        content: 'import (\n\t"fmt"\n\t"github.com/x/y"\n)',
      }),
    ).toEqual(['fmt', 'github.com/x/y'])
    expect(
      extractSpecifiers({ path: 'a.cs', size: 1, content: 'using System;\nusing My.App.Core;' }),
    ).toEqual(['System', 'My.App.Core'])
  })

  it('resolves relative and aliased imports, and separates externals', async () => {
    const files = await readRepositoryFromDisk(FIXTURE)
    const imports = analyzeImports(files)
    const internal = imports.filter((i) => i.to).map((i) => `${i.from} -> ${i.to}`)
    expect(internal).toContain('src/server.ts -> src/routes/users.ts')
    expect(internal).toContain('src/services/userService.ts -> src/models/user.ts')
    const external = imports.filter((i) => i.external).map((i) => i.external)
    expect(external).toEqual(expect.arrayContaining(['express', 'pg', 'stripe']))
  })

  it('parses tsconfig files with comments', () => {
    const cfg = JSON.parse(stripJsonComments('{\n // hi\n "a": 1, /* block */ "b": [1,2,],\n}'))
    expect(cfg).toEqual({ a: 1, b: [1, 2] })
  })
})

describe('graph generation', () => {
  it('groups files into modules by folder', () => {
    const dirs = new Set([
      'src',
      'src/routes',
      'packages',
      'packages/api',
      'packages/api/src',
      'packages/api/src/handlers',
    ])
    expect(moduleKeyFor('src/routes/users.ts', dirs)).toBe('src/routes')
    expect(moduleKeyFor('src/index.ts', dirs)).toBe('src')
    expect(moduleKeyFor('README.md', dirs)).toBe('')
    expect(moduleKeyFor('packages/api/src/handlers/a.ts', dirs)).toBe('packages/api')
    const big = new Map([['packages/api', 100]])
    expect(moduleKeyFor('packages/api/src/handlers/a.ts', dirs, big)).toBe(
      'packages/api/src/handlers',
    )
  })

  it('builds typed nodes and aggregated module edges', async () => {
    const files = await readRepositoryFromDisk(FIXTURE)
    const manifests = detectManifests(files)
    const graph = buildGraph({
      files,
      imports: analyzeImports(files),
      dependencies: manifests.dependencies,
      entryPoints: detectEntryPoints(files, manifests.entryHints),
      routes: detectRoutes(files),
      storage: detectStorage(files, manifests.dependencies),
      packageName: manifests.packageName,
    })
    const byName = Object.fromEntries(graph.nodes.filter((n) => !n.parent).map((n) => [n.name, n]))
    expect(byName['src/server.ts'].type).toBe('entry')
    expect(byName['routes'].type).toBe('api')
    expect(byName['routes'].meta?.routes).toEqual(['GET /users', 'POST /users'])
    expect(byName['services'].type).toBe('service')
    expect(byName['models'].type).toBe('database')
    expect(byName['components'].type).toBe('component')
    expect(byName['tests'].type).toBe('test')
    expect(byName['PostgreSQL'].type).toBe('database')
    expect(byName['Stripe'].type).toBe('integration')
    // lodash is declared but never imported -> no node, marked unused
    expect(byName['lodash']).toBeUndefined()
    expect(manifests.dependencies.find((d) => d.name === 'lodash')?.used).toBe(false)
    expect(manifests.dependencies.find((d) => d.name === 'stripe')?.used).toBe(true)

    const edges = aggregateEdges(graph.nodes, graph.edges, topLevelIds(graph.nodes))
    const pairs = edges.map((e) => `${e.source} -> ${e.target} (${e.type})`)
    expect(pairs).toContain('entry:src/server.ts -> mod:src-routes (imports)')
    expect(pairs).toContain('mod:src-routes -> mod:src-services (imports)')
    expect(pairs).toContain('mod:src-services -> mod:src-models (imports)')
    expect(pairs).toContain('mod:src-models -> store:postgresql (dataflow)')
    expect(pairs).toContain('mod:src-services -> ext:stripe (depends)')
    expect(pairs).toContain('mod:tests -> mod:src-services (tests)')
    expect(byName['services'].dependents).toContain('mod:src-routes')
    // module nodes are expandable into their files
    expect(byName['services'].children).toEqual([
      'file:src/services/billing.ts',
      'file:src/services/userService.ts',
    ])
  })

  it('finds circular dependencies', () => {
    const nodes = ['a', 'b', 'c'].map((id) => ({
      id: `file:${id}`,
      name: id,
      type: 'file' as const,
      path: id,
      description: '',
      importance: 0,
      dependencies: [],
      dependents: [],
      warnings: [],
    }))
    const edges = [
      { id: '1', source: 'file:a', target: 'file:b', type: 'imports' as const, confidence: 1 },
      { id: '2', source: 'file:b', target: 'file:a', type: 'imports' as const, confidence: 1 },
      { id: '3', source: 'file:b', target: 'file:c', type: 'imports' as const, confidence: 1 },
    ]
    const cycles = findCycles(nodes, edges)
    expect(cycles).toHaveLength(1)
    expect(cycles[0].sort()).toEqual(['file:a', 'file:b'])
  })
})

describe('warnings and scoring', () => {
  it('reports secrets without exposing values, dead modules, cycles and unused deps', async () => {
    const result = await analyzeRepository(repo, await readRepositoryFromDisk(FIXTURE))
    const kinds = result.warnings.map((w) => w.kind)
    expect(kinds).toContain('exposed-secret')
    expect(kinds).toContain('dead-module')
    expect(kinds).toContain('circular-dependency')
    expect(kinds).toContain('unused-dependency')
    const secret = result.warnings.filter((w) => w.kind === 'exposed-secret')
    expect(secret.map((w) => w.path)).toEqual(
      expect.arrayContaining(['.env', 'src/utils/secrets.ts']),
    )
    for (const w of result.warnings) {
      expect(w.detail).not.toContain('AKIAZZZZQQQQ1234ABCD')
      expect(w.detail).not.toContain('hunter2')
    }
    expect(JSON.stringify(result)).not.toContain('hunter2')
    const dead = result.warnings.find((w) => w.kind === 'dead-module')
    expect(dead?.path).toBe('src/components')
  })

  it('produces a bounded health score with a breakdown', async () => {
    const files = await readRepositoryFromDisk(FIXTURE)
    const result = await analyzeRepository(repo, files)
    expect(result.health.score).toBeGreaterThanOrEqual(0)
    expect(result.health.score).toBeLessThanOrEqual(100)
    expect(result.health.breakdown.find((b) => b.signal === 'Secrets')?.delta).toBeLessThan(0)
    expect(result.health.breakdown.find((b) => b.signal === 'Tests')?.delta).toBe(0)
    // Removing the secret warnings must raise the score.
    const without = computeHealth({
      files,
      graph: { ...result, moduleEdges: [], fileModule: new Map(), fileNode: new Map() },
      warnings: result.warnings.filter((w) => w.kind !== 'exposed-secret'),
      dependencies: result.dependencies,
    })
    expect(without.score).toBeGreaterThan(result.health.score)
  })

  it('writes a deterministic summary', async () => {
    const a = await analyzeRepository(repo, await readRepositoryFromDisk(FIXTURE))
    const b = await analyzeRepository(repo, await readRepositoryFromDisk(FIXTURE))
    expect(a.summary).toEqual(b.summary)
    expect(a.summary.headline).toContain('sample-app')
    expect(a.summary.headline).toContain('Express')
    expect(a.stats.modules).toBeGreaterThan(3)
  })

  it('handles an empty or unsupported repository gracefully', async () => {
    const result = await analyzeRepository(repo, [{ path: 'notes.txt', size: 5, content: 'hello' }])
    expect(result.warnings.map((w) => w.kind)).toContain('unclear-entry')
    expect(result.nodes.length).toBeGreaterThan(0)
    expect(result.health.score).toBeGreaterThanOrEqual(0)
  })
})
