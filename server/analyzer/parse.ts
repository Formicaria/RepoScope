import { createRequire } from 'node:module'
import path from 'node:path'
import type { RepoFile } from '../../shared/types.js'
import { languageOf } from './detect.js'

/**
 * Syntax-tree backed import extraction.
 *
 * Regular expressions get imports approximately right and fail in the places that matter:
 * multi-line import lists, `import type`, re-exports, strings inside comments, and
 * `from . import x` in Python. This module parses the file instead, using tree-sitter
 * grammars compiled to WebAssembly, and falls back to the regex extractor in
 * `imports.ts` whenever a grammar is unavailable or a parse fails, so a scan never
 * depends on it.
 */

export interface ParsedImport {
  /** The literal specifier as written: './foo', 'react', 'app.core'. */
  specifier: string
  /** Named bindings pulled from the specifier ('*' for a wildcard/namespace import). */
  symbols: string[]
  kind: 'import' | 'require' | 'dynamic' | 'reexport' | 'include' | 'module'
  /** TypeScript `import type` / Python `if TYPE_CHECKING` — a weaker dependency. */
  typeOnly: boolean
  /** 1-based line, for diagnostics. */
  line: number
}

export interface ParsedFile {
  imports: ParsedImport[]
  /** Java/Kotlin/C#/PHP package or namespace declared by this file, when it has one. */
  packageName?: string
}

/** Grammar file (in tree-sitter-wasms/out) per RepoScope language, plus per-extension overrides. */
const GRAMMAR_BY_LANGUAGE: Record<string, string> = {
  TypeScript: 'typescript',
  JavaScript: 'javascript',
  Python: 'python',
  Go: 'go',
  Rust: 'rust',
  'C#': 'c_sharp',
  Java: 'java',
  Kotlin: 'kotlin',
  Ruby: 'ruby',
  PHP: 'php',
  Scala: 'scala',
  C: 'c',
  'C++': 'cpp',
}

const GRAMMAR_BY_EXT: Record<string, string> = {
  '.tsx': 'tsx',
  '.jsx': 'tsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.mts': 'typescript',
  '.cts': 'typescript',
}

export function grammarFor(filePath: string): string | undefined {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  if (GRAMMAR_BY_EXT[ext]) return GRAMMAR_BY_EXT[ext]
  const lang = languageOf(filePath)
  return lang ? GRAMMAR_BY_LANGUAGE[lang] : undefined
}

/* ------------------------------------------------------------------ */
/* Parser pool                                                         */
/* ------------------------------------------------------------------ */

type AnyNode = {
  type: string
  text: string
  startIndex: number
  startPosition: { row: number }
  namedChildCount: number
  namedChild(i: number): AnyNode | null
  childForFieldName(name: string): AnyNode | null
  descendantsOfType(types: string | string[]): AnyNode[]
}
type AnyTree = { rootNode: AnyNode; delete(): void }
type AnyParser = {
  setLanguage(l: unknown): void
  parse(src: string): AnyTree | null
  setTimeoutMicros(n: number): void
  delete(): void
}

let initPromise: Promise<unknown> | undefined
let ParserCtor: (new () => AnyParser) & {
  init(): Promise<void>
  Language: { load(p: string): Promise<unknown> }
}
const languages = new Map<string, unknown>()
const parsers = new Map<string, AnyParser>()
let disabled = false

const PARSE_TIMEOUT_MICROS = 3_000_000
/** Files above this are left to the regex extractor; parsing them is rarely worth the time. */
export const MAX_PARSE_BYTES = 400_000

function wasmPath(grammar: string): string {
  const require = createRequire(import.meta.url)
  const pkg = require.resolve('tree-sitter-wasms/package.json')
  return path.join(path.dirname(pkg), 'out', `tree-sitter-${grammar}.wasm`)
}

async function getParser(grammar: string): Promise<AnyParser | undefined> {
  if (disabled) return undefined
  // Escape hatch for benchmarking the regex fallback and for environments where the
  // WebAssembly grammars cannot be loaded.
  if (process.env.REPOSCOPE_NO_PARSE) {
    disabled = true
    return undefined
  }
  try {
    if (!initPromise) {
      initPromise = (async () => {
        const mod = (await import('web-tree-sitter')) as unknown as Record<string, unknown>
        ParserCtor = (mod.default ?? mod) as typeof ParserCtor
        await ParserCtor.init()
      })()
    }
    await initPromise
    const cached = parsers.get(grammar)
    if (cached) return cached
    if (!languages.has(grammar)) {
      languages.set(grammar, await ParserCtor.Language.load(wasmPath(grammar)))
    }
    const parser = new ParserCtor()
    parser.setLanguage(languages.get(grammar))
    parser.setTimeoutMicros(PARSE_TIMEOUT_MICROS)
    parsers.set(grammar, parser)
    return parser
  } catch {
    // No grammars bundled, an ABI mismatch, or a corrupt wasm file: fall back for the
    // rest of this process rather than retrying per file.
    disabled = true
    return undefined
  }
}

/** Release cached parsers (used by long-running processes and tests). */
export function disposeParsers() {
  for (const p of parsers.values()) {
    try {
      p.delete()
    } catch {
      /* already gone */
    }
  }
  parsers.clear()
  languages.clear()
}

/* ------------------------------------------------------------------ */
/* Per-language extraction                                             */
/* ------------------------------------------------------------------ */

function unquote(s: string): string {
  return s.replace(/^[rbuf]*['"`]/i, '').replace(/['"`]$/, '')
}

function walk(node: AnyNode, visit: (n: AnyNode) => boolean | void) {
  const stack: AnyNode[] = [node]
  while (stack.length) {
    const n = stack.pop()!
    if (visit(n) === false) continue
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i)
      if (c) stack.push(c)
    }
  }
}

function line(n: AnyNode): number {
  return n.startPosition.row + 1
}

/** ECMAScript family: TypeScript, JavaScript, TSX. */
function extractJsLike(root: AnyNode): ParsedFile {
  const imports: ParsedImport[] = []
  walk(root, (n) => {
    switch (n.type) {
      case 'import_statement':
      case 'export_statement': {
        const source = n.childForFieldName('source')
        if (!source) return
        const clause = n.namedChild(0)
        const typeOnly =
          /^(import|export)\s+type\b/.test(n.text) ||
          (clause?.type === 'import_clause' && /^\s*type\b/.test(clause.text))
        imports.push({
          specifier: unquote(source.text),
          symbols: jsSymbols(n),
          kind: n.type === 'export_statement' ? 'reexport' : 'import',
          typeOnly,
          line: line(n),
        })
        return
      }
      case 'call_expression': {
        const fn = n.childForFieldName('function')
        const args = n.childForFieldName('arguments')
        if (!fn || !args) return
        const isRequire = fn.type === 'identifier' && fn.text === 'require'
        const isDynamic = fn.type === 'import'
        if (!isRequire && !isDynamic) return
        const str = args.namedChild(0)
        if (!str || !str.type.includes('string')) return
        imports.push({
          specifier: unquote(str.text),
          symbols: [],
          kind: isDynamic ? 'dynamic' : 'require',
          typeOnly: false,
          line: line(n),
        })
        return
      }
      // `import fs = require('fs')`
      case 'import_require_clause': {
        const src = n.childForFieldName('source')
        if (src) {
          imports.push({
            specifier: unquote(src.text),
            symbols: [],
            kind: 'require',
            typeOnly: false,
            line: line(n),
          })
        }
        return
      }
      default:
        return
    }
  })
  return { imports }
}

function jsSymbols(stmt: AnyNode): string[] {
  const out: string[] = []
  for (const spec of stmt.descendantsOfType(['import_specifier', 'export_specifier'])) {
    const name = spec.childForFieldName('name')
    if (name) out.push(name.text)
  }
  for (const ns of stmt.descendantsOfType(['namespace_import', 'namespace_export'])) {
    void ns
    out.push('*')
  }
  const clause = stmt.namedChild(0)
  if (clause?.type === 'import_clause') {
    const first = clause.namedChild(0)
    if (first?.type === 'identifier') out.push('default')
  }
  if (/^export\s+\*/.test(stmt.text)) out.push('*')
  return [...new Set(out)]
}

/** Python: import a.b, from .rel import x, from pkg import y. */
function extractPython(root: AnyNode): ParsedFile {
  const imports: ParsedImport[] = []
  walk(root, (n) => {
    if (n.type === 'import_statement') {
      for (const name of n.descendantsOfType(['dotted_name', 'aliased_import'])) {
        const target = name.type === 'aliased_import' ? name.childForFieldName('name') : name
        if (target?.type === 'dotted_name') {
          imports.push({
            specifier: target.text,
            symbols: [],
            kind: 'import',
            typeOnly: false,
            line: line(n),
          })
        }
      }
      return false
    }
    if (n.type === 'import_from_statement') {
      const moduleNode = n.childForFieldName('module_name')
      if (!moduleNode) return false
      let specifier: string
      if (moduleNode.type === 'relative_import') {
        // ".", "..", ".pkg.sub" — the dots are an import_prefix child.
        const prefix = moduleNode.namedChild(0)
        const dots = prefix && prefix.type === 'import_prefix' ? prefix.text : '.'
        const rest = moduleNode.descendantsOfType('dotted_name')[0]
        specifier = dots + (rest ? rest.text : '')
      } else {
        specifier = moduleNode.text
      }
      const symbols: string[] = []
      // web-tree-sitter hands out a fresh wrapper object per access, so nodes are compared
      // by source position rather than identity.
      const moduleStart = moduleNode.startIndex
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i)
        if (!c || c.startIndex === moduleStart) continue
        if (c.type === 'dotted_name') symbols.push(c.text)
        else if (c.type === 'aliased_import') {
          const nm = c.childForFieldName('name')
          if (nm) symbols.push(nm.text)
        } else if (c.type === 'wildcard_import') symbols.push('*')
      }
      imports.push({ specifier, symbols, kind: 'import', typeOnly: false, line: line(n) })
      return false
    }
    return
  })
  return { imports }
}

/** Go: import blocks and single imports. */
function extractGo(root: AnyNode): ParsedFile {
  const imports: ParsedImport[] = []
  for (const spec of root.descendantsOfType('import_spec')) {
    const p = spec.childForFieldName('path')
    if (p) {
      imports.push({
        specifier: unquote(p.text),
        symbols: [],
        kind: 'import',
        typeOnly: false,
        line: line(spec),
      })
    }
  }
  return { imports }
}

/** Rust: use paths and mod declarations. */
function extractRust(root: AnyNode): ParsedFile {
  const imports: ParsedImport[] = []
  walk(root, (n) => {
    if (n.type === 'use_declaration') {
      const arg = n.childForFieldName('argument')
      if (arg) {
        // Keep the leading path segments; the resolver walks them itself.
        const text = arg.text.replace(/\s+/g, '')
        imports.push({
          specifier: text.split(/[{,]/)[0].replace(/::$/, ''),
          symbols: [],
          kind: 'import',
          typeOnly: false,
          line: line(n),
        })
      }
      return false
    }
    if (n.type === 'mod_item') {
      const name = n.childForFieldName('name')
      // `mod foo;` (declaration) pulls in another file; `mod foo { … }` does not.
      const hasBody = !!n.childForFieldName('body')
      if (name && !hasBody) {
        imports.push({
          specifier: 'mod:' + name.text,
          symbols: [],
          kind: 'module',
          typeOnly: false,
          line: line(n),
        })
      }
      return
    }
    return
  })
  return { imports }
}

/** C#: using directives and the file's namespace. */
function extractCSharp(root: AnyNode): ParsedFile {
  const imports: ParsedImport[] = []
  let packageName: string | undefined
  walk(root, (n) => {
    if (n.type === 'using_directive') {
      const name = n.descendantsOfType(['qualified_name', 'identifier'])[0]
      if (name) {
        imports.push({
          specifier: name.text,
          symbols: [],
          kind: 'import',
          typeOnly: false,
          line: line(n),
        })
      }
      return false
    }
    if (
      (n.type === 'namespace_declaration' || n.type === 'file_scoped_namespace_declaration') &&
      !packageName
    ) {
      const name = n.childForFieldName('name')
      if (name) packageName = name.text
    }
    return
  })
  return { imports, packageName }
}

/** Java / Kotlin / Scala: imports plus the declared package, which enables internal resolution. */
function extractJvm(root: AnyNode): ParsedFile {
  const imports: ParsedImport[] = []
  let packageName: string | undefined
  walk(root, (n) => {
    if (n.type === 'import_declaration' || n.type === 'import_header') {
      const ident = n.descendantsOfType([
        'scoped_identifier',
        'identifier',
        'qualified_identifier',
        'stable_identifier',
      ])[0]
      const raw = (ident ?? n).text
        .replace(/^import\s+/, '')
        .replace(/^static\s+/, '')
        .replace(/[;\s]+$/, '')
      if (raw) {
        imports.push({
          specifier: raw.replace(/\.\*$/, ''),
          symbols: raw.endsWith('.*') ? ['*'] : [],
          kind: 'import',
          typeOnly: false,
          line: line(n),
        })
      }
      return false
    }
    if ((n.type === 'package_declaration' || n.type === 'package_header') && !packageName) {
      const raw = n.text
        .replace(/^package\s+/, '')
        .replace(/[;\s]+$/, '')
        .trim()
      if (raw) packageName = raw
    }
    return
  })
  return { imports, packageName }
}

/** Ruby: require / require_relative calls. */
function extractRuby(root: AnyNode): ParsedFile {
  const imports: ParsedImport[] = []
  for (const call of root.descendantsOfType('call')) {
    const method = call.childForFieldName('method')
    if (!method || !/^require(_relative)?$/.test(method.text)) continue
    const args = call.childForFieldName('arguments')
    const str = args?.descendantsOfType('string')[0]
    if (str) {
      imports.push({
        specifier: unquote(str.text),
        symbols: [],
        kind: method.text === 'require_relative' ? 'include' : 'import',
        typeOnly: false,
        line: line(call),
      })
    }
  }
  return { imports }
}

/** PHP: use statements plus require/include of paths. */
function extractPhp(root: AnyNode): ParsedFile {
  const imports: ParsedImport[] = []
  let packageName: string | undefined
  walk(root, (n) => {
    if (n.type === 'namespace_use_declaration') {
      for (const c of n.descendantsOfType(['qualified_name', 'namespace_name'])) {
        imports.push({
          specifier: c.text.replace(/\\/g, '/'),
          symbols: [],
          kind: 'import',
          typeOnly: false,
          line: line(n),
        })
      }
      return false
    }
    if (n.type === 'namespace_definition' && !packageName) {
      const name = n.childForFieldName('name')
      if (name) packageName = name.text.replace(/\\/g, '/')
    }
    if (n.type === 'include_expression' || n.type === 'require_expression') {
      const str = n.descendantsOfType('string')[0]
      if (str) {
        imports.push({
          specifier: unquote(str.text),
          symbols: [],
          kind: 'include',
          typeOnly: false,
          line: line(n),
        })
      }
      return false
    }
    return
  })
  return { imports, packageName }
}

/** C / C++: local #include "…" only; system headers are noise on an architecture map. */
function extractC(root: AnyNode): ParsedFile {
  const imports: ParsedImport[] = []
  for (const inc of root.descendantsOfType('preproc_include')) {
    const p = inc.childForFieldName('path')
    if (p && p.type === 'string_literal') {
      imports.push({
        specifier: './' + unquote(p.text),
        symbols: [],
        kind: 'include',
        typeOnly: false,
        line: line(inc),
      })
    }
  }
  return { imports }
}

const EXTRACTORS: Record<string, (root: AnyNode) => ParsedFile> = {
  typescript: extractJsLike,
  tsx: extractJsLike,
  javascript: extractJsLike,
  python: extractPython,
  go: extractGo,
  rust: extractRust,
  c_sharp: extractCSharp,
  java: extractJvm,
  kotlin: extractJvm,
  scala: extractJvm,
  ruby: extractRuby,
  php: extractPhp,
  c: extractC,
  cpp: extractC,
}

/**
 * Parse one file's imports. Returns undefined when no grammar applies, the file is too
 * large, or parsing fails — callers fall back to the regex extractor.
 */
export async function parseFile(file: RepoFile): Promise<ParsedFile | undefined> {
  if (!file.content || file.content.length > MAX_PARSE_BYTES) return undefined
  const grammar = grammarFor(file.path)
  if (!grammar) return undefined
  const extract = EXTRACTORS[grammar]
  if (!extract) return undefined
  const parser = await getParser(grammar)
  if (!parser) return undefined
  let tree: AnyTree | null = null
  try {
    tree = parser.parse(file.content)
    if (!tree) return undefined
    return extract(tree.rootNode)
  } catch {
    return undefined
  } finally {
    try {
      tree?.delete()
    } catch {
      /* already gone */
    }
  }
}

/** True when at least one grammar loaded successfully (used for diagnostics). */
export function parsingAvailable(): boolean {
  return !disabled && languages.size > 0
}
