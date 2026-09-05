import type { RepoFile } from '../../shared/types.js'
import { languageOf } from './detect.js'
import { parseFile, type ParsedFile, type ParsedImport } from './parse.js'
import { basename, dirname, joinNormalize, stripExt } from './paths.js'

export interface FileImport {
  from: string
  /** Resolved repository path (internal import). */
  to?: string
  /** Package / module name (external import). */
  external?: string
  raw: string
  /** Named bindings, when the parser could see them ('*' for a namespace import). */
  symbols?: string[]
  kind?: ParsedImport['kind']
  /** TypeScript `import type` and friends — real coupling, but weaker. */
  typeOnly?: boolean
}

/** Counts that say how much of the repository RepoScope actually understood. */
export interface ImportDiagnostics {
  /** Files whose imports came from a syntax tree rather than regular expressions. */
  parsedFiles: number
  regexFiles: number
  totalSpecifiers: number
  resolvedInternal: number
  external: number
  /**
   * Specifiers that unambiguously point inside this repository (relative paths, configured
   * aliases, `mod:` declarations) but could not be resolved to a file. These are always
   * analyzer bugs or unsupported conventions, which makes the count a ground-truth
   * accuracy signal — see `npm run bench`.
   */
  unresolvedLocal: { from: string; raw: string }[]
}

export interface ImportAnalysis {
  imports: FileImport[]
  diagnostics: ImportDiagnostics
}

const JS_EXTS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.vue',
  '.svelte',
  '.json',
]

/** Extract raw import specifiers from a source file, per language. */
export function extractSpecifiers(file: RepoFile): string[] {
  const c = file.content
  if (!c) return []
  const lang = languageOf(file.path)
  const out: string[] = []
  switch (lang) {
    case 'TypeScript':
    case 'JavaScript':
    case 'Vue':
    case 'Svelte': {
      for (const m of c.matchAll(/\bimport\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g))
        out.push(m[1])
      for (const m of c.matchAll(/\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g))
        out.push(m[1])
      for (const m of c.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
      for (const m of c.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
      break
    }
    case 'Python': {
      for (const m of c.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm))
        for (const s of m[1].split(',')) out.push(s.trim())
      for (const m of c.matchAll(/^\s*from\s+([\w.]+)\s+import\b/gm)) out.push(m[1])
      break
    }
    case 'Go': {
      for (const m of c.matchAll(/import\s*\(([\s\S]*?)\)/g))
        for (const s of m[1].matchAll(/"([^"]+)"/g)) out.push(s[1])
      for (const m of c.matchAll(/^import\s+(?:\w+\s+)?"([^"]+)"/gm)) out.push(m[1])
      break
    }
    case 'Rust': {
      for (const m of c.matchAll(/^\s*(?:pub\s+)?use\s+([\w:]+)/gm)) out.push(m[1])
      for (const m of c.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) out.push('mod:' + m[1])
      break
    }
    case 'C#': {
      for (const m of c.matchAll(/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm)) out.push(m[1])
      break
    }
    case 'Java':
    case 'Kotlin':
    case 'Scala': {
      for (const m of c.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)/gm)) out.push(m[1])
      break
    }
    case 'Ruby': {
      for (const m of c.matchAll(/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm)) out.push(m[1])
      break
    }
    case 'PHP': {
      for (const m of c.matchAll(/^\s*use\s+([\w\\]+)/gm)) out.push(m[1].replace(/\\/g, '/'))
      for (const m of c.matchAll(
        /(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]/g,
      ))
        out.push(m[1])
      break
    }
    case 'Dart': {
      for (const m of c.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1])
      break
    }
    case 'C':
    case 'C++': {
      for (const m of c.matchAll(/^\s*#include\s+"([^"]+)"/gm)) out.push('./' + m[1])
      break
    }
    default:
      break
  }
  return out
}

interface Resolver {
  byPath: Set<string>
  byStem: Map<string, string[]>
  /**
   * Path aliases, scoped to the folder that declared them. `pattern` and `template` keep
   * tsconfig semantics, including a wildcard in the middle of the target — as in
   * `"@vue/[star]": ["packages/[star]/src"]` — which a plain prefix-to-folder mapping
   * cannot express.
   */
  aliases: { pattern: string; template: string; base: string }[]
  goModule?: string
  csNamespaces: Map<string, string[]>
  pyModules: Map<string, string>
  /** Fully-qualified JVM/PHP package or namespace -> files declaring it. */
  packages: Map<string, string[]>
  /**
   * Workspace packages declared inside this repository: published name -> directory.
   * Covers npm/pnpm/yarn workspaces, Go multi-module repos and Cargo workspaces, so an
   * import of `@acme/shared` links to `packages/shared` instead of looking external.
   */
  workspaces: Map<string, string>
}

function buildResolver(files: RepoFile[], parsed: Map<string, ParsedFile>): Resolver {
  const byPath = new Set(files.map((f) => f.path))
  const byStem = new Map<string, string[]>()
  const csNamespaces = new Map<string, string[]>()
  const pyModules = new Map<string, string>()
  const packages = new Map<string, string[]>()
  const workspaces = new Map<string, string>()
  const aliases: Resolver['aliases'] = []
  let goModule: string | undefined

  for (const f of files) {
    const stem = stripExt(f.path)
    const list = byStem.get(stem) ?? []
    list.push(f.path)
    byStem.set(stem, list)
    if (f.path.endsWith('.py')) {
      // Register every suffix of the dotted path (backend/app/core/config.py -> backend.app.core.config,
      // app.core.config, core.config) so imports resolve whatever the project root is. Single-segment
      // names are only registered for files at the repository root to avoid false matches.
      const segs = stem.replace(/\/__init__$/, '').split('/')
      for (let i = 0; i < segs.length; i++) {
        const mod = segs.slice(i).join('.')
        if (segs.length - i === 1 && i !== 0) continue
        if (!pyModules.has(mod)) pyModules.set(mod, f.path)
      }
    }
    // Declared package / namespace: from the syntax tree when available, else a cheap regex.
    const declared =
      parsed.get(f.path)?.packageName ??
      (f.content && /\.(cs|java|kt|kts|scala)$/.test(f.path)
        ? (f.content.match(/^\s*(?:namespace|package)\s+([\w.]+)/m)?.[1] ?? undefined)
        : undefined)
    if (declared) {
      const list = packages.get(declared) ?? []
      list.push(f.path)
      packages.set(declared, list)
      if (f.path.endsWith('.cs')) {
        const l = csNamespaces.get(declared) ?? []
        l.push(f.path)
        csNamespaces.set(declared, l)
      }
    }
    if (basename(f.path) === 'go.mod' && !f.path.includes('/') && f.content) {
      goModule = f.content.match(/^module\s+(\S+)/m)?.[1]
    }
    // Workspace packages: every manifest that names a package maps that name to its folder.
    const dir = dirname(f.path)
    const base = basename(f.path)
    if (base === 'package.json' && f.content) {
      try {
        const pkg = JSON.parse(f.content) as { name?: unknown }
        if (typeof pkg.name === 'string' && pkg.name && f.path.includes('/')) {
          workspaces.set(pkg.name, dir)
        }
      } catch {
        /* malformed manifest */
      }
    } else if (base === 'go.mod' && f.content && f.path.includes('/')) {
      const mod = f.content.match(/^module\s+(\S+)/m)?.[1]
      if (mod) workspaces.set(mod, dir)
    } else if (base === 'Cargo.toml' && f.content && f.path.includes('/')) {
      const name = f.content.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/)?.[1]
      // Cargo crate names use hyphens; `use` paths use underscores.
      if (name) {
        workspaces.set(name, dir)
        workspaces.set(name.replace(/-/g, '_'), dir)
      }
    }

    // SvelteKit's `$lib`, and Vite/webpack aliases declared in a config file.
    if (/(^|\/)svelte\.config\.[cm]?[jt]s$/.test(f.path)) {
      aliases.push({ pattern: '$lib/*', template: joinNormalize(dir, 'src/lib/*'), base: dir })
      aliases.push({ pattern: '$lib', template: joinNormalize(dir, 'src/lib'), base: dir })
    }
    if (/(^|\/)(vite|vitest|nuxt|astro)\.config\.[cm]?[jt]s$/.test(f.path) && f.content) {
      for (const m of f.content.matchAll(
        /['"`]?([@~$][\w./-]*|[\w./-]+)['"`]?\s*:\s*(?:path\.resolve\([^,)]*,\s*)?['"`]([^'"`]+)['"`]/g,
      )) {
        const prefix = m[1]
        const target = m[2].replace(/^\.\//, '')
        if (!/^[@~$]|^src|^lib/.test(prefix) || prefix.length > 24) continue
        aliases.push({
          pattern: (prefix.endsWith('/') ? prefix : prefix + '/') + '*',
          template: joinNormalize(dir, target) + '/*',
          base: dir,
        })
      }
    }

    if (/(^|\/)(tsconfig|jsconfig)(\.\w+)?\.json$/.test(f.path) && f.content) {
      try {
        const cfg = JSON.parse(stripJsonComments(f.content))
        const baseUrl: string = cfg.compilerOptions?.baseUrl ?? '.'
        const paths: Record<string, string[]> = cfg.compilerOptions?.paths ?? {}
        for (const [k, v] of Object.entries(paths)) {
          if (!v?.[0]) continue
          aliases.push({
            pattern: k,
            template: joinNormalize(dir, joinNormalize(baseUrl, v[0])),
            base: dir,
          })
        }
      } catch {
        /* ignore malformed tsconfig */
      }
    }
  }
  // Fallbacks for the common "@/" and "~/" conventions when no tsconfig declares them.
  if ([...byPath].some((p) => p.startsWith('src/'))) {
    aliases.push({ pattern: '@/*', template: 'src/*', base: '' })
    aliases.push({ pattern: '~/*', template: 'src/*', base: '' })
  } else {
    aliases.push({ pattern: '@/*', template: '*', base: '' })
  }
  return { byPath, byStem, aliases, goModule, csNamespaces, pyModules, packages, workspaces }
}

/** Remove line and block comments plus trailing commas so tsconfig-style JSON parses. */
export function stripJsonComments(text: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i++
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
    } else {
      out += ch
      i++
    }
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}

/**
 * Resolve `@acme/shared` or `@acme/shared/util` to the workspace package that declares
 * that name, landing on its entry file the way a bundler would.
 */
function resolveWorkspace(r: Resolver, spec: string): string | undefined {
  if (!r.workspaces.size) return undefined
  let dir: string | undefined
  let rest = ''
  let matched = ''
  // Longest match wins: `@acme/a/b` prefers package `@acme/a/b` over `@acme/a`.
  for (const [name, target] of r.workspaces) {
    if (spec !== name && !spec.startsWith(name + '/')) continue
    if (name.length <= matched.length) continue
    matched = name
    dir = target
    rest = spec.slice(name.length).replace(/^\//, '')
  }
  if (dir === undefined) return undefined
  if (rest) {
    const direct = resolveWithin(r, joinNormalize(dir, rest))
    if (direct) return direct
  }
  for (const candidate of PACKAGE_ENTRIES) {
    const hit = resolveWithin(r, joinNormalize(dir, candidate))
    if (hit) return hit
  }
  return undefined
}

/** Conventional entry files for a package directory, in the order bundlers try them. */
const PACKAGE_ENTRIES = [
  'src/index',
  'src/main',
  'src/lib',
  'index',
  'main',
  'lib',
  'mod',
  'src/lib.rs',
]

/** Probe a path for the file it names, with or without an extension, or its index file. */
function resolveWithin(r: Resolver, target: string): string | undefined {
  if (!target) return undefined
  if (r.byPath.has(target)) return target
  for (const ext of JS_EXTS) {
    if (r.byPath.has(target + ext)) return target + ext
    const index = joinNormalize(target, 'index' + ext)
    if (r.byPath.has(index)) return index
  }
  for (const ext of ['.py', '.go', '.rs']) {
    if (r.byPath.has(target + ext)) return target + ext
  }
  return undefined
}

function inScope(fromDir: string, base: string): boolean {
  return base === '' || fromDir === base || fromDir.startsWith(base + '/')
}

/**
 * Match a tsconfig-style alias pattern against a specifier, returning the text the `*`
 * captured ('' for an exact, wildcard-free match) or undefined when it does not apply.
 */
export function matchAlias(pattern: string, spec: string): string | undefined {
  const star = pattern.indexOf('*')
  if (star === -1) return spec === pattern ? '' : undefined
  const pre = pattern.slice(0, star)
  const post = pattern.slice(star + 1)
  if (!spec.startsWith(pre) || !spec.endsWith(post)) return undefined
  if (spec.length < pre.length + post.length) return undefined
  return spec.slice(pre.length, spec.length - post.length)
}

function resolveJsLike(r: Resolver, fromDir: string, spec: string): string | undefined {
  let target: string | undefined
  if (spec.startsWith('.')) target = joinNormalize(fromDir, spec)
  else {
    // Prefer the alias declared closest to the importing file (monorepos declare "@/" per
    // package), then the most specific pattern. Several may match, so try each in turn.
    const candidates = r.aliases
      .filter((a) => inScope(fromDir, a.base) && matchAlias(a.pattern, spec) !== undefined)
      .sort((a, b) => b.base.length - a.base.length || b.pattern.length - a.pattern.length)
    for (const alias of candidates) {
      const wildcard = matchAlias(alias.pattern, spec)!
      const expanded = alias.template.includes('*')
        ? alias.template.replace('*', wildcard)
        : joinNormalize(alias.template, wildcard)
      const hit = resolveWithin(r, expanded.replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx'))
      if (hit) return hit
      target ??= expanded
    }
    if (target === undefined && spec.startsWith('/')) target = spec.slice(1)
  }
  if (target === undefined) return resolveWorkspace(r, spec)
  target = target.replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx')
  if (r.byPath.has(target)) return target
  const direct = r.byStem.get(stripExt(target)) ?? r.byStem.get(target)
  if (direct?.length) return direct[0]
  for (const ext of JS_EXTS) {
    // `joinNormalize` keeps paths root-relative, so importing the repository root
    // ("../..") yields "" and the index file must not gain a leading slash.
    if (target && r.byPath.has(target + ext)) return target + ext
    const index = joinNormalize(target, 'index' + ext)
    if (r.byPath.has(index)) return index
  }
  return undefined
}

function resolvePython(r: Resolver, fromPath: string, spec: string, symbols: string[]): string[] {
  const hits: string[] = []
  const push = (p: string | undefined) => {
    if (p && !hits.includes(p)) hits.push(p)
  }
  const asModule = (base: string): string | undefined => {
    if (r.byPath.has(base + '.py')) return base + '.py'
    if (r.byPath.has(base + '/__init__.py')) return base + '/__init__.py'
    return undefined
  }

  if (spec.startsWith('.')) {
    const dots = spec.match(/^\.+/)![0].length
    let dir = dirname(fromPath)
    for (let i = 1; i < dots; i++) dir = dirname(dir)
    const rest = spec.slice(dots).replace(/\./g, '/')
    const base = rest ? joinNormalize(dir, rest) : dir
    const direct = asModule(base)
    push(direct)
    // `from . import x` / `from .pkg import x`: each name may itself be a module.
    for (const sym of symbols) {
      if (sym === '*') continue
      push(asModule(joinNormalize(base, sym)))
    }
    if (!direct && !hits.length && r.byPath.has(base + '/__init__.py')) push(base + '/__init__.py')
    return hits
  }

  const parts = spec.split('.')
  // `from pkg.sub import name` — the name may be a submodule, which is a stronger match
  // than the package it lives in.
  for (const sym of symbols) {
    if (sym === '*') continue
    const mod = r.pyModules.get([...parts, sym].join('.'))
    push(mod)
  }
  for (let i = parts.length; i > 0; i--) {
    const mod = r.pyModules.get(parts.slice(0, i).join('.'))
    if (mod) {
      push(mod)
      break
    }
  }
  return hits
}

/** Java / Kotlin / Scala / PHP: resolve against the packages declared by the repository. */
function resolveJvm(r: Resolver, fromPath: string, spec: string): string | undefined {
  const exact = r.packages.get(spec)
  if (exact) {
    const other = exact.filter((p) => p !== fromPath)
    if (other.length) return other.sort()[0]
  }
  // `com.acme.user.UserService` -> package `com.acme.user`, class `UserService`.
  const cut = spec.lastIndexOf('.')
  if (cut > 0) {
    const pkg = spec.slice(0, cut)
    const cls = spec.slice(cut + 1)
    const files = r.packages.get(pkg)
    if (files) {
      const named = files.find((p) => stripExt(basename(p)) === cls && p !== fromPath)
      if (named) return named
      const other = files.filter((p) => p !== fromPath)
      if (other.length) return other.sort()[0]
    }
  }
  return undefined
}

function resolveGo(r: Resolver, spec: string): string | undefined {
  if (!r.goModule || !spec.startsWith(r.goModule)) {
    const ws = resolveWorkspace(r, spec)
    if (ws) return ws
  }
  if (!r.goModule || !spec.startsWith(r.goModule)) return undefined
  const rel = spec.slice(r.goModule.length).replace(/^\//, '')
  const dir = rel || '.'
  // Point at any .go file in that package directory (prefer non-test files).
  const cands = [...r.byPath].filter(
    (p) => p.endsWith('.go') && !p.endsWith('_test.go') && dirname(p) === (dir === '.' ? '' : dir),
  )
  return cands.sort()[0]
}

function resolveRust(r: Resolver, fromPath: string, spec: string): string | undefined {
  if (spec.startsWith('mod:')) {
    const name = spec.slice(4)
    const dir = dirname(fromPath)
    const base = basename(fromPath)
    const modDir =
      base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs' ? dir : stripExt(fromPath)
    for (const cand of [`${modDir}/${name}.rs`, `${modDir}/${name}/mod.rs`, `${dir}/${name}.rs`]) {
      if (r.byPath.has(cand)) return cand
    }
    return undefined
  }
  // `use grep_regex::…` in a Cargo workspace refers to the sibling crate `grep-regex`.
  const crateName = spec.split('::')[0]
  if (crateName && !['crate', 'self', 'super', 'std', 'core', 'alloc'].includes(crateName)) {
    const ws = resolveWorkspace(r, crateName)
    if (ws) return ws
  }
  if (spec.startsWith('crate::')) {
    const parts = spec.slice(7).split('::')
    const root = fromPath.startsWith('src/') ? 'src' : dirname(fromPath)
    for (let i = parts.length; i > 0; i--) {
      const p = parts.slice(0, i).join('/')
      if (r.byPath.has(`${root}/${p}.rs`)) return `${root}/${p}.rs`
      if (r.byPath.has(`${root}/${p}/mod.rs`)) return `${root}/${p}/mod.rs`
    }
  }
  return undefined
}

function resolveCSharp(r: Resolver, fromPath: string, spec: string): string | undefined {
  const files = r.csNamespaces.get(spec)
  if (!files) return undefined
  const other = files.filter((p) => p !== fromPath)
  return other.sort()[0]
}

function isExternalLike(spec: string): boolean {
  return (
    !spec.startsWith('.') &&
    !spec.startsWith('/') &&
    !spec.startsWith('@/') &&
    !spec.startsWith('~/')
  )
}

/** Normalise an external specifier to a package name ("@scope/pkg", "lodash", "requests"). */
export function packageName(spec: string, lang: string | undefined): string {
  if (lang === 'Python') return spec.split('.')[0]
  if (lang === 'Go') {
    const m = spec.match(/^(github\.com\/[^/]+\/[^/]+|gorm\.io\/[^/]+|[^/]+\.[^/]+\/[^/]+)/)
    return m ? m[1] : spec
  }
  if (lang === 'C#' || lang === 'Java' || lang === 'Kotlin')
    return spec.split('.').slice(0, 2).join('.')
  if (lang === 'Rust') return spec.split('::')[0]
  if (spec.startsWith('node:')) return 'node'
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/')
  return spec.split('/')[0]
}

const GO_STD = /^[a-z]+(\/[a-z]+)*$/
const RUST_STD = new Set(['std', 'core', 'alloc', 'self', 'super', 'crate'])
const PY_STD = new Set([
  'os',
  'sys',
  're',
  'json',
  'typing',
  'pathlib',
  'datetime',
  'time',
  'math',
  'random',
  'collections',
  'itertools',
  'functools',
  'logging',
  'subprocess',
  'asyncio',
  'dataclasses',
  'enum',
  'abc',
  'io',
  'shutil',
  'tempfile',
  'uuid',
  'hashlib',
  'base64',
  'copy',
  'string',
  'textwrap',
  'unittest',
  'argparse',
  'csv',
  'sqlite3',
  'threading',
  'multiprocessing',
  'queue',
  'socket',
  'http',
  'urllib',
  'email',
  'html',
  'xml',
  'struct',
  'pickle',
  'contextlib',
  'inspect',
  'traceback',
  'warnings',
  'glob',
  'fnmatch',
  'operator',
  'statistics',
  'decimal',
  'fractions',
  'secrets',
  'signal',
  'select',
  'ssl',
  'platform',
  'importlib',
  'pkgutil',
  'types',
  'weakref',
  'gc',
  'heapq',
  'bisect',
  'array',
  'zipfile',
  'tarfile',
  'gzip',
  'bz2',
  'lzma',
  'configparser',
  'getpass',
  'locale',
  'gettext',
  'calendar',
  'pprint',
  'shlex',
  'concurrent',
  'numbers',
  'zoneinfo',
  '__future__',
  'builtins',
  'ast',
  'dis',
  'code',
  'codecs',
])
const NODE_BUILTINS = new Set([
  'fs',
  'path',
  'os',
  'http',
  'https',
  'url',
  'util',
  'events',
  'stream',
  'crypto',
  'child_process',
  'buffer',
  'zlib',
  'net',
  'tls',
  'dns',
  'readline',
  'assert',
  'process',
  'querystring',
  'worker_threads',
  'cluster',
  'module',
  'timers',
  'perf_hooks',
  'async_hooks',
  'string_decoder',
  'v8',
  'vm',
  'tty',
  'node',
])

export function isStandardLibrary(pkg: string, lang: string | undefined): boolean {
  if (lang === 'Go') return GO_STD.test(pkg) && !pkg.includes('.')
  if (lang === 'Rust') return RUST_STD.has(pkg)
  if (lang === 'Python') return PY_STD.has(pkg)
  if (lang === 'C#') return pkg.startsWith('System') || pkg.startsWith('Microsoft')
  if (lang === 'Java' || lang === 'Kotlin')
    return pkg.startsWith('java.') || pkg.startsWith('javax.') || pkg.startsWith('kotlin.')
  if (lang === 'TypeScript' || lang === 'JavaScript') return NODE_BUILTINS.has(pkg)
  return false
}

/** Parse and resolve every import in the repository. */
/**
 * Assets imported by bundlers (`import logo from './logo.png'`). Ingest deliberately drops
 * these files, so they can never resolve and must not be reported as analyzer gaps.
 */
const BUILD_OUTPUT_SPECIFIER = /(^|\/)(dist|build|out|lib|es|esm|cjs|umd|target|coverage)\//i

const ASSET_SPECIFIER =
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif|mp[34]|wav|mov|webm|woff2?|ttf|otf|eot|css|scss|sass|less|styl|txt|md|csv|pdf|glb|gltf|wasm)(\?.*)?$/i

/** True when a specifier can only refer to a file inside this repository. */
function isLocalSpecifier(spec: string, lang: string | undefined, r: Resolver): boolean {
  if (ASSET_SPECIFIER.test(spec)) return false
  // `./dist/foo.cjs.js` points at build output, which ingest drops on purpose.
  if (BUILD_OUTPUT_SPECIFIER.test(spec)) return false
  if (spec.startsWith('mod:')) return true
  if (lang === 'Python') return spec.startsWith('.')
  if (spec.startsWith('.') || spec.startsWith('/')) return true
  return r.aliases.some((a) => matchAlias(a.pattern, spec) !== undefined)
}

/**
 * Parse and resolve every import in the repository.
 *
 * Files are parsed with tree-sitter where a grammar exists; anything else (and anything
 * that fails to parse) falls back to `extractSpecifiers`, so results degrade rather than
 * disappear. The returned diagnostics report how much was understood.
 */
export async function analyzeImports(files: RepoFile[]): Promise<ImportAnalysis> {
  const parsed = new Map<string, ParsedFile>()
  for (const f of files) {
    const p = await parseFile(f)
    if (p) parsed.set(f.path, p)
  }

  const r = buildResolver(files, parsed)
  const out: FileImport[] = []
  const diagnostics: ImportDiagnostics = {
    parsedFiles: parsed.size,
    regexFiles: 0,
    totalSpecifiers: 0,
    resolvedInternal: 0,
    external: 0,
    unresolvedLocal: [],
  }

  for (const f of files) {
    const lang = languageOf(f.path)
    const dir = dirname(f.path)
    const tree = parsed.get(f.path)
    let entries: ParsedImport[]
    if (tree) {
      entries = tree.imports
    } else {
      const raw = extractSpecifiers(f)
      if (raw.length) diagnostics.regexFiles++
      entries = raw.map((specifier) => ({
        specifier,
        symbols: [],
        kind: 'import' as const,
        typeOnly: false,
        line: 0,
      }))
    }

    for (const entry of entries) {
      const raw = entry.specifier
      if (!raw) continue
      diagnostics.totalSpecifiers++
      let targets: string[] = []
      switch (lang) {
        case 'TypeScript':
        case 'JavaScript':
        case 'Vue':
        case 'Svelte':
        case 'C':
        case 'C++': {
          const hit = resolveJsLike(r, dir, raw)
          if (hit) targets = [hit]
          break
        }
        case 'Python':
          targets = resolvePython(r, f.path, raw, entry.symbols)
          break
        case 'Go': {
          const hit = resolveGo(r, raw)
          if (hit) targets = [hit]
          break
        }
        case 'Rust': {
          const hit = resolveRust(r, f.path, raw)
          if (hit) targets = [hit]
          break
        }
        case 'C#': {
          const hit = resolveCSharp(r, f.path, raw) ?? resolveJvm(r, f.path, raw)
          if (hit) targets = [hit]
          break
        }
        case 'Java':
        case 'Kotlin':
        case 'Scala': {
          const hit = resolveJvm(r, f.path, raw)
          if (hit) targets = [hit]
          break
        }
        case 'Ruby':
        case 'PHP':
        case 'Dart': {
          let hit =
            raw.startsWith('.') || raw.startsWith('/') ? resolveJsLike(r, dir, raw) : undefined
          if (!hit && lang === 'Ruby') {
            hit = (r.byStem.get(joinNormalize(dir, raw)) ??
              r.byStem.get(joinNormalize('lib', raw)))?.[0]
          }
          if (!hit && lang === 'PHP') hit = resolveJvm(r, f.path, raw)
          if (hit) targets = [hit]
          break
        }
        default:
          break
      }

      const resolved = targets.filter((t) => t && t !== f.path)
      if (resolved.length) {
        for (const to of resolved) {
          diagnostics.resolvedInternal++
          out.push({
            from: f.path,
            to,
            raw,
            symbols: entry.symbols,
            kind: entry.kind,
            typeOnly: entry.typeOnly,
          })
        }
        continue
      }

      if (isLocalSpecifier(raw, lang, r)) {
        // Points inside the repository but did not resolve: an analyzer gap, not a package.
        if (diagnostics.unresolvedLocal.length < 500) {
          diagnostics.unresolvedLocal.push({ from: f.path, raw })
        }
        continue
      }
      if (isExternalLike(raw)) {
        const pkg = packageName(raw, lang)
        if (!isStandardLibrary(pkg, lang)) {
          diagnostics.external++
          out.push({
            from: f.path,
            external: pkg,
            raw,
            symbols: entry.symbols,
            kind: entry.kind,
            typeOnly: entry.typeOnly,
          })
        }
      }
    }
  }
  return { imports: out, diagnostics }
}
