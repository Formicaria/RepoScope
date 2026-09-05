import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  readRepositoryFromDisk,
  filterUploadedFiles,
  stripCommonRoot,
} from '../server/analyzer/ingest.js'
import {
  MAX_ENTRY_POINTS,
  detectEntryPoints,
  detectLanguages,
  detectManifests,
  detectRoutes,
  detectStorage,
} from '../server/analyzer/detect.js'
import { analyzeImports, extractSpecifiers, stripJsonComments } from '../server/analyzer/imports.js'
import { parsingAvailable } from '../server/analyzer/parse.js'
import { buildGraph, classifyModule, moduleKeyFor } from '../server/analyzer/graph.js'
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
    const { imports } = await analyzeImports(files)
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
      imports: (await analyzeImports(files)).imports,
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

describe('import resolution', () => {
  const f = (path: string, content = ''): RepoFile => ({ path, size: content.length, content })
  const resolved = async (files: RepoFile[]) => {
    const { imports } = await analyzeImports(files)
    return imports.filter((i) => i.to).map((i) => `${i.from} -> ${i.to}`)
  }

  it('follows tsconfig path aliases with a wildcard in the middle of the target', async () => {
    // The shape monorepos actually use: "@acme/*" -> "packages/*/src".
    const files = [
      f(
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: { paths: { '@acme/*': ['packages/*/src'], '@app/*': ['./src/*'] } },
        }),
      ),
      f('packages/shared/src/index.ts', 'export const one = 1'),
      f('src/util/format.ts', 'export const fmt = 1'),
      f('src/app.ts', "import { one } from '@acme/shared'\nimport { fmt } from '@app/util/format'"),
    ]
    expect(await resolved(files)).toEqual([
      'src/app.ts -> packages/shared/src/index.ts',
      'src/app.ts -> src/util/format.ts',
    ])
  })

  it('links an import of a workspace package to the package in this repository', async () => {
    const files = [
      f('package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] })),
      f('packages/ui/package.json', JSON.stringify({ name: '@acme/ui', main: 'src/index.ts' })),
      f('packages/ui/src/index.ts', 'export const Button = 1'),
      f('apps/web/package.json', JSON.stringify({ name: '@acme/web' })),
      f('apps/web/src/page.ts', "import { Button } from '@acme/ui'"),
    ]
    expect(await resolved(files)).toEqual(['apps/web/src/page.ts -> packages/ui/src/index.ts'])
  })

  it("resolves SvelteKit's $lib alias", async () => {
    const files = [
      f('svelte.config.js', 'export default {}'),
      f('src/lib/api.ts', 'export const get = 1'),
      f('src/routes/+page.svelte', "<script>import { get } from '$lib/api'</script>"),
    ]
    expect(await resolved(files)).toEqual(['src/routes/+page.svelte -> src/lib/api.ts'])
  })

  it('resolves an import of the repository root', async () => {
    const files = [
      f('index.js', 'module.exports = 1'),
      f('test/deep/case.js', "const app = require('../..')"),
    ]
    expect(await resolved(files)).toEqual(['test/deep/case.js -> index.js'])
  })

  it('resolves `from . import module` in Python', async () => {
    const files = [
      f('pkg/__init__.py', ''),
      f('pkg/models.py', 'class User: pass'),
      f('pkg/service.py', 'from . import models\nfrom .models import User'),
    ]
    const out = await resolved(files)
    expect(out).toContain('pkg/service.py -> pkg/models.py')
  })

  it('resolves Java imports through declared packages', async () => {
    const files = [
      f(
        'src/main/java/com/acme/domain/UserService.java',
        'package com.acme.domain;\npublic class UserService {}',
      ),
      f(
        'src/main/java/com/acme/api/UserController.java',
        'package com.acme.api;\nimport com.acme.domain.UserService;\npublic class UserController {}',
      ),
    ]
    expect(await resolved(files)).toEqual([
      'src/main/java/com/acme/api/UserController.java -> src/main/java/com/acme/domain/UserService.java',
    ])
  })

  it('reports specifiers that point inside the repository but do not resolve', async () => {
    const files = [
      f('src/a.ts', "import './definitely-missing'\nimport 'react'\nimport './logo.png'"),
    ]
    const { diagnostics } = await analyzeImports(files)
    expect(diagnostics.unresolvedLocal.map((u) => u.raw)).toEqual(['./definitely-missing'])
    // Assets are dropped by ingest, so they are not counted as analyzer gaps.
    expect(diagnostics.external).toBe(1)
  })

  it('does not create edges for imports that only appear in comments or strings', async () => {
    const files = [
      f('src/real.ts', 'export const x = 1'),
      f(
        'src/main.ts',
        "// import { x } from './real'\nconst snippet = `import { x } from './real'`\nexport const y = 2",
      ),
    ]
    const out = await resolved(files)
    // With a grammar loaded this is empty; the regex fallback would report a false edge.
    if (parsingAvailable()) expect(out).toEqual([])
  })
})

describe('module boundaries and classification', () => {
  const f = (path: string, content = ''): RepoFile => ({ path, size: content.length, content })

  it('gives every declared package its own module, whatever the folder is called', async () => {
    // ripgrep-style layout: `crates/` is not a conventional workspace folder name, but each
    // sub-directory declares a Cargo package, so each is its own module.
    const files = [
      f('Cargo.toml', '[workspace]\nmembers = ["crates/*"]'),
      f('crates/cli/Cargo.toml', '[package]\nname = "grep-cli"'),
      f('crates/cli/src/lib.rs', 'pub mod decompress;'),
      f('crates/cli/src/decompress.rs', 'use grep_regex::thing;'),
      f('crates/regex/Cargo.toml', '[package]\nname = "grep-regex"'),
      f('crates/regex/src/lib.rs', 'pub fn thing() {}'),
    ]
    const { imports } = await analyzeImports(files)
    // The cross-crate `use grep_regex::…` resolves to the sibling crate.
    expect(imports.filter((i) => i.to).map((i) => `${i.from} -> ${i.to}`)).toContain(
      'crates/cli/src/decompress.rs -> crates/regex/src/lib.rs',
    )
    const result = await analyzeRepository(repo, files)
    const modules = result.modules.map((m) => m.path)
    expect(modules).toContain('crates/cli')
    expect(modules).not.toContain('crates')
    // Whatever the crate collapses to, both crates are distinct nodes with a link between
    // them — not one undifferentiated "crates" blob, which is what a folder-name rule gives.
    const top = result.nodes.filter((n) => !n.parent)
    expect(top.some((n) => n.path.startsWith('crates/regex'))).toBe(true)
    const edges = aggregateEdges(result.nodes, result.edges, new Set(top.map((n) => n.id)))
    expect(
      edges.some(
        (e) =>
          (e.source.includes('crates-cli') || e.source.includes('crates/cli')) &&
          e.target.includes('regex'),
      ),
    ).toBe(true)
  })

  it('types a directory with its own manifest as an application', () => {
    const files = [f('tools/playground/index.ts', 'export const x = 1')]
    expect(classifyModule('tools/playground', files, new Set(), ['tools/playground'])).toBe('app')
    expect(classifyModule('tools/playground', files, new Set(), [])).toBe('module')
  })

  it('does not report the repository root or a standalone package as dead code', async () => {
    const files = [
      f('package.json', JSON.stringify({ name: 'root' })),
      f('index.ts', "import './helper'"),
      f('helper.ts', 'export const h = 1'),
      f('tools/playground/package.json', JSON.stringify({ name: 'playground' })),
      f('tools/playground/main.ts', 'console.log(1)'),
    ]
    const result = await analyzeRepository(repo, files)
    const dead = result.warnings.filter((w) => w.kind === 'dead-module').map((w) => w.path)
    expect(dead).not.toContain('/')
    expect(dead).not.toContain('tools/playground')
  })
})

describe('entry points', () => {
  const f = (path: string, content = ''): RepoFile => ({ path, size: content.length, content })

  it('prefers the manifest, then a package root, and keeps the list short', async () => {
    const files = [
      f('package.json', JSON.stringify({ name: 'app', main: 'src/server.ts' })),
      f('src/server.ts', 'app.listen(3000)'),
      f('src/index.ts', 'export * from "./server"'),
      ...Array.from({ length: 20 }, (_, i) => f(`src/feature${i}/main.ts`, 'export const x = 1')),
    ]
    const entries = detectEntryPoints(files, ['src/server.ts'], [])
    // Ranked: the manifest's "main" outranks a conventional index.ts beside it.
    expect(entries[0]).toBe('src/server.ts')
    expect(entries.length).toBeLessThanOrEqual(MAX_ENTRY_POINTS)
  })

  it('finds one entry per package in a monorepo instead of dozens', () => {
    const files = [
      f('packages/a/package.json', JSON.stringify({ name: 'a' })),
      f('packages/a/src/index.ts', 'export const a = 1'),
      f('packages/b/package.json', JSON.stringify({ name: 'b' })),
      f('packages/b/src/index.ts', 'export const b = 1'),
      f('packages/b/src/util/index.ts', 'export const u = 1'),
    ]
    const entries = detectEntryPoints(files, [], ['packages/a', 'packages/b'])
    expect([...entries].sort()).toEqual(['packages/a/src/index.ts', 'packages/b/src/index.ts'])
  })

  it('recognises a framework root and a package-relative main', () => {
    const svelte = [f('src/routes/+layout.svelte', '<slot />'), f('src/lib/api.ts', '')]
    expect(detectEntryPoints(svelte, [], [])).toContain('src/routes/+layout.svelte')

    // ripgrep-style: main.rs lives in a crate, not at the repository root.
    const rust = [f('crates/core/Cargo.toml', ''), f('crates/core/main.rs', 'fn main() {}')]
    expect(detectEntryPoints(rust, [], ['crates/core'])).toContain('crates/core/main.rs')
  })
})

describe('secret findings in test fixtures', () => {
  const f = (path: string, content = ''): RepoFile => ({ path, size: content.length, content })

  it('reports a fixture key as information and does not dock the health score', async () => {
    const base = [
      f('package.json', JSON.stringify({ name: 'app', main: 'index.js' })),
      f('index.js', 'console.log(1)'),
      f('tests/app.test.js', 'test("x", () => {})'),
    ]
    const clean = await analyzeRepository(repo, base)
    const withFixture = await analyzeRepository(repo, [
      ...base,
      { path: 'tests/client_certs/client.pem', size: 100 },
    ])
    const finding = withFixture.warnings.find((w) => w.kind === 'exposed-secret')
    expect(finding?.severity).toBe('info')
    expect(finding?.title).toContain('Test fixture')
    // Reported, but the score is unchanged — a throwaway key in tests is not a leak.
    expect(withFixture.health.score).toBe(clean.health.score)

    // The same file outside a test folder stays critical and is penalised.
    const real = await analyzeRepository(repo, [...base, { path: 'config/client.pem', size: 100 }])
    expect(real.warnings.find((w) => w.kind === 'exposed-secret')?.severity).toBe('critical')
    expect(real.health.score).toBeLessThan(clean.health.score)
  })
})

describe('file-based API routes', () => {
  const f = (path: string, content = ''): RepoFile => ({ path, size: content.length, content })

  it('detects routes in an app nested inside a monorepo', () => {
    const routes = detectRoutes([
      f('apps/web/pages/api/links/[id].ts', 'export default handler'),
      f('apps/web/app/api/health/route.ts', 'export function GET() {}'),
      f('src/routes/api/items/+server.ts', 'export function GET() {}'),
    ])
    expect(routes.map((r) => r.path).sort()).toEqual([
      '/api/health',
      '/api/items',
      '/api/links/:id',
    ])
  })
})
