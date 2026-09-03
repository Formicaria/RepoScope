import type { RepoFile } from '../../shared/types.js'
import { languageOf } from './detect.js'
import { basename, dirname, joinNormalize, stripExt } from './paths.js'

export interface FileImport {
  from: string
  /** Resolved repository path (internal import). */
  to?: string
  /** Package / module name (external import). */
  external?: string
  raw: string
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
  /** tsconfig / vite style aliases: "@/..." -> "src/...", scoped to the folder holding the tsconfig. */
  aliases: { prefix: string; target: string; base: string }[]
  goModule?: string
  csNamespaces: Map<string, string[]>
  pyModules: Map<string, string>
}

function buildResolver(files: RepoFile[]): Resolver {
  const byPath = new Set(files.map((f) => f.path))
  const byStem = new Map<string, string[]>()
  const csNamespaces = new Map<string, string[]>()
  const pyModules = new Map<string, string>()
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
    if (f.path.endsWith('.cs') && f.content) {
      const ns = f.content.match(/^\s*namespace\s+([\w.]+)/m)
      if (ns) {
        const l = csNamespaces.get(ns[1]) ?? []
        l.push(f.path)
        csNamespaces.set(ns[1], l)
      }
    }
    if (basename(f.path) === 'go.mod' && !f.path.includes('/') && f.content) {
      goModule = f.content.match(/^module\s+(\S+)/m)?.[1]
    }
    if (/(^|\/)tsconfig(\.\w+)?\.json$/.test(f.path) && f.content) {
      try {
        const cfg = JSON.parse(stripJsonComments(f.content))
        const base = dirname(f.path)
        const baseUrl: string = cfg.compilerOptions?.baseUrl ?? '.'
        const paths: Record<string, string[]> = cfg.compilerOptions?.paths ?? {}
        for (const [k, v] of Object.entries(paths)) {
          if (!v?.[0]) continue
          aliases.push({
            prefix: k.replace(/\*$/, ''),
            target: joinNormalize(base, joinNormalize(baseUrl, v[0].replace(/\*$/, ''))),
            base,
          })
        }
      } catch {
        /* ignore malformed tsconfig */
      }
    }
  }
  // Fallbacks for the common "@/" and "~/" conventions when no tsconfig declares them.
  if ([...byPath].some((p) => p.startsWith('src/'))) {
    aliases.push({ prefix: '@/', target: 'src', base: '' })
    aliases.push({ prefix: '~/', target: 'src', base: '' })
  } else {
    aliases.push({ prefix: '@/', target: '', base: '' })
  }
  return { byPath, byStem, aliases, goModule, csNamespaces, pyModules }
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

function resolveJsLike(r: Resolver, fromDir: string, spec: string): string | undefined {
  let target: string | undefined
  if (spec.startsWith('.')) target = joinNormalize(fromDir, spec)
  else {
    // Prefer the alias declared closest to the importing file (monorepos declare "@/" per package).
    const alias = r.aliases
      .filter(
        (a) =>
          spec.startsWith(a.prefix) &&
          (a.base === '' || fromDir === a.base || fromDir.startsWith(a.base + '/')),
      )
      .sort((a, b) => b.base.length - a.base.length || b.prefix.length - a.prefix.length)[0]
    if (alias) target = joinNormalize(alias.target, spec.slice(alias.prefix.length))
    else if (spec.startsWith('/')) target = spec.slice(1)
  }
  if (target === undefined) return undefined
  target = target.replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx')
  if (r.byPath.has(target)) return target
  const direct = r.byStem.get(stripExt(target)) ?? r.byStem.get(target)
  if (direct?.length) return direct[0]
  for (const ext of JS_EXTS) {
    if (r.byPath.has(target + ext)) return target + ext
    if (r.byPath.has(target + '/index' + ext)) return target + '/index' + ext
  }
  // "./foo.js" -> "./foo.ts" is handled above; also allow "./foo" -> "./foo.d.ts"-less variants
  return undefined
}

function resolvePython(r: Resolver, fromPath: string, spec: string): string | undefined {
  if (spec.startsWith('.')) {
    // relative: ".foo" (same package), "..bar"
    const dots = spec.match(/^\.+/)![0].length
    let dir = dirname(fromPath)
    for (let i = 1; i < dots; i++) dir = dirname(dir)
    const rest = spec.slice(dots).replace(/\./g, '/')
    const cand = rest ? joinNormalize(dir, rest) : dir
    if (r.byPath.has(cand + '.py')) return cand + '.py'
    if (r.byPath.has(cand + '/__init__.py')) return cand + '/__init__.py'
    // "from . import x" -> x may be a module in the same package
    return undefined
  }
  const parts = spec.split('.')
  for (let i = parts.length; i > 0; i--) {
    const mod = parts.slice(0, i).join('.')
    const hit = r.pyModules.get(mod)
    if (hit) return hit
  }
  return undefined
}

function resolveGo(r: Resolver, spec: string): string | undefined {
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
export function analyzeImports(files: RepoFile[]): FileImport[] {
  const r = buildResolver(files)
  const out: FileImport[] = []
  for (const f of files) {
    const lang = languageOf(f.path)
    const specs = extractSpecifiers(f)
    const dir = dirname(f.path)
    for (const raw of specs) {
      let to: string | undefined
      switch (lang) {
        case 'TypeScript':
        case 'JavaScript':
        case 'Vue':
        case 'Svelte':
        case 'C':
        case 'C++':
          to = resolveJsLike(r, dir, raw)
          break
        case 'Python':
          to = resolvePython(r, f.path, raw)
          break
        case 'Go':
          to = resolveGo(r, raw)
          break
        case 'Rust':
          to = resolveRust(r, f.path, raw)
          break
        case 'C#':
          to = resolveCSharp(r, f.path, raw)
          break
        case 'Ruby':
        case 'PHP':
        case 'Dart':
          to = raw.startsWith('.') || raw.startsWith('/') ? resolveJsLike(r, dir, raw) : undefined
          if (!to && lang === 'Ruby') {
            const cand =
              r.byStem.get(joinNormalize(dir, raw)) ?? r.byStem.get(joinNormalize('lib', raw))
            to = cand?.[0]
          }
          break
        default:
          break
      }
      if (to && to !== f.path) out.push({ from: f.path, to, raw })
      else if (!to && isExternalLike(raw) && !raw.startsWith('mod:')) {
        const pkg = packageName(raw, lang)
        if (!isStandardLibrary(pkg, lang)) out.push({ from: f.path, external: pkg, raw })
      }
    }
  }
  return out
}
