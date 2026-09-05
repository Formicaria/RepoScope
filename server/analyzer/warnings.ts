import type { Dependency, ProjectEdge, ProjectNode, RepoFile, Warning } from '../../shared/types.js'
import { countLines, languageOf, CODE_LANGUAGES } from './detect.js'
import { isSecretFile } from './ingest.js'
import { basename, stripExt } from './paths.js'
import type { GraphOutput } from './graph.js'

/**
 * Secret patterns. We only ever report the file and line — never the matched value.
 */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Stripe key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    name: 'Hard-coded credential assignment',
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  },
  {
    name: 'Connection string with password',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/]+:[^@\s/]{4,}@/i,
  },
]

/**
 * Test fixtures, sample apps and documentation routinely commit throwaway keys and .env
 * files on purpose. They are worth mentioning but they are not leaked credentials, so they
 * are reported at info severity and left out of the health score.
 */
const FIXTURE_CONTEXT =
  /(^|\/)(tests?|__tests__|test_apps?|fixtures?|spec|specs|examples?|samples?|demos?|docs?|e2e|cypress|playwright|testdata|mocks?|__mocks__)\//i

const PLACEHOLDER =
  /(example|placeholder|changeme|your[_-]?|xxx|dummy|<[^>]+>|\$\{|process\.env|os\.environ|getenv|\.\.\.|@(localhost|127\.0\.0\.1|db|database|postgres|mysql|mongo|redis|host)\b)/i

export interface WarningInput {
  files: RepoFile[]
  graph: GraphOutput
  dependencies: Dependency[]
  entryPoints: string[]
  hasImportsFor: Set<Dependency['ecosystem']>
}

export function detectWarnings(input: WarningInput): Warning[] {
  const { files, graph, dependencies, entryPoints } = input
  const warnings: Warning[] = []
  let seq = 0
  const add = (w: Omit<Warning, 'id'>) => {
    warnings.push({ id: `w${++seq}`, ...w })
  }
  const nodeByPath = new Map<string, ProjectNode>()
  for (const n of graph.nodes)
    if (n.type === 'file' || n.type === 'entry') nodeByPath.set(n.path, n)
  const moduleOf = (path: string) => graph.fileModule.get(path)

  /* Entry points */
  if (entryPoints.length === 0) {
    add({
      kind: 'unclear-entry',
      severity: 'warning',
      title: 'No clear entry point',
      detail:
        'Could not find a main/index/server file, a package.json "main"/"start" script or a main() function. Readers will struggle to know where execution begins.',
    })
  } else if (entryPoints.length > 8) {
    add({
      kind: 'unclear-entry',
      severity: 'info',
      title: `${entryPoints.length} candidate entry points`,
      detail: `Many files look like entry points (${entryPoints.slice(0, 5).join(', ')}, …). Consider documenting the primary one in the README.`,
    })
  }

  /* Tests */
  const testFiles = files.filter(
    (f) =>
      /(^|\/)(tests?|__tests__|spec|specs|e2e|cypress)\//.test(f.path) ||
      /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb|rs|ex)$|^test_.*\.py$|Tests?\.cs$|Test\.(java|kt)$/.test(
        basename(f.path),
      ),
  )
  const codeFiles = files.filter((f) => {
    const l = languageOf(f.path)
    return l && CODE_LANGUAGES.has(l)
  })
  if (testFiles.length === 0 && codeFiles.length > 3) {
    add({
      kind: 'missing-tests',
      severity: 'critical',
      title: 'No automated tests found',
      detail:
        'No test directory or *.test / *_test files were detected. Behaviour changes cannot be verified automatically.',
    })
  } else if (
    codeFiles.length > 20 &&
    testFiles.length / Math.max(1, codeFiles.length - testFiles.length) < 0.1
  ) {
    add({
      kind: 'missing-tests',
      severity: 'warning',
      title: 'Sparse test coverage',
      detail: `${testFiles.length} test file${testFiles.length === 1 ? '' : 's'} for ${codeFiles.length - testFiles.length} source files. Core modules probably lack tests.`,
    })
  }
  // Per-module: sizeable code modules with no test imports pointing at them.
  const testedTargets = new Set<string>()
  for (const e of graph.edges)
    if (e.type === 'tests')
      testedTargets.add(graph.fileModule.get(e.target.replace(/^file:/, '')) ?? e.target)
  for (const m of graph.modules) {
    if (!['service', 'api', 'database', 'module', 'app'].includes(m.type)) continue
    if (m.files.length < 6 || testFiles.length === 0) continue
    if (testedTargets.has(m.id)) continue
    const hasOwnTests = m.files.some((p) => testFiles.some((t) => t.path === p))
    if (hasOwnTests) continue
    add({
      kind: 'missing-tests',
      severity: 'info',
      title: `No tests reference "${m.name}"`,
      detail: `The ${m.type} module at ${m.path} (${m.files.length} files) is not imported by any test file.`,
      path: m.path,
      nodeId: m.id,
    })
  }

  /* Secrets */
  for (const f of files) {
    const name = basename(f.path)
    if (isSecretFile(name)) {
      if (/^\.env\.(example|sample|template|dist)$/.test(name)) continue
      if (
        /^\.env/.test(name) ||
        /\.(pem|key|p12|pfx|jks|keystore)$/i.test(name) ||
        /^id_/.test(name)
      ) {
        const fixture = FIXTURE_CONTEXT.test(f.path)
        add({
          kind: 'exposed-secret',
          severity: fixture ? 'info' : 'critical',
          title: fixture
            ? `Test fixture holds a secret-carrying file: ${f.path}`
            : `Secret-carrying file committed: ${f.path}`,
          detail: fixture
            ? `${name} sits under a test or example folder, so it is most likely deliberate throwaway data. Its contents were not read or displayed. Worth confirming it holds nothing real.`
            : `${name} is tracked in the repository. Its contents were not read or displayed. Move secrets to an untracked file or a secret manager and add it to .gitignore.`,
          path: f.path,
          nodeId: nodeByPath.get(f.path)?.id,
        })
      }
      continue
    }
    if (!f.content) continue
    if (FIXTURE_CONTEXT.test(f.path)) continue
    const lines = f.content.split('\n')
    let hits = 0
    for (let i = 0; i < lines.length && hits < 3; i++) {
      const line = lines[i]
      if (line.length > 500) continue
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(line) && !PLACEHOLDER.test(line)) {
          hits++
          add({
            kind: 'exposed-secret',
            severity: 'critical',
            title: `Possible ${p.name.toLowerCase()} in ${f.path}`,
            detail: `Line ${i + 1} of ${f.path} looks like it contains a ${p.name.toLowerCase()}. The value is intentionally not shown. Rotate it and load it from the environment instead.`,
            path: f.path,
            nodeId: nodeByPath.get(f.path)?.id,
          })
          break
        }
      }
    }
  }

  /* Large files */
  for (const f of files) {
    const lines = countLines(f.content)
    const lang = languageOf(f.path)
    const isCode = lang && CODE_LANGUAGES.has(lang)
    if (f.size > 1_000_000) {
      add({
        kind: 'large-file',
        severity: 'warning',
        title: `Very large file: ${f.path}`,
        detail: `${(f.size / 1_048_576).toFixed(1)} MB. Large binaries or data dumps bloat the repository and are usually better stored elsewhere.`,
        path: f.path,
        nodeId: nodeByPath.get(f.path)?.id,
      })
    } else if (isCode && lines > 1200) {
      add({
        kind: 'excessive-complexity',
        severity: 'warning',
        title: `${basename(f.path)} has ${lines} lines`,
        detail: `${f.path} is unusually long for a single source file. Consider splitting it by responsibility.`,
        path: f.path,
        nodeId: nodeByPath.get(f.path)?.id,
      })
    }
  }

  /* Module-level complexity */
  for (const n of graph.nodes) {
    if (n.parent || !['module', 'service', 'api', 'component', 'database', 'app'].includes(n.type))
      continue
    const fanOut = n.dependencies.filter(
      (d) => !d.startsWith('ext:') && !d.startsWith('store:'),
    ).length
    if ((n.meta?.files ?? 0) > 120) {
      add({
        kind: 'excessive-complexity',
        severity: 'info',
        title: `"${n.name}" contains ${n.meta?.files} files`,
        detail: `${n.path} is a very large module. Splitting it into feature folders would make the architecture easier to follow.`,
        path: n.path,
        nodeId: n.id,
      })
    }
    if (fanOut >= 10) {
      add({
        kind: 'excessive-complexity',
        severity: 'info',
        title: `"${n.name}" depends on ${fanOut} other modules`,
        detail: `High fan-out suggests this module knows about too much of the system. Consider introducing clearer boundaries.`,
        path: n.path,
        nodeId: n.id,
      })
    }
  }

  /* Dead-looking modules */
  const entryModules = new Set(entryPoints.map((p) => moduleOf(p)).filter(Boolean))
  for (const n of graph.nodes) {
    if (n.parent) continue
    if (!['module', 'service', 'database', 'component'].includes(n.type)) continue
    // "Nothing imports the repository root" is not a finding.
    if (n.path === '/' || n.path === '') continue
    if (entryModules.has(n.id)) continue
    if (n.dependents.length > 0) continue
    if ((n.meta?.files ?? 0) < 2) continue
    const hasImportsIn = graph.edges.some(
      (e) => e.source.startsWith('file:') && graph.fileModule.get(e.source.slice(5)) === n.id,
    )
    if (!hasImportsIn && graph.edges.length === 0) continue // import analysis unsupported for this language
    add({
      kind: 'dead-module',
      severity: 'warning',
      title: `"${n.name}" is not referenced anywhere`,
      detail: `Nothing imports ${n.path} and it contains no entry point. It may be dead code, a plugin loaded dynamically, or a standalone tool.`,
      path: n.path,
      nodeId: n.id,
    })
  }

  /* Circular dependencies (file level, reported at module level) */
  const cycles = findCycles(graph.nodes, graph.edges)
  for (const cyc of cycles.slice(0, 8)) {
    const names = cyc.map((id) => id.replace(/^file:/, ''))
    const modulesInvolved = new Set(names.map((p) => moduleOf(p)).filter(Boolean))
    add({
      kind: 'circular-dependency',
      severity: modulesInvolved.size > 1 ? 'warning' : 'info',
      title: `Circular import between ${names.length} files`,
      detail: `${names.slice(0, 4).join(' → ')}${names.length > 4 ? ` → … (${names.length} files)` : ''} → ${names[0]}. Cycles make modules hard to test and load in isolation.`,
      path: names[0],
      nodeId: [...modulesInvolved][0],
    })
  }

  /* Duplicate functionality: the same non-generic file name in several modules */
  const GENERIC =
    /^(index|main|mod|__init__|lib|app|types|constants|config|setup|package|readme|program|startup|routes?|handler|server|client|page|layout|route|loading|error|schema|test|tests|utils?|helpers?|common|base)$/i
  const byStem = new Map<string, Set<string>>()
  for (const f of codeFiles) {
    const stem = stripExt(basename(f.path))
      .toLowerCase()
      .replace(/\.(test|spec)$/, '')
    if (GENERIC.test(stem) || stem.length < 5) continue
    if (testFiles.includes(f)) continue
    const mod = moduleOf(f.path)
    if (!mod) continue
    byStem.set(stem, (byStem.get(stem) ?? new Set()).add(mod))
  }
  let dupCount = 0
  for (const [stem, mods] of byStem) {
    if (mods.size < 3 || dupCount >= 5) continue
    dupCount++
    const names = [...mods].map((m) => graph.nodes.find((n) => n.id === m)?.name ?? m)
    add({
      kind: 'duplicate-functionality',
      severity: 'info',
      title: `"${stem}" exists in ${mods.size} modules`,
      detail: `Files named ${stem}.* appear in ${names.join(', ')}. They may implement the same thing more than once.`,
    })
  }

  /* Unused dependencies (only for ecosystems where we parsed imports) */
  const SKIP_UNUSED =
    /^(typescript|@types\/|eslint|prettier|vite|vitest|jest|ts-node|tsx|nodemon|husky|lint-staged|webpack|rollup|esbuild|babel|@babel|postcss|autoprefixer|tailwindcss|@tailwindcss|concurrently|rimraf|cross-env|dotenv-cli|tslib|@vitejs|@testing-library|cypress|playwright|@playwright|turbo|nx|lerna|storybook|@storybook|sass|less|stylelint|commitlint|@commitlint|semantic-release|release-it|np|pytest|black|flake8|mypy|ruff|isort|pre-commit|coverage|tox|setuptools|wheel|pip|build|twine|gunicorn|uvicorn|serve|http-server|source-map|@vue\/|vue-tsc|swc|@swc|sharp|next|react-dom|react-scripts|prisma|drizzle-kit|@prisma\/engines|patch-package)/
  const unused = dependencies.filter(
    (d) =>
      !d.dev &&
      !d.used &&
      input.hasImportsFor.has(d.ecosystem) &&
      !SKIP_UNUSED.test(d.name) &&
      d.ecosystem !== 'nuget' &&
      d.ecosystem !== 'maven',
  )
  if (unused.length > 0) {
    add({
      kind: 'unused-dependency',
      severity: 'info',
      title: `${unused.length} declared dependenc${unused.length === 1 ? 'y is' : 'ies are'} never imported`,
      detail: `${unused
        .slice(0, 8)
        .map((d) => d.name)
        .join(
          ', ',
        )}${unused.length > 8 ? ', …' : ''}. Detection is heuristic (CLI tools and plugins may be used without an import).`,
    })
  }

  // Attach warning ids to nodes.
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  for (const w of warnings) {
    if (w.nodeId) byId.get(w.nodeId)?.warnings.push(w.id)
    const fileNode = w.path ? nodeByPath.get(w.path) : undefined
    if (fileNode && fileNode.id !== w.nodeId) fileNode.warnings.push(w.id)
    if (fileNode?.parent && fileNode.parent !== w.nodeId) {
      const parent = byId.get(fileNode.parent)
      if (parent && !parent.warnings.includes(w.id)) parent.warnings.push(w.id)
    }
  }
  const order: Record<Warning['severity'], number> = { critical: 0, warning: 1, info: 2 }
  return warnings.sort((a, b) => order[a.severity] - order[b.severity])
}

/** Tarjan's SCC over import edges; returns cycles of length >= 2 (largest first). */
export function findCycles(nodes: ProjectNode[], edges: ProjectEdge[]): string[][] {
  const adj = new Map<string, string[]>()
  for (const n of nodes) if (n.type === 'file' || n.type === 'entry') adj.set(n.id, [])
  for (const e of edges) {
    if (e.type !== 'imports' && e.type !== 'tests') continue
    if (!adj.has(e.source) || !adj.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
  }
  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const result: string[][] = []

  // Iterative Tarjan to avoid deep recursion on big repos.
  for (const start of adj.keys()) {
    if (idx.has(start)) continue
    const work: [string, number][] = [[start, 0]]
    idx.set(start, index)
    low.set(start, index)
    index++
    stack.push(start)
    onStack.add(start)
    while (work.length) {
      const [v, i] = work[work.length - 1]
      const neighbours = adj.get(v)!
      if (i < neighbours.length) {
        work[work.length - 1][1] = i + 1
        const w = neighbours[i]
        if (!idx.has(w)) {
          idx.set(w, index)
          low.set(w, index)
          index++
          stack.push(w)
          onStack.add(w)
          work.push([w, 0])
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, idx.get(w)!))
        }
      } else {
        work.pop()
        if (work.length) {
          const parent = work[work.length - 1][0]
          low.set(parent, Math.min(low.get(parent)!, low.get(v)!))
        }
        if (low.get(v) === idx.get(v)) {
          const comp: string[] = []
          let w: string
          do {
            w = stack.pop()!
            onStack.delete(w)
            comp.push(w)
          } while (w !== v)
          if (comp.length > 1) result.push(comp.reverse())
        }
      }
    }
  }
  return result.sort((a, b) => b.length - a.length)
}
