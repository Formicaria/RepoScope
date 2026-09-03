import type {
  Dependency,
  Module,
  NodeType,
  ProjectEdge,
  ProjectNode,
  RepoFile,
} from '../../shared/types.js'
import { aggregateEdges, topLevelIds } from '../../shared/graph.js'
import {
  CODE_LANGUAGES,
  countLines,
  languageOf,
  PYPI_IMPORT_NAMES,
  type RouteInfo,
  type StorageInfo,
} from './detect.js'
import type { FileImport } from './imports.js'
import { basename, dirname, slug } from './paths.js'

/** Folders that only group other folders — we look one level deeper inside them. */
const CONTAINER_DIRS = new Set([
  'src',
  'lib',
  'app',
  'apps',
  'packages',
  'services',
  'internal',
  'pkg',
  'cmd',
  'source',
  'server',
  'client',
  'backend',
  'frontend',
  'web',
  'api',
  'modules',
])

const TEST_DIR = /^(tests?|__tests__|spec|specs|e2e|cypress|playwright|testing|test_.*|.*_test)$/i
const DOCS_DIR = /^(docs?|documentation|examples?|samples?)$/i
const CONFIG_DIR =
  /^(\.github|\.circleci|\.gitlab|config|configs|\.config|\.devcontainer|\.husky|deploy|deployment|k8s|helm|terraform|infra|infrastructure|ci|scripts?|tools?|\.storybook)$/i
const API_DIR =
  /^(api|apis|routes?|routers?|controllers?|handlers?|endpoints?|graphql|resolvers?|rest|grpc|rpc|web|http|middlewares?)$/i
const SERVICE_DIR =
  /^(services?|workers?|jobs?|tasks?|core|domain|usecases?|use-cases|application|engine|processors?|pipelines?|logic|business|managers?|orchestrat\w+|agents?)$/i
const DB_DIR =
  /^(db|database|models?|entities|entity|prisma|migrations?|repositor(y|ies)|dal|persistence|schema|schemas|orm|data|storage|stores?)$/i
const COMPONENT_DIR =
  /^(components?|ui|views?|pages?|screens?|widgets?|layouts?|containers?|features?|hooks?|composables|templates?|theme|styles?|assets?|public|static)$/i
const UTIL_DIR =
  /^(utils?|utilities|helpers?|common|shared|lib|libs|internal|pkg|types?|typings|interfaces?|constants?|config)$/i

export interface GraphInput {
  files: RepoFile[]
  imports: FileImport[]
  dependencies: Dependency[]
  entryPoints: string[]
  routes: RouteInfo[]
  storage: StorageInfo[]
  packageName?: string
}

export interface GraphOutput {
  nodes: ProjectNode[]
  edges: ProjectEdge[]
  modules: Module[]
  /** Module-level aggregated edges (top-level nodes only). */
  moduleEdges: ProjectEdge[]
  /** file path -> module id */
  fileModule: Map<string, string>
  /** file path -> file node id */
  fileNode: Map<string, string>
}

function isCodeFile(p: string): boolean {
  const l = languageOf(p)
  return !!l && CODE_LANGUAGES.has(l)
}

const WORKSPACE_DIRS = new Set(['packages', 'apps', 'services', 'cmd', 'libs', 'modules'])
/** Monorepo packages with more code files than this are split into their sub-folders. */
export const SPLIT_PACKAGE_THRESHOLD = 25

/**
 * Decide which module (folder group) a file belongs to. Returns a folder path or '' for root.
 * `dirCounts` maps a directory prefix to the number of code files beneath it.
 */
export function moduleKeyFor(
  path: string,
  allDirs: Set<string>,
  dirCounts: Map<string, number> = new Map(),
): string {
  const parts = path.split('/')
  if (parts.length === 1) return ''
  const top = parts[0]
  if (WORKSPACE_DIRS.has(top) && parts.length > 2) {
    const pkg = `${top}/${parts[1]}`
    if ((dirCounts.get(pkg) ?? 0) <= SPLIT_PACKAGE_THRESHOLD) return pkg
    // Large package: descend past container folders (src, lib, app) to the first meaningful folder.
    let i = 2
    let key = pkg
    if (i < parts.length - 1 && ['src', 'lib', 'app'].includes(parts[i])) {
      key = `${key}/${parts[i]}`
      i++
    }
    if (i < parts.length - 1) return `${key}/${parts[i]}`
    return key
  }
  if (CONTAINER_DIRS.has(top) && parts.length > 2) {
    const second = parts[1]
    if (
      parts.length > 3 &&
      CONTAINER_DIRS.has(second) &&
      allDirs.has(`${top}/${second}/${parts[2]}`)
    )
      return `${top}/${second}/${parts[2]}`
    return `${top}/${second}`
  }
  if (CONTAINER_DIRS.has(top) && parts.length === 2) return top
  return top
}

/** Human name for a module key: drop a leading container folder, keep the last two segments. */
export function moduleNameFor(key: string): string {
  const parts = key.split('/')
  if (parts.length === 1) return key
  const trimmed = WORKSPACE_DIRS.has(parts[0]) || parts[0] === 'src' ? parts.slice(1) : parts
  return trimmed.slice(-3).join('/')
}

export function classifyModule(key: string, files: RepoFile[], routeFiles: Set<string>): NodeType {
  const name = basename(key) || key
  const parentName = basename(dirname(key))
  const codeFiles = files.filter((f) => isCodeFile(f.path))
  const routeHits = files.filter((f) => routeFiles.has(f.path)).length
  if (
    TEST_DIR.test(name) ||
    files.every((f) => /\.(test|spec)\.\w+$|_test\.\w+$|^test_/.test(basename(f.path)))
  )
    return 'test'
  if (DOCS_DIR.test(name)) return 'docs'
  if (key.startsWith('.github') || CONFIG_DIR.test(name) || codeFiles.length === 0) return 'config'
  if (
    codeFiles.every((f) =>
      /(^|\/)([\w.-]+\.config\.[cm]?[jt]s|\.eslintrc\.[cm]?js|postcss\.config\.[cm]?js|tailwind\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|setup\w*\.[jt]s|conftest\.py|setup\.py|manage\.py)$/.test(
        f.path,
      ),
    )
  )
    return 'config'
  const segs = key.split('/')
  if (
    WORKSPACE_DIRS.has(segs[0]) &&
    (segs.length === 2 || (segs.length === 3 && ['src', 'lib', 'app'].includes(segs[2])))
  )
    return routeHits > 0 && codeFiles.length < 15 ? 'api' : 'app'
  if (API_DIR.test(name) || (routeHits > 0 && routeHits >= Math.max(1, codeFiles.length / 3)))
    return 'api'
  if (DB_DIR.test(name)) return 'database'
  if (SERVICE_DIR.test(name)) return 'service'
  if (
    COMPONENT_DIR.test(name) ||
    codeFiles.filter((f) => /\.(tsx|jsx|vue|svelte)$/.test(f.path)).length > codeFiles.length / 2
  )
    return 'component'
  if (UTIL_DIR.test(name) || UTIL_DIR.test(parentName)) return 'module'
  return 'module'
}

function describeModule(
  type: NodeType,
  name: string,
  files: RepoFile[],
  lang: string | undefined,
  routes: RouteInfo[],
): string {
  const n = files.length
  const langText = lang ? ` mostly ${lang}` : ''
  switch (type) {
    case 'api':
      return `HTTP/API layer (${n} file${n === 1 ? '' : 's'}${langText})${routes.length ? ` exposing ${routes.length} route${routes.length === 1 ? '' : 's'}` : ''}.`
    case 'service':
      return `Business logic / service layer with ${n} file${n === 1 ? '' : 's'}${langText}.`
    case 'database':
      return `Data access and persistence layer (${n} file${n === 1 ? '' : 's'}${langText}): models, schema or repositories.`
    case 'component':
      return `User interface layer (${n} file${n === 1 ? '' : 's'}${langText}): components, pages or views.`
    case 'test':
      return `Automated tests (${n} file${n === 1 ? '' : 's'}).`
    case 'docs':
      return `Documentation and examples (${n} file${n === 1 ? '' : 's'}).`
    case 'config':
      return `Configuration, tooling and infrastructure files (${n}).`
    case 'app':
      return `Application package "${name}" with ${n} file${n === 1 ? '' : 's'}${langText}.`
    default:
      return `Module "${name}" with ${n} file${n === 1 ? '' : 's'}${langText}.`
  }
}

function dominantLanguage(files: RepoFile[]): string | undefined {
  const counts = new Map<string, number>()
  for (const f of files) {
    const l = languageOf(f.path)
    if (l && CODE_LANGUAGES.has(l)) counts.set(l, (counts.get(l) ?? 0) + 1)
  }
  let best: string | undefined
  let n = 0
  for (const [l, c] of counts) if (c > n) ((best = l), (n = c))
  return best
}

const INTEGRATION_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  openai: 'OpenAI',
  '@anthropic-ai/sdk': 'Anthropic',
  alembic: 'Migrations (Alembic)',
  'sentry-sdk': 'Sentry',
  '@sentry/node': 'Sentry',
  '@sentry/nextjs': 'Sentry',
  ollama: 'Ollama',
  axios: 'HTTP client (axios)',
  'node-fetch': 'HTTP client (fetch)',
  requests: 'HTTP client (requests)',
  httpx: 'HTTP client (httpx)',
  'aws-sdk': 'AWS',
  boto3: 'AWS (boto3)',
  '@aws-sdk/client-s3': 'AWS S3',
  'socket.io': 'WebSockets (socket.io)',
  ws: 'WebSockets',
  bullmq: 'Job queue (BullMQ)',
  bull: 'Job queue (Bull)',
  celery: 'Task queue (Celery)',
  kafkajs: 'Kafka',
  amqplib: 'RabbitMQ',
  nodemailer: 'Email (nodemailer)',
  '@sendgrid/mail': 'Email (SendGrid)',
  passport: 'Auth (Passport)',
  'next-auth': 'Auth (NextAuth)',
  jsonwebtoken: 'Auth (JWT)',
  graphql: 'GraphQL',
  '@apollo/server': 'GraphQL (Apollo)',
  '@apollo/client': 'GraphQL (Apollo)',
  'simple-git': 'Git',
  torch: 'PyTorch',
  tensorflow: 'TensorFlow',
  pandas: 'pandas',
  numpy: 'NumPy',
}

const STORAGE_DEP_NAMES = new Set([
  'prisma',
  '@prisma/client',
  'mongoose',
  'mongodb',
  'pymongo',
  'pg',
  'postgres',
  'psycopg2',
  'psycopg2-binary',
  'asyncpg',
  'github.com/lib/pq',
  'github.com/jackc/pgx',
  'Npgsql',
  'mysql',
  'mysql2',
  'sqlite3',
  'better-sqlite3',
  'knex',
  'typeorm',
  'sequelize',
  'drizzle-orm',
  'sqlalchemy',
  'sqlmodel',
  'psycopg',
  'gorm.io/gorm',
  'Microsoft.EntityFrameworkCore',
  'Dapper',
  'sqlx',
  'diesel',
  'redis',
  'ioredis',
  'github.com/redis/go-redis',
  'StackExchange.Redis',
  '@supabase/supabase-js',
  'firebase',
  'firebase-admin',
  '@aws-sdk/client-s3',
  '@google-cloud/storage',
])

const STORAGE_BY_DEP: Record<string, string> = {
  prisma: 'Prisma',
  '@prisma/client': 'Prisma',
  mongoose: 'MongoDB',
  mongodb: 'MongoDB',
  pymongo: 'MongoDB',
  pg: 'PostgreSQL',
  postgres: 'PostgreSQL',
  psycopg2: 'PostgreSQL',
  'psycopg2-binary': 'PostgreSQL',
  asyncpg: 'PostgreSQL',
  'github.com/lib/pq': 'PostgreSQL',
  'github.com/jackc/pgx': 'PostgreSQL',
  Npgsql: 'PostgreSQL',
  mysql: 'MySQL',
  mysql2: 'MySQL',
  sqlite3: 'SQLite',
  'better-sqlite3': 'SQLite',
  knex: 'SQL (Knex)',
  typeorm: 'SQL (TypeORM)',
  sequelize: 'SQL (Sequelize)',
  'drizzle-orm': 'SQL (Drizzle)',
  sqlalchemy: 'SQL (SQLAlchemy)',
  sqlmodel: 'SQL (SQLModel)',
  psycopg: 'PostgreSQL',
  'gorm.io/gorm': 'SQL (GORM)',
  'Microsoft.EntityFrameworkCore': 'Entity Framework',
  Dapper: 'SQL (Dapper)',
  sqlx: 'SQL (sqlx)',
  diesel: 'SQL (Diesel)',
  redis: 'Redis',
  ioredis: 'Redis',
  'github.com/redis/go-redis': 'Redis',
  'StackExchange.Redis': 'Redis',
  '@supabase/supabase-js': 'Supabase',
  firebase: 'Firebase',
  'firebase-admin': 'Firebase',
  '@aws-sdk/client-s3': 'S3',
  '@google-cloud/storage': 'Cloud Storage',
}

export const MAX_ENTRY_NODES = 5

export function buildGraph(input: GraphInput): GraphOutput {
  const { files, imports, dependencies, entryPoints, routes, storage, packageName } = input
  const nodes: ProjectNode[] = []
  const edges: ProjectEdge[] = []
  const modules: Module[] = []
  const fileModule = new Map<string, string>()
  const fileNode = new Map<string, string>()
  const routeFiles = new Set(routes.map((r) => r.file))
  const routesByFile = new Map<string, RouteInfo[]>()
  for (const r of routes) routesByFile.set(r.file, [...(routesByFile.get(r.file) ?? []), r])

  const allDirs = new Set<string>()
  const dirCounts = new Map<string, number>()
  for (const f of files) {
    const parts = f.path.split('/')
    const code = isCodeFile(f.path)
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      allDirs.add(dir)
      if (code) dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1)
    }
  }

  // Lift a handful of entry points to top-level nodes so the map has an obvious "start here".
  const liftedEntries = new Set(
    [...entryPoints]
      .filter((p) => isCodeFile(p))
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
      .slice(0, MAX_ENTRY_NODES),
  )

  // Group files into modules.
  const groups = new Map<string, RepoFile[]>()
  for (const f of files) {
    if (liftedEntries.has(f.path)) continue
    const key = moduleKeyFor(f.path, allDirs, dirCounts)
    groups.set(key, [...(groups.get(key) ?? []), f])
  }

  const rootName = packageName ?? 'root'
  const moduleIdFor = (key: string) => (key === '' ? 'mod:root' : `mod:${slug(key)}`)

  // Root files are split into config / docs / code.
  const rootFiles = groups.get('') ?? []
  groups.delete('')
  const rootCode = rootFiles.filter((f) => isCodeFile(f.path))
  const rootDocs = rootFiles.filter(
    (f) => /\.(md|mdx|rst|txt)$/i.test(f.path) || /^(LICENSE|CHANGELOG|README)/i.test(f.path),
  )
  const rootConfig = rootFiles.filter((f) => !rootCode.includes(f) && !rootDocs.includes(f))
  if (rootCode.length) groups.set('', rootCode)

  const addModule = (key: string, type: NodeType, name: string, groupFiles: RepoFile[]) => {
    const id = moduleIdFor(key)
    const lang = dominantLanguage(groupFiles)
    const moduleRoutes = groupFiles.flatMap((f) => routesByFile.get(f.path) ?? [])
    const lines = groupFiles.reduce((n, f) => n + countLines(f.content), 0)
    const node: ProjectNode = {
      id,
      name,
      type,
      path: key || '/',
      description: describeModule(type, name, groupFiles, lang, moduleRoutes),
      importance: 0,
      dependencies: [],
      dependents: [],
      warnings: [],
      children: [],
      meta: {
        files: groupFiles.length,
        lines,
        language: lang,
        routes: moduleRoutes.length
          ? moduleRoutes.slice(0, 40).map((r) => `${r.method} ${r.path}`)
          : undefined,
      },
    }
    nodes.push(node)
    modules.push({ id, name, path: key || '/', type, files: groupFiles.map((f) => f.path), lines })
    for (const f of groupFiles.sort((a, b) => a.path.localeCompare(b.path))) {
      const fid = `file:${f.path}`
      fileModule.set(f.path, id)
      fileNode.set(f.path, fid)
      const fr = routesByFile.get(f.path)
      const rel =
        key && f.path.startsWith(key + '/') ? f.path.slice(key.length + 1) : basename(f.path)
      nodes.push({
        id: fid,
        name: rel,
        type: 'file',
        path: f.path,
        description: fileDescription(f, fr),
        importance: 0,
        dependencies: [],
        dependents: [],
        warnings: [],
        parent: id,
        meta: {
          lines: countLines(f.content),
          language: languageOf(f.path),
          routes: fr?.map((r) => `${r.method} ${r.path}`),
        },
      })
      node.children!.push(fid)
    }
  }

  const keys = [...groups.keys()].sort()
  for (const key of keys) {
    const groupFiles = groups.get(key)!
    if (key === '') {
      addModule('', 'module', rootName, groupFiles)
      continue
    }
    const type = classifyModule(key, groupFiles, routeFiles)
    addModule(key, type, moduleNameFor(key), groupFiles)
  }
  if (rootConfig.length) addModule('__config', 'config', 'Configuration', rootConfig)
  if (rootDocs.length) addModule('__docs', 'docs', 'Documentation', rootDocs)

  // Entry nodes.
  for (const p of liftedEntries) {
    const id = `entry:${p}`
    fileNode.set(p, id)
    fileModule.set(p, id)
    const f = files.find((x) => x.path === p)
    const parts = p.split('/')
    const generic = /^(index|main|app|server|program|mod)\.\w+$/i.test(basename(p))
    nodes.push({
      id,
      name: generic && parts.length > 1 ? parts.slice(-2).join('/') : basename(p),
      type: 'entry',
      path: p,
      description: `Entry point. ${entryReason(f)}`,
      importance: 1,
      dependencies: [],
      dependents: [],
      warnings: [],
      meta: { lines: countLines(f?.content), language: languageOf(p) },
    })
  }

  // Integration & storage nodes (only for dependencies that are actually imported somewhere,
  // or storage layers with concrete evidence).
  const usedExternal = new Map<string, Set<string>>() // pkg -> importing files
  for (const im of imports) {
    if (!im.external) continue
    usedExternal.set(im.external, (usedExternal.get(im.external) ?? new Set()).add(im.from))
  }
  const externalNodeId = new Map<string, string>() // package -> node id
  const storageNodes = new Map<string, string>() // storage name -> node id
  for (const s of storage) {
    const id = `store:${slug(s.name)}`
    storageNodes.set(s.name, id)
    nodes.push({
      id,
      name: s.name,
      type: 'database',
      path: s.evidence[0] ?? '',
      description: `${s.kind === 'cache' ? 'Cache' : s.kind === 'storage' ? 'Object storage' : 'Database / persistence'} layer. Evidence: ${s.evidence.slice(0, 3).join(', ')}.`,
      importance: 0,
      dependencies: [],
      dependents: [],
      warnings: [],
      meta: { package: s.name },
    })
  }
  const usersOf = (name: string) =>
    usedExternal.get(name) ??
    usedExternal.get(name.toLowerCase().replace(/-/g, '_')) ??
    (PYPI_IMPORT_NAMES[name.toLowerCase()]
      ? usedExternal.get(PYPI_IMPORT_NAMES[name.toLowerCase()])
      : undefined)
  for (const d of dependencies) {
    const users = usersOf(d.name)
    if (!users) continue
    if (STORAGE_DEP_NAMES.has(d.name)) {
      const storeName = STORAGE_BY_DEP[d.name]
      const sid = storageNodes.get(storeName)
      if (sid) externalNodeId.set(d.name, sid)
      continue
    }
    if (!d.category) continue
    const id = `ext:${slug(d.name)}`
    externalNodeId.set(d.name, id)
    nodes.push({
      id,
      name: INTEGRATION_LABELS[d.name] ?? d.name,
      type: 'integration',
      path: d.name,
      description: `External ${d.category} integration via the "${d.name}" package (${d.ecosystem}).`,
      importance: 0,
      dependencies: [],
      dependents: [],
      warnings: [],
      meta: { package: d.name },
    })
  }
  // Also link storage nodes discovered via files (schema.prisma, migrations) even without imports.
  for (const d of dependencies) d.used = !!usersOf(d.name)

  // File-level edges.
  const testModules = new Set(modules.filter((m) => m.type === 'test').map((m) => m.id))
  const edgeKeys = new Set<string>()
  const pushEdge = (
    source: string,
    target: string,
    type: ProjectEdge['type'],
    confidence: number,
  ) => {
    const key = `${source}|${target}|${type}`
    if (edgeKeys.has(key) || source === target) return
    edgeKeys.add(key)
    edges.push({ id: `e${edges.length}`, source, target, type, confidence })
  }
  for (const im of imports) {
    const s = fileNode.get(im.from)
    if (!s) continue
    if (im.to) {
      const t = fileNode.get(im.to)
      if (!t) continue
      const isTest =
        testModules.has(fileModule.get(im.from) ?? '') ||
        /\.(test|spec)\.\w+$|_test\.\w+$/.test(im.from)
      pushEdge(s, t, isTest ? 'tests' : 'imports', 0.9)
    } else if (im.external) {
      const t = externalNodeId.get(im.external)
      if (!t) continue
      pushEdge(s, t, t.startsWith('store:') ? 'dataflow' : 'depends', 0.8)
    }
  }
  // ORM / query-builder layers read and write the concrete database that was detected.
  const concreteDbs = [...storageNodes.entries()].filter(([name]) =>
    /^(PostgreSQL|MySQL|SQLite|MongoDB|Supabase)$/.test(name),
  )
  for (const [name, id] of storageNodes) {
    if (!/^(SQL \(|Prisma|Entity Framework)/.test(name)) continue
    for (const [, dbId] of concreteDbs) pushEdge(id, dbId, 'dataflow', 0.6)
  }
  if (edges.length > 8000) edges.length = 8000

  // Module-level aggregation, dependencies/dependents, importance.
  const top = topLevelIds(nodes)
  const moduleEdges = aggregateEdges(nodes, edges, top)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const e of moduleEdges) {
    byId.get(e.source)?.dependencies.push(e.target)
    byId.get(e.target)?.dependents.push(e.source)
  }
  for (const e of edges) {
    byId.get(e.source)?.dependencies.push(e.target)
    byId.get(e.target)?.dependents.push(e.source)
  }
  let maxScore = 1
  const scores = new Map<string, number>()
  for (const n of nodes) {
    const inDeg = n.dependents.length
    const outDeg = n.dependencies.length
    const size = n.meta?.files ?? 1
    const score = inDeg * 2 + outDeg + Math.log2(size + 1)
    scores.set(n.id, score)
    if (!n.parent && !n.id.startsWith('ext:') && !n.id.startsWith('store:') && score > maxScore)
      maxScore = score
  }
  for (const n of nodes) {
    if (n.type === 'entry') continue
    n.importance = Math.min(1, Math.round(((scores.get(n.id) ?? 0) / maxScore) * 100) / 100)
    n.dependencies = [...new Set(n.dependencies)]
    n.dependents = [...new Set(n.dependents)]
  }

  return { nodes, edges, modules, moduleEdges, fileModule, fileNode }
}

function fileDescription(f: RepoFile, routes?: RouteInfo[]): string {
  const lines = countLines(f.content)
  const lang = languageOf(f.path)
  const bits: string[] = []
  if (lang) bits.push(lang)
  if (f.content) bits.push(`${lines} lines`)
  else bits.push(`${Math.round(f.size / 1024)} KB, not parsed`)
  if (routes?.length) bits.push(`${routes.length} route${routes.length === 1 ? '' : 's'}`)
  const doc = firstDocLine(f.content)
  return doc ? `${doc} (${bits.join(', ')})` : bits.join(', ')
}

function firstDocLine(content: string | undefined): string | undefined {
  if (!content) return undefined
  const head = content.slice(0, 1500)
  const m =
    head.match(/^\s*\/\*\*?\s*\n?\s*\*?\s*([^\n*@]{12,140})/) ??
    head.match(/^\s*(?:\/\/|#)\s*([^\n]{12,140})/) ??
    head.match(/^\s*(?:"""|''')\s*\n?\s*([^\n]{12,140})/)
  return m ? m[1].trim().replace(/\s+/g, ' ') : undefined
}

function entryReason(f: RepoFile | undefined): string {
  const c = f?.content ?? ''
  if (/createRoot|ReactDOM\.render|\.mount\(/.test(c)) return 'Mounts the client application.'
  if (/\.listen\s*\(/.test(c) || /WebApplication\.CreateBuilder/.test(c))
    return 'Starts the HTTP server.'
  if (
    /func\s+main/.test(c) ||
    /static\s+(async\s+)?(void|Task|int)\s+Main/.test(c) ||
    /if\s+__name__/.test(c)
  )
    return 'Program entry (main).'
  return 'Where execution starts.'
}
