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
  /** Structural facts used by the review rules; present only when requested. */
  structure?: FileStructure
}

/* ------------------------------------------------------------------ */
/* Structural facts                                                    */
/* ------------------------------------------------------------------ */

export interface FunctionInfo {
  name: string
  line: number
  endLine: number
  /** Physical lines, including the signature. */
  lines: number
  params: number
  /** Deepest block nesting inside the body. */
  maxNesting: number
  isAsync: boolean
  /** A doc comment immediately above the declaration. */
  documented: boolean
}

export interface CatchInfo {
  line: number
  /** No statements at all, or only a comment. */
  isEmpty: boolean
  /** Logs and then carries on, so the caller never learns the operation failed. */
  swallows: boolean
  bindsError: boolean
}

export interface CallInfo {
  /** The callee as written: `eval`, `res.send`, `cursor.execute`. */
  name: string
  line: number
  /** Argument source text, trimmed; used to spot interpolation. */
  args: string
}

export interface CommentInfo {
  line: number
  text: string
}

export interface JsxAttr {
  element: string
  name: string
  line: number
  value?: string
}

export interface FileStructure {
  lines: number
  functions: FunctionInfo[]
  catches: CatchInfo[]
  calls: CallInfo[]
  comments: CommentInfo[]
  /** JSX/TSX elements with the attribute names present on each. */
  elements: { name: string; line: number; attrs: string[] }[]
  attributes: JsxAttr[]
  /** Explicit `any` type annotations (TypeScript). */
  anyAnnotations: number
  /** Non-empty string literals, for placeholder and hard-coded URL checks. */
  strings: { line: number; value: string }[]
  maxNesting: number
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
  // Single-file components: the script blocks are extracted and parsed as TypeScript.
  '.vue': 'typescript',
  '.svelte': 'typescript',
  '.astro': 'typescript',
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
  endPosition: { row: number }
  namedChildCount: number
  childCount: number
  namedChild(i: number): AnyNode | null
  child(i: number): AnyNode | null
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

/* ------------------------------------------------------------------ */
/* Structure extraction                                                */
/* ------------------------------------------------------------------ */

/**
 * Node types that introduce a function scope.
 *
 * Every grammar names these differently, and a missing name means the structural rules
 * silently do nothing for that language — which is worse than not supporting it, because
 * the review then reports a clean result. `tests/parse.test.ts` locks the whole matrix down.
 */
const FUNCTION_NODES = new Set([
  // ECMAScript
  'function_declaration',
  'function_expression',
  'function',
  'arrow_function',
  'method_definition',
  'generator_function_declaration',
  // Python
  'function_definition',
  // Rust
  'function_item',
  // C#, Java, Kotlin, Scala
  'method_declaration',
  'constructor_declaration',
  'local_function_statement',
  'function_declaration_statement',
  // Ruby
  'method',
  'singleton_method',
  // PHP
  'function_definition_statement',
])

/** Node types that add a level of nesting worth counting. */
const NESTING_NODES = new Set([
  'if_statement',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'try_statement',
  'with_statement',
  'match_statement',
  'case_clause',
  'catch_clause',
  'conditional_expression',
  'elif_clause',
])

const CATCH_NODES = new Set(['catch_clause', 'except_clause', 'rescue', 'catch_block'])
const CALL_NODES = new Set([
  'call_expression', // TypeScript, JavaScript, Rust, Go, C++
  'call', // Python, Ruby
  'new_expression',
  'method_invocation', // Java
  'invocation_expression', // C#
  'object_creation_expression', // C#, PHP
  'function_call_expression', // PHP
  'member_call_expression', // PHP
  'scoped_call_expression', // PHP
])
const STRING_NODES = new Set([
  'string',
  'string_literal',
  'template_string',
  'interpreted_string_literal',
])

/** Identifier-ish node types, used when a grammar exposes no `name` field. */
const IDENTIFIER_NODES = new Set([
  'identifier',
  'simple_identifier',
  'property_identifier',
  'field_identifier',
  'type_identifier',
  'constant',
  'name',
])

function nodeName(n: AnyNode): string {
  const named = n.childForFieldName('name')
  if (named) return named.text
  // Kotlin and Ruby expose the name as a plain identifier child rather than a field.
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i)
    if (c && IDENTIFIER_NODES.has(c.type)) return c.text
  }
  return 'anonymous'
}

/**
 * The callee as a reader would write it: `eval`, `db.query`, `Command::new`.
 *
 * Grammars disagree about which field holds it — `function` in most, `method` in Ruby,
 * `name` plus `object` in Java and PHP — so each is tried in turn.
 */
function calleeName(n: AnyNode): string | undefined {
  const direct =
    n.childForFieldName('function') ??
    n.childForFieldName('method') ??
    n.childForFieldName('constructor') ??
    n.childForFieldName('type')
  if (direct) return direct.text

  // Java `method_invocation`, PHP `member_call_expression`: object + name.
  const name = n.childForFieldName('name')
  if (name) {
    const receiver = n.childForFieldName('object') ?? n.childForFieldName('receiver')
    return receiver ? `${receiver.text}.${name.text}` : name.text
  }
  const receiverOnly = n.childForFieldName('receiver')
  if (receiverOnly) return receiverOnly.text

  // Kotlin exposes no callee field: the first child of a call expression is the callee,
  // and the argument list follows it.
  const first = n.namedChild(0)
  if (first && first.type !== 'call_suffix' && first.type !== 'value_arguments') return first.text
  return undefined
}

function countParams(n: AnyNode): number {
  const params = n.childForFieldName('parameters') ?? n.childForFieldName('parameter_list')
  if (!params) return 0
  let count = 0
  for (let i = 0; i < params.namedChildCount; i++) {
    const c = params.namedChild(i)
    if (c && c.type !== 'comment') count++
  }
  return count
}

function maxNestingWithin(node: AnyNode, depth = 0): number {
  let deepest = depth
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)
    if (!c) continue
    // A nested function starts its own budget rather than inheriting this one.
    if (FUNCTION_NODES.has(c.type)) continue
    const next = NESTING_NODES.has(c.type) ? depth + 1 : depth
    deepest = Math.max(deepest, maxNestingWithin(c, next))
  }
  return deepest
}

/**
 * Walk a parsed file once and record the facts the review rules need.
 *
 * Everything here is a plain measurement — how long a function is, whether a catch block
 * rethrows, which attributes a JSX element carries. Judging those facts is the rules'
 * job, which keeps the judgement reviewable and this function boring.
 */
function extractStructure(root: AnyNode, source: string, grammar: string): FileStructure {
  const structure: FileStructure = {
    lines: source.split('\n').length,
    functions: [],
    catches: [],
    calls: [],
    comments: [],
    elements: [],
    attributes: [],
    anyAnnotations: 0,
    strings: [],
    maxNesting: 0,
  }
  const commentLines = new Set<number>()

  walk(root, (n) => {
    if (n.type === 'comment' || n.type === 'line_comment' || n.type === 'block_comment') {
      const text = n.text.replace(/^\s*(\/\/+|#+|\/\*+|\*+)\s?/gm, '').replace(/\*\/\s*$/, '')
      structure.comments.push({ line: line(n), text: text.trim() })
      for (let r = n.startPosition.row; r <= n.endPosition.row; r++) commentLines.add(r + 1)
      return false
    }

    if (FUNCTION_NODES.has(n.type)) {
      const body = n.childForFieldName('body')
      const startLine = line(n)
      const endLine = n.endPosition.row + 1
      const above = startLine - 1
      // Python and Ruby document a function with a string as the first statement in the
      // body, not with a comment above the signature.
      const firstStatement = body?.namedChild(0)
      const hasDocstring =
        !!firstStatement &&
        (STRING_NODES.has(firstStatement.type) ||
          (firstStatement.type === 'expression_statement' &&
            !!firstStatement.namedChild(0) &&
            STRING_NODES.has(firstStatement.namedChild(0)!.type)))
      structure.functions.push({
        name: nodeName(n),
        line: startLine,
        endLine,
        lines: endLine - startLine + 1,
        params: countParams(n),
        maxNesting: body ? maxNestingWithin(body) : 0,
        isAsync: /^\s*(export\s+)?(default\s+)?async\b/.test(n.text),
        documented: hasDocstring || commentLines.has(above) || commentLines.has(above - 1),
      })
      return
    }

    if (CATCH_NODES.has(n.type)) {
      const body = n.childForFieldName('body') ?? n
      const inner = body.text.replace(/^[\s{}:]*|[\s{}]*$/g, '')
      const withoutComments = inner
        .split('\n')
        .filter((l) => !/^\s*(\/\/|#|\*|\/\*)/.test(l))
        .join('\n')
        .trim()
      const isEmpty = withoutComments === '' || /^(pass|;)$/.test(withoutComments)
      const rethrows = /\b(throw|raise)\b/.test(withoutComments)
      const returnsOrHandles =
        /\b(return|res\.|reply\.|next\(|reject\(|abort|exit|process\.exit)/.test(withoutComments)
      const logsOnly =
        /\b(console\.(log|error|warn)|logger?\.|print\(|log\.)/.test(withoutComments) &&
        !rethrows &&
        !returnsOrHandles
      structure.catches.push({
        line: line(n),
        isEmpty,
        swallows: isEmpty || logsOnly,
        bindsError: !!(n.childForFieldName('parameter') ?? n.childForFieldName('value')),
      })
      return
    }

    if (CALL_NODES.has(n.type)) {
      const callee = calleeName(n)
      const args =
        n.childForFieldName('arguments') ??
        n.childForFieldName('argument_list') ??
        n.childForFieldName('value_arguments') ??
        n.descendantsOfType(['value_arguments', 'arguments', 'argument_list'])[0]
      if (callee) {
        structure.calls.push({
          name: callee.replace(/\s+/g, '').slice(0, 80),
          line: line(n),
          args: (args?.text ?? '').replace(/\s+/g, ' ').slice(0, 400),
        })
      }
      return
    }

    if (n.type === 'jsx_opening_element' || n.type === 'jsx_self_closing_element') {
      const nameNode = n.childForFieldName('name')
      const attrs: string[] = []
      for (const a of n.descendantsOfType('jsx_attribute')) {
        const an = a.childForFieldName('name') ?? a.namedChild(0)
        if (!an) continue
        attrs.push(an.text)
        structure.attributes.push({
          element: nameNode?.text ?? '?',
          name: an.text,
          line: line(a),
          value: a.namedChild(1)?.text?.slice(0, 120),
        })
      }
      structure.elements.push({ name: nameNode?.text ?? '?', line: line(n), attrs })
      return
    }

    if (grammar !== 'python' && n.type === 'predefined_type' && n.text === 'any') {
      structure.anyAnnotations++
      return
    }

    if (STRING_NODES.has(n.type)) {
      const value = unquote(n.text)
      if (value.length > 1 && value.length < 300) structure.strings.push({ line: line(n), value })
      return false
    }
    return
  })

  structure.maxNesting = maxNestingWithin(root)
  return structure
}

const SFC_EXTENSIONS = /\.(vue|svelte|astro)$/i
const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
const ASTRO_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/

/**
 * Pull the script out of a single-file component so it can be parsed as TypeScript.
 *
 * Blank lines replace the template and style sections, which keeps every reported line
 * number matching the original file. Returns undefined when there is no script to read.
 */
export function extractComponentScript(path: string, content: string): string | undefined {
  if (!SFC_EXTENSIONS.test(path)) return undefined
  const blank = (text: string) => text.replace(/[^\n]/g, '')
  if (/\.astro$/i.test(path)) {
    const m = content.match(ASTRO_FRONTMATTER)
    return m ? blank(content.slice(0, m.index! + 4)) + m[1] : undefined
  }
  let out = ''
  let cursor = 0
  let found = false
  SCRIPT_BLOCK.lastIndex = 0
  for (const m of content.matchAll(SCRIPT_BLOCK)) {
    // m[1] is the script body; everything before it in the match is the opening tag.
    const bodyStart = m.index! + m[0].length - m[1].length - '</script>'.length
    found = true
    out += blank(content.slice(cursor, bodyStart)) + m[1]
    cursor = bodyStart + m[1].length
  }
  if (!found) return undefined
  return out + blank(content.slice(cursor))
}

/**
 * Parse one file's imports. Returns undefined when no grammar applies, the file is too
 * large, or parsing fails — callers fall back to the regex extractor.
 */
export interface ParseOptions {
  /** Also collect the structural facts the review rules need. */
  structure?: boolean
}

export async function parseFile(
  file: RepoFile,
  options: ParseOptions = {},
): Promise<ParsedFile | undefined> {
  if (!file.content || file.content.length > MAX_PARSE_BYTES) return undefined
  const grammar = grammarFor(file.path)
  if (!grammar) return undefined
  const extract = EXTRACTORS[grammar]
  if (!extract) return undefined
  let source = file.content
  if (SFC_EXTENSIONS.test(file.path)) {
    const script = extractComponentScript(file.path, file.content)
    if (script === undefined) return { imports: [] }
    source = script
  }
  const parser = await getParser(grammar)
  if (!parser) return undefined
  let tree: AnyTree | null = null
  try {
    tree = parser.parse(source)
    if (!tree) return undefined
    const parsed = extract(tree.rootNode)
    if (options.structure) parsed.structure = extractStructure(tree.rootNode, source, grammar)
    return parsed
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

/**
 * Parse every file once. Both the import resolver and the review rules read the result, so
 * a scan never parses the same file twice.
 */
export async function parseAll(
  files: RepoFile[],
  options: ParseOptions = {},
): Promise<Map<string, ParsedFile>> {
  const out = new Map<string, ParsedFile>()
  for (const f of files) {
    const parsed = await parseFile(f, options)
    if (parsed) out.set(f.path, parsed)
  }
  return out
}

/** True when at least one grammar loaded successfully (used for diagnostics). */
export function parsingAvailable(): boolean {
  return !disabled && languages.size > 0
}
