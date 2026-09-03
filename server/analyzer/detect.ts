import type { Dependency, LanguageStat, RepoFile } from '../../shared/types.js'
import { basename, extname } from './paths.js'

export const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.cs': 'C#',
  '.fs': 'F#',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.scala': 'Scala',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.m': 'Objective-C',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.hpp': 'C++',
  '.dart': 'Dart',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.erl': 'Erlang',
  '.hs': 'Haskell',
  '.lua': 'Lua',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.ps1': 'PowerShell',
  '.sql': 'SQL',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.less': 'Less',
  '.prisma': 'Prisma',
  '.graphql': 'GraphQL',
  '.gql': 'GraphQL',
  '.proto': 'Protobuf',
  '.tf': 'Terraform',
  '.yml': 'YAML',
  '.yaml': 'YAML',
  '.toml': 'TOML',
  '.json': 'JSON',
  '.md': 'Markdown',
  '.mdx': 'Markdown',
}

/** Languages that carry logic (used for summaries and complexity, not counts of config). */
export const CODE_LANGUAGES = new Set([
  'TypeScript',
  'JavaScript',
  'Vue',
  'Svelte',
  'Python',
  'Go',
  'Rust',
  'C#',
  'F#',
  'Java',
  'Kotlin',
  'Scala',
  'Ruby',
  'PHP',
  'Swift',
  'Objective-C',
  'C',
  'C++',
  'Dart',
  'Elixir',
  'Erlang',
  'Haskell',
  'Lua',
])

export function languageOf(filePath: string): string | undefined {
  const name = basename(filePath)
  if (name === 'Dockerfile' || name.startsWith('Dockerfile.')) return 'Docker'
  if (name === 'Makefile') return 'Make'
  return LANGUAGE_BY_EXT[extname(filePath).toLowerCase()]
}

export function countLines(content: string | undefined): number {
  if (!content) return 0
  let n = 1
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) n++
  return n
}

export function detectLanguages(files: RepoFile[]): LanguageStat[] {
  const map = new Map<string, { files: number; lines: number }>()
  let totalLines = 0
  for (const f of files) {
    const lang = languageOf(f.path)
    if (!lang || !CODE_LANGUAGES.has(lang)) continue
    const lines = countLines(f.content)
    const s = map.get(lang) ?? { files: 0, lines: 0 }
    s.files++
    s.lines += lines
    totalLines += lines
    map.set(lang, s)
  }
  return [...map.entries()]
    .map(([name, s]) => ({ name, ...s, share: totalLines ? s.lines / totalLines : 0 }))
    .sort((a, b) => b.lines - a.lines)
}

/* ---------------------------------------------------------------------- */
/* Dependencies & frameworks                                                */
/* ---------------------------------------------------------------------- */

interface KnownDep {
  /** Framework label shown to the user (undefined for plain libraries). */
  framework?: string
  /** Integration / storage category used to create graph nodes. */
  category?: string
}

/** Curated knowledge about popular packages across ecosystems. */
export const KNOWN_DEPENDENCIES: Record<string, KnownDep> = {
  // JS frameworks
  react: { framework: 'React' },
  'react-dom': {},
  next: { framework: 'Next.js' },
  vue: { framework: 'Vue' },
  nuxt: { framework: 'Nuxt' },
  svelte: { framework: 'Svelte' },
  '@sveltejs/kit': { framework: 'SvelteKit' },
  '@angular/core': { framework: 'Angular' },
  solid: { framework: 'Solid' },
  'solid-js': { framework: 'Solid' },
  astro: { framework: 'Astro' },
  remix: { framework: 'Remix' },
  '@remix-run/react': { framework: 'Remix' },
  express: { framework: 'Express' },
  fastify: { framework: 'Fastify' },
  koa: { framework: 'Koa' },
  hono: { framework: 'Hono' },
  '@nestjs/core': { framework: 'NestJS' },
  electron: { framework: 'Electron' },
  'react-native': { framework: 'React Native' },
  expo: { framework: 'Expo' },
  vite: { framework: 'Vite' },
  tailwindcss: { framework: 'Tailwind CSS' },
  // JS data / infra
  prisma: { category: 'database' },
  '@prisma/client': { category: 'database' },
  mongoose: { category: 'database' },
  mongodb: { category: 'database' },
  pg: { category: 'database' },
  postgres: { category: 'database' },
  mysql: { category: 'database' },
  mysql2: { category: 'database' },
  sqlite3: { category: 'database' },
  'better-sqlite3': { category: 'database' },
  knex: { category: 'database' },
  typeorm: { category: 'database' },
  sequelize: { category: 'database' },
  'drizzle-orm': { category: 'database' },
  redis: { category: 'cache' },
  ioredis: { category: 'cache' },
  '@supabase/supabase-js': { category: 'database' },
  firebase: { category: 'database' },
  'firebase-admin': { category: 'database' },
  stripe: { category: 'payments' },
  '@aws-sdk/client-s3': { category: 'cloud storage' },
  'aws-sdk': { category: 'cloud' },
  '@google-cloud/storage': { category: 'cloud storage' },
  axios: { category: 'http client' },
  'node-fetch': { category: 'http client' },
  graphql: { category: 'graphql' },
  '@apollo/server': { category: 'graphql' },
  '@apollo/client': { category: 'graphql' },
  'socket.io': { category: 'realtime' },
  ws: { category: 'realtime' },
  bullmq: { category: 'queue' },
  bull: { category: 'queue' },
  kafkajs: { category: 'queue' },
  amqplib: { category: 'queue' },
  openai: { category: 'ai' },
  '@anthropic-ai/sdk': { category: 'ai' },
  ollama: { category: 'ai' },
  nodemailer: { category: 'email' },
  '@sendgrid/mail': { category: 'email' },
  passport: { category: 'auth' },
  'next-auth': { category: 'auth' },
  jsonwebtoken: { category: 'auth' },
  'simple-git': { category: 'git' },
  // Python
  django: { framework: 'Django' },
  flask: { framework: 'Flask' },
  fastapi: { framework: 'FastAPI' },
  starlette: { framework: 'Starlette' },
  tornado: { framework: 'Tornado' },
  streamlit: { framework: 'Streamlit' },
  celery: { category: 'queue' },
  sqlalchemy: { category: 'database' },
  sqlmodel: { category: 'database' },
  psycopg: { category: 'database' },
  alembic: { category: 'database' },
  psycopg2: { category: 'database' },
  'psycopg2-binary': { category: 'database' },
  pymongo: { category: 'database' },
  asyncpg: { category: 'database' },
  requests: { category: 'http client' },
  httpx: { category: 'http client' },
  boto3: { category: 'cloud' },
  torch: { category: 'ai' },
  tensorflow: { category: 'ai' },
  pandas: { category: 'data' },
  numpy: { category: 'data' },
  // Go
  'github.com/gin-gonic/gin': { framework: 'Gin' },
  'github.com/labstack/echo': { framework: 'Echo' },
  'github.com/gofiber/fiber': { framework: 'Fiber' },
  'github.com/go-chi/chi': { framework: 'Chi' },
  'gorm.io/gorm': { category: 'database' },
  'github.com/lib/pq': { category: 'database' },
  'github.com/jackc/pgx': { category: 'database' },
  'github.com/redis/go-redis': { category: 'cache' },
  // .NET
  'Microsoft.AspNetCore.App': { framework: 'ASP.NET Core' },
  'Microsoft.EntityFrameworkCore': { category: 'database' },
  Npgsql: { category: 'database' },
  Dapper: { category: 'database' },
  'StackExchange.Redis': { category: 'cache' },
  // Rust
  actix: { framework: 'Actix' },
  'actix-web': { framework: 'Actix' },
  axum: { framework: 'Axum' },
  rocket: { framework: 'Rocket' },
  tokio: {},
  sqlx: { category: 'database' },
  diesel: { category: 'database' },
  // Ruby / PHP / Java
  rails: { framework: 'Ruby on Rails' },
  sinatra: { framework: 'Sinatra' },
  'laravel/framework': { framework: 'Laravel' },
  'symfony/symfony': { framework: 'Symfony' },
  'org.springframework.boot': { framework: 'Spring Boot' },
}

function parseJson(content: string | undefined): Record<string, unknown> | undefined {
  if (!content) return undefined
  try {
    const v = JSON.parse(content)
    return typeof v === 'object' && v ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** PyPI distribution name -> import name, for packages where they differ. */
export const PYPI_IMPORT_NAMES: Record<string, string> = {
  pyjwt: 'jwt',
  'python-multipart': 'multipart',
  pillow: 'PIL',
  beautifulsoup4: 'bs4',
  'scikit-learn': 'sklearn',
  'python-dotenv': 'dotenv',
  pyyaml: 'yaml',
  'opencv-python': 'cv2',
  'psycopg2-binary': 'psycopg2',
  'python-dateutil': 'dateutil',
  'python-jose': 'jose',
  'email-validator': 'email_validator',
  'sentry-sdk': 'sentry_sdk',
  'pydantic-settings': 'pydantic_settings',
  'google-cloud-storage': 'google',
  'python-socketio': 'socketio',
  passlib: 'passlib',
  uvicorn: 'uvicorn',
  attrs: 'attr',
  'msgpack-python': 'msgpack',
  protobuf: 'google',
}

export interface ManifestInfo {
  dependencies: Dependency[]
  frameworks: string[]
  /** Scripts / commands that hint at entry points (package.json main, bin, start). */
  entryHints: string[]
  packageName?: string
  packageManifests: string[]
}

export function detectManifests(files: RepoFile[]): ManifestInfo {
  const deps: Dependency[] = []
  const frameworks = new Set<string>()
  const entryHints: string[] = []
  const manifests: string[] = []
  let packageName: string | undefined

  const add = (
    name: string,
    ecosystem: Dependency['ecosystem'],
    dev: boolean,
    version?: string,
  ) => {
    if (deps.some((d) => d.name === name && d.ecosystem === ecosystem)) return
    const known = KNOWN_DEPENDENCIES[name]
    if (known?.framework) frameworks.add(known.framework)
    deps.push({ name, version, ecosystem, dev, used: false, category: known?.category })
  }

  for (const f of files) {
    const name = basename(f.path)
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
    if (name === 'package.json') {
      const pkg = parseJson(f.content)
      if (!pkg) continue
      manifests.push(f.path)
      if (!dir && typeof pkg.name === 'string') packageName = pkg.name
      for (const [k, v] of Object.entries((pkg.dependencies as Record<string, string>) ?? {}))
        add(k, 'npm', false, v)
      for (const [k, v] of Object.entries((pkg.devDependencies as Record<string, string>) ?? {}))
        add(k, 'npm', true, v)
      const prefix = dir ? dir + '/' : ''
      if (typeof pkg.main === 'string') entryHints.push(prefix + pkg.main.replace(/^\.\//, ''))
      if (typeof pkg.module === 'string') entryHints.push(prefix + pkg.module.replace(/^\.\//, ''))
      if (typeof pkg.bin === 'string') entryHints.push(prefix + pkg.bin.replace(/^\.\//, ''))
      if (pkg.bin && typeof pkg.bin === 'object')
        for (const v of Object.values(pkg.bin as Record<string, string>))
          entryHints.push(prefix + v.replace(/^\.\//, ''))
      const scripts = (pkg.scripts as Record<string, string>) ?? {}
      for (const key of ['start', 'dev', 'serve']) {
        const s = scripts[key]
        if (!s) continue
        const m = s.match(
          /(?:node|tsx|ts-node|nodemon|bun|deno run)\s+(?:--[\w-]+\s+)*([\w./-]+\.(?:[cm]?[jt]sx?))/,
        )
        if (m) entryHints.push(prefix + m[1].replace(/^\.\//, ''))
      }
    } else if (name === 'requirements.txt' || name === 'requirements-dev.txt') {
      manifests.push(f.path)
      for (const line of (f.content ?? '').split('\n')) {
        const m = line.trim().match(/^([A-Za-z0-9_.-]+)\s*(?:[=<>!~]+\s*([^\s;#]+))?/)
        if (m && m[1] && !line.trim().startsWith('#') && !line.trim().startsWith('-'))
          add(m[1].toLowerCase(), 'pypi', name.includes('dev'), m[2])
      }
    } else if (name === 'pyproject.toml') {
      manifests.push(f.path)
      const c = f.content ?? ''
      const nameMatch = c.match(/^\s*name\s*=\s*"([^"]+)"/m)
      if (!dir && nameMatch) packageName = nameMatch[1]
      const depBlock = c.match(/^dependencies\s*=\s*\[([\s\S]*?)^\s*\]/m)
      if (depBlock)
        for (const m of depBlock[1].matchAll(/"([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?/g))
          add(m[1].toLowerCase(), 'pypi', false)
      const poetry = c.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/)
      if (poetry)
        for (const line of poetry[1].split('\n')) {
          const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)
          if (m && m[1] !== 'python') add(m[1].toLowerCase(), 'pypi', false)
        }
      if (/\[tool\.pytest/.test(c)) frameworks.add('pytest')
    } else if (name === 'go.mod') {
      manifests.push(f.path)
      const c = f.content ?? ''
      const mod = c.match(/^module\s+(\S+)/m)
      if (mod && !dir) packageName = mod[1]
      for (const m of c.matchAll(
        /^\s*([\w.\-/]+\.[\w.\-/]+)\s+v[\w.\-+]+(\s*\/\/\s*indirect)?/gm,
      )) {
        if (m[2]) continue
        const path = m[1]
        const key = Object.keys(KNOWN_DEPENDENCIES).find((k) => path.startsWith(k))
        add(key ?? path, 'go', false)
      }
    } else if (name === 'Cargo.toml') {
      manifests.push(f.path)
      const c = f.content ?? ''
      const nameMatch = c.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/)
      if (!dir && nameMatch) packageName = nameMatch[1]
      const block = c.match(/\[dependencies\]([\s\S]*?)(?=\n\[|$)/)
      if (block)
        for (const line of block[1].split('\n')) {
          const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)
          if (m) add(m[1], 'cargo', false)
        }
      const dev = c.match(/\[dev-dependencies\]([\s\S]*?)(?=\n\[|$)/)
      if (dev)
        for (const line of dev[1].split('\n')) {
          const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)
          if (m) add(m[1], 'cargo', true)
        }
    } else if (name.endsWith('.csproj') || name.endsWith('.fsproj')) {
      manifests.push(f.path)
      const c = f.content ?? ''
      if (/Microsoft\.NET\.Sdk\.Web/.test(c)) frameworks.add('ASP.NET Core')
      if (/Microsoft\.NET\.Sdk\.BlazorWebAssembly/.test(c)) frameworks.add('Blazor')
      if (/<OutputType>\s*Exe/i.test(c)) entryHints.push(f.path)
      for (const m of c.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g))
        add(m[1], 'nuget', false, m[2])
      if (!dir && !packageName) packageName = name.replace(/\.(cs|fs)proj$/, '')
    } else if (name === 'Gemfile') {
      manifests.push(f.path)
      for (const m of (f.content ?? '').matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm))
        add(m[1], 'rubygems', false)
    } else if (name === 'composer.json') {
      manifests.push(f.path)
      const pkg = parseJson(f.content)
      if (!pkg) continue
      for (const k of Object.keys((pkg.require as Record<string, string>) ?? {}))
        if (k.includes('/')) add(k, 'composer', false)
      for (const k of Object.keys((pkg['require-dev'] as Record<string, string>) ?? {}))
        if (k.includes('/')) add(k, 'composer', true)
    } else if (name === 'pom.xml' || name === 'build.gradle' || name === 'build.gradle.kts') {
      manifests.push(f.path)
      const c = f.content ?? ''
      if (/spring-boot/.test(c)) frameworks.add('Spring Boot')
      for (const m of c.matchAll(
        /<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/g,
      ))
        add(`${m[1]}:${m[2]}`, 'maven', false)
      for (const m of c.matchAll(/implementation\s*\(?['"]([^'":]+):([^'":]+)/g))
        add(`${m[1]}:${m[2]}`, 'maven', false)
    }
  }

  // Framework signals that come from files rather than manifests.
  const paths = new Set(files.map((f) => f.path))
  if ([...paths].some((p) => /(^|\/)manage\.py$/.test(p))) frameworks.add('Django')
  if (
    [...paths].some((p) =>
      /(^|\/)(next|nuxt|svelte|astro|vite|tailwind)\.config\.[cm]?[jt]s$/.test(p),
    )
  ) {
    for (const p of paths) {
      if (/next\.config/.test(p)) frameworks.add('Next.js')
      if (/nuxt\.config/.test(p)) frameworks.add('Nuxt')
      if (/svelte\.config/.test(p)) frameworks.add('Svelte')
      if (/astro\.config/.test(p)) frameworks.add('Astro')
      if (/vite\.config/.test(p)) frameworks.add('Vite')
      if (/tailwind\.config/.test(p)) frameworks.add('Tailwind CSS')
    }
  }
  if ([...paths].some((p) => /(^|\/)Dockerfile/.test(p))) frameworks.add('Docker')
  if ([...paths].some((p) => /(^|\/)(docker-)?compose(\.\w+)?\.ya?ml$/.test(p)))
    frameworks.add('Docker Compose')
  if ([...paths].some((p) => /(^|\/)schema\.prisma$/.test(p))) frameworks.add('Prisma')
  if ([...paths].some((p) => /\.tf$/.test(p))) frameworks.add('Terraform')
  if ([...paths].some((p) => /(^|\/)\.github\/workflows\//.test(p)))
    frameworks.add('GitHub Actions')
  if ([...paths].some((p) => /(^|\/)(jest|vitest)\.config\./.test(p))) {
    for (const p of paths) {
      if (/jest\.config/.test(p)) frameworks.add('Jest')
      if (/vitest\.config/.test(p)) frameworks.add('Vitest')
    }
  }
  if (deps.some((d) => d.name === 'pytest')) frameworks.add('pytest')
  if (deps.some((d) => d.name === 'jest')) frameworks.add('Jest')
  if (deps.some((d) => d.name === 'vitest')) frameworks.add('Vitest')
  if (deps.some((d) => d.name === 'typescript')) frameworks.add('TypeScript')

  return {
    dependencies: deps,
    frameworks: [...frameworks],
    entryHints,
    packageName,
    packageManifests: manifests,
  }
}

/* ---------------------------------------------------------------------- */
/* Entry points                                                             */
/* ---------------------------------------------------------------------- */

const P = '(?:[^/]+/){0,2}' // up to two leading folders (backend/app/main.py, apps/web/server.ts)
const ENTRY_NAME_PATTERNS: RegExp[] = [
  new RegExp(`^${P}(main|app|server|cli)\\.(ts|tsx|js|jsx|mjs|cjs)$`),
  /^(src\/|(apps|packages|services)\/[^/]+\/(src\/)?)?index\.(ts|tsx|js|jsx|mjs|cjs)$/,
  new RegExp(`^${P}(main|app|server|manage|cli|__main__|wsgi|asgi)\\.py$`),
  /^(cmd\/[^/]+\/)?main\.go$/,
  /^src\/(main|lib)\.rs$/,
  /(^|\/)Program\.cs$/,
  /(^|\/)Startup\.cs$/,
  /(^|\/)(Main|Application)\.(java|kt)$/,
  /^config\.ru$/,
  /^(public\/)?index\.php$/,
  /^artisan$/,
  /^(src\/)?app\/(layout|page)\.(tsx|jsx|ts|js)$/,
  /^(src\/)?pages\/_app\.(tsx|jsx)$/,
  /^(src\/)?main\.(ts|js)$/,
  /^lib\/main\.dart$/,
]

export function detectEntryPoints(files: RepoFile[], hints: string[]): string[] {
  const paths = new Set(files.map((f) => f.path))
  const entries = new Set<string>()
  for (const h of hints) {
    if (paths.has(h)) entries.add(h)
    else {
      // package.json "main" may point at a build output; try a source equivalent.
      const alt = h.replace(/^(dist|build|lib|out)\//, 'src/').replace(/\.js$/, '.ts')
      if (paths.has(alt)) entries.add(alt)
    }
  }
  const NOISE =
    /(^|\/)(examples?|samples?|docs?|tests?|__tests__|spec|fixtures?|benchmarks?|scripts?|\.github)\//
  for (const p of paths) {
    if (NOISE.test(p)) continue
    if (ENTRY_NAME_PATTERNS.some((re) => re.test(p))) entries.add(p)
  }
  // Content-based signals: "if __name__ == '__main__'", listen(), createRoot()
  for (const f of files) {
    if (!f.content || entries.has(f.path)) continue
    if (NOISE.test(f.path)) continue
    const lang = languageOf(f.path)
    if (!lang || !CODE_LANGUAGES.has(lang)) continue
    if (f.path.split('/').length > 3) continue
    const c = f.content
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|#|\/\*)/.test(line))
      .join('\n')
    if (
      /if\s+__name__\s*==\s*['"]__main__['"]/.test(c) ||
      /\.listen\s*\(\s*(process\.env\.\w+|\d{2,5}|port|PORT)/.test(c) ||
      /createRoot\s*\(|ReactDOM\.render\s*\(|createApp\s*\([^)]*\)\.mount/.test(c) ||
      /func\s+main\s*\(\s*\)/.test(c) ||
      /static\s+(async\s+)?(void|Task|int)\s+Main\s*\(/.test(c) ||
      /WebApplication\.CreateBuilder/.test(c)
    ) {
      entries.add(f.path)
    }
  }
  return [...entries].sort()
}

/* ---------------------------------------------------------------------- */
/* API routes                                                               */
/* ---------------------------------------------------------------------- */

export interface RouteInfo {
  method: string
  path: string
  file: string
}

const ROUTE_PATTERNS: {
  re: RegExp
  method: (m: RegExpMatchArray) => string
  path: (m: RegExpMatchArray) => string
}[] = [
  // express / koa-router / fastify / hono: app.get('/x'), router.post("/x")
  {
    re: /\b(?:app|router|server|api|fastify|r|route|group|v\d)\.(get|post|put|patch|delete|del|all|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[2],
  },
  // fastify.route({ method: 'GET', url: '/x' })
  {
    re: /method:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]\s*,\s*url:\s*['"]([^'"]+)['"]/g,
    method: (m) => m[1],
    path: (m) => m[2],
  },
  // FastAPI / Flask: @app.get("/x"), @router.post("/x"), @app.route("/x", methods=[...])
  {
    re: /@(?:app|router|api|bp|blueprint|\w+_router|\w+_bp)\.(get|post|put|patch|delete|route)\s*\(\s*['"]([^'"]+)['"]/g,
    method: (m) => (m[1] === 'route' ? 'ANY' : m[1].toUpperCase()),
    path: (m) => m[2],
  },
  // Go net/http and mux/gin/echo/chi/fiber
  {
    re: /\.(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"/g,
    method: (m) => (/^Handle/.test(m[1]) ? 'ANY' : m[1].toUpperCase()),
    path: (m) => m[2],
  },
  // ASP.NET attribute routes
  {
    re: /\[Http(Get|Post|Put|Patch|Delete)(?:\(\s*"([^"]*)"\s*\))?\]/g,
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[2] || '',
  },
  { re: /\[Route\(\s*"([^"]+)"\s*\)\]/g, method: () => 'ROUTE', path: (m) => m[1] },
  // Spring
  {
    re: /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?"([^"]+)"/g,
    method: (m) => (m[1] === 'Request' ? 'ANY' : m[1].toUpperCase()),
    path: (m) => m[2],
  },
  // Rails routes.rb
  {
    re: /^\s*(get|post|put|patch|delete|resources|resource)\s+['":]([\w/:-]+)/gm,
    method: (m) => (m[1].startsWith('resource') ? 'REST' : m[1].toUpperCase()),
    path: (m) => (m[1].startsWith('resource') ? '/' + m[2] : m[2]),
  },
  // Laravel
  {
    re: /Route::(get|post|put|patch|delete|any|resource|apiResource)\s*\(\s*['"]([^'"]+)['"]/g,
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[2],
  },
  // Rust axum / actix
  {
    re: /\.route\s*\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)\s*\(/g,
    method: (m) => m[2].toUpperCase(),
    path: (m) => m[1],
  },
  {
    re: /#\[(get|post|put|patch|delete)\s*\(\s*"([^"]+)"\s*\)\]/g,
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[2],
  },
]

export function detectRoutes(files: RepoFile[]): RouteInfo[] {
  const routes: RouteInfo[] = []
  const seen = new Set<string>()
  for (const f of files) {
    if (!f.content) continue
    // Next.js / SvelteKit / Nuxt file-based API routes
    const fileRoute = f.path.match(
      /^(?:src\/)?(?:app|pages|routes|server)\/api\/(.+?)\/?(?:route|index|\+server)?\.(?:ts|js|tsx|jsx)$/,
    )
    if (fileRoute) {
      const p =
        '/api/' + fileRoute[1].replace(/\/(route|index)$/, '').replace(/\[([^\]]+)\]/g, ':$1')
      const key = `FILE ${p}`
      if (!seen.has(key)) {
        seen.add(key)
        routes.push({ method: 'FILE', path: p, file: f.path })
      }
      continue
    }
    const lang = languageOf(f.path)
    if (!lang || !CODE_LANGUAGES.has(lang)) continue
    for (const pat of ROUTE_PATTERNS) {
      pat.re.lastIndex = 0
      for (const m of f.content.matchAll(pat.re)) {
        const p = pat.path(m)
        if (!p.startsWith('/') && pat.method(m) !== 'ROUTE' && !/^\w/.test(p)) continue
        const key = `${pat.method(m)} ${p} ${f.path}`
        if (seen.has(key)) continue
        seen.add(key)
        routes.push({ method: pat.method(m), path: p, file: f.path })
        if (routes.length > 400) return routes
      }
    }
  }
  return routes
}

/* ---------------------------------------------------------------------- */
/* Storage / database layers                                                */
/* ---------------------------------------------------------------------- */

export interface StorageInfo {
  name: string
  kind: 'database' | 'cache' | 'storage'
  evidence: string[]
}

export function detectStorage(files: RepoFile[], deps: Dependency[]): StorageInfo[] {
  const map = new Map<string, StorageInfo>()
  const add = (name: string, kind: StorageInfo['kind'], evidence: string) => {
    const cur = map.get(name) ?? { name, kind, evidence: [] }
    if (!cur.evidence.includes(evidence)) cur.evidence.push(evidence)
    map.set(name, cur)
  }
  const byDep: Record<string, [string, StorageInfo['kind']]> = {
    prisma: ['Prisma', 'database'],
    '@prisma/client': ['Prisma', 'database'],
    mongoose: ['MongoDB', 'database'],
    mongodb: ['MongoDB', 'database'],
    pymongo: ['MongoDB', 'database'],
    pg: ['PostgreSQL', 'database'],
    postgres: ['PostgreSQL', 'database'],
    psycopg2: ['PostgreSQL', 'database'],
    'psycopg2-binary': ['PostgreSQL', 'database'],
    asyncpg: ['PostgreSQL', 'database'],
    'github.com/lib/pq': ['PostgreSQL', 'database'],
    'github.com/jackc/pgx': ['PostgreSQL', 'database'],
    Npgsql: ['PostgreSQL', 'database'],
    mysql: ['MySQL', 'database'],
    mysql2: ['MySQL', 'database'],
    sqlite3: ['SQLite', 'database'],
    'better-sqlite3': ['SQLite', 'database'],
    knex: ['SQL (Knex)', 'database'],
    typeorm: ['SQL (TypeORM)', 'database'],
    sequelize: ['SQL (Sequelize)', 'database'],
    'drizzle-orm': ['SQL (Drizzle)', 'database'],
    sqlalchemy: ['SQL (SQLAlchemy)', 'database'],
    sqlmodel: ['SQL (SQLModel)', 'database'],
    psycopg: ['PostgreSQL', 'database'],
    'gorm.io/gorm': ['SQL (GORM)', 'database'],
    'Microsoft.EntityFrameworkCore': ['Entity Framework', 'database'],
    Dapper: ['SQL (Dapper)', 'database'],
    sqlx: ['SQL (sqlx)', 'database'],
    diesel: ['SQL (Diesel)', 'database'],
    redis: ['Redis', 'cache'],
    ioredis: ['Redis', 'cache'],
    'github.com/redis/go-redis': ['Redis', 'cache'],
    'StackExchange.Redis': ['Redis', 'cache'],
    '@supabase/supabase-js': ['Supabase', 'database'],
    firebase: ['Firebase', 'database'],
    'firebase-admin': ['Firebase', 'database'],
    '@aws-sdk/client-s3': ['S3', 'storage'],
    '@google-cloud/storage': ['Cloud Storage', 'storage'],
  }
  for (const d of deps) {
    const hit = byDep[d.name]
    if (hit) add(hit[0], hit[1], `dependency ${d.name}`)
  }
  for (const f of files) {
    if (/(^|\/)schema\.prisma$/.test(f.path)) add('Prisma', 'database', f.path)
    if (/(^|\/)(migrations?|db\/migrate)\//.test(f.path) && !map.size)
      add('SQL migrations', 'database', f.path)
    if (/\.sql$/.test(f.path) && !map.size) add('SQL', 'database', f.path)
    if (f.content && /(^|\/)(docker-)?compose(\.\w+)?\.ya?ml$/.test(f.path)) {
      if (/image:\s*['"]?postgres/.test(f.content)) add('PostgreSQL', 'database', f.path)
      if (/image:\s*['"]?mysql|image:\s*['"]?mariadb/.test(f.content))
        add('MySQL', 'database', f.path)
      if (/image:\s*['"]?mongo/.test(f.content)) add('MongoDB', 'database', f.path)
      if (/image:\s*['"]?redis/.test(f.content)) add('Redis', 'cache', f.path)
    }
  }
  return [...map.values()]
}
