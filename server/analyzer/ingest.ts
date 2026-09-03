import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RepoFile } from '../../shared/types.js'

/** Directories that never carry architectural meaning. */
export const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'bin',
  'obj',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'vendor',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.idea',
  '.vscode',
  '.gradle',
  'Pods',
  'DerivedData',
  'packages/.cache',
  '.yarn',
  '.pnpm-store',
])

/** File name patterns that are generated, vendored or otherwise noise. */
const IGNORED_FILE_PATTERNS: RegExp[] = [
  /\.min\.(js|css)$/i,
  /\.(map|lock)$/i,
  /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/,
  /\.generated\.[a-z]+$/i,
  /\.g\.(cs|dart)$/i,
  /\.designer\.cs$/i,
  /\.pb\.go$/i,
  /_pb2\.py$/i,
  /\.d\.ts$/i,
  /\.snap$/i,
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff|pdf|zip|gz|tar|7z|rar|woff2?|ttf|otf|eot|mp3|mp4|wav|mov|avi|exe|dll|so|dylib|class|jar|pyc|o|a|bin|wasm)$/i,
]

/** Environment / secret-carrying files: recorded by name, never read. */
export const SECRET_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^(id_rsa|id_ed25519|id_dsa)$/,
  /credentials\.json$/i,
  /service-account.*\.json$/i,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.netrc$/,
]

export const MAX_CONTENT_BYTES = 256 * 1024
export const MAX_FILES = 6000

export function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name)
}

export function isIgnoredFile(name: string): boolean {
  return IGNORED_FILE_PATTERNS.some((re) => re.test(name))
}

export function isSecretFile(name: string): boolean {
  return SECRET_FILE_PATTERNS.some((re) => re.test(name))
}

function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 2048)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/** Walk a directory on disk and return the files the analyzer should look at. */
export async function readRepositoryFromDisk(root: string): Promise<RepoFile[]> {
  const files: RepoFile[] = []
  async function walk(dir: string) {
    if (files.length >= MAX_FILES) return
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      const abs = path.join(dir, entry.name)
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (entry.isDirectory()) {
        if (isIgnoredDir(entry.name)) continue
        await walk(abs)
      } else if (entry.isFile()) {
        if (isIgnoredFile(entry.name)) continue
        const stat = await fs.stat(abs)
        if (isSecretFile(entry.name)) {
          files.push({ path: rel, size: stat.size })
          continue
        }
        if (stat.size > MAX_CONTENT_BYTES) {
          files.push({ path: rel, size: stat.size })
          continue
        }
        const buf = await fs.readFile(abs)
        if (looksBinary(buf)) {
          files.push({ path: rel, size: stat.size })
        } else {
          files.push({ path: rel, size: stat.size, content: buf.toString('utf8') })
        }
      }
    }
  }
  await walk(root)
  return files
}

/** Apply the same ignore rules to a list of files that arrived from a browser upload. */
export function filterUploadedFiles(files: RepoFile[]): RepoFile[] {
  const out: RepoFile[] = []
  for (const f of files) {
    const parts = f.path.split('/')
    const name = parts[parts.length - 1]
    if (parts.slice(0, -1).some(isIgnoredDir)) continue
    if (isIgnoredFile(name)) continue
    if (isSecretFile(name)) {
      out.push({ path: f.path, size: f.size })
      continue
    }
    if (f.content && f.content.length > MAX_CONTENT_BYTES) {
      out.push({ path: f.path, size: f.size })
      continue
    }
    out.push(f)
    if (out.length >= MAX_FILES) break
  }
  return out
}

/** Strip a common leading folder (uploads usually arrive as "my-project/..."). */
export function stripCommonRoot(files: RepoFile[]): RepoFile[] {
  if (files.length === 0) return files
  const first = files[0].path.split('/')[0]
  if (!first || files.some((f) => !f.path.startsWith(first + '/'))) return files
  return files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }))
}
