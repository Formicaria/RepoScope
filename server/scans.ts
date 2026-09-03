import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { simpleGit } from 'simple-git'
import type { RepoFile, Repository, ScanResult, ScanStatus } from '../shared/types.js'
import { analyzeRepository } from './analyzer/index.js'
import { filterUploadedFiles, readRepositoryFromDisk, stripCommonRoot } from './analyzer/ingest.js'
import { providerFromEnv } from './analyzer/summary.js'

/** In-memory scan registry (MVP). Results are also cached in the browser's localStorage. */
const scans = new Map<string, ScanStatus>()
const MAX_SCANS = 50
const CLONE_TIMEOUT_MS = 120_000
const MAX_REPO_KB = 400_000 // ~400 MB as reported by the GitHub API

export function getScan(id: string): ScanStatus | undefined {
  return scans.get(id)
}

export function listScans(): ScanStatus[] {
  return [...scans.values()]
}

function newId(): string {
  return randomBytes(6).toString('hex')
}

function register(): ScanStatus {
  if (scans.size >= MAX_SCANS) {
    const oldest = scans.keys().next().value
    if (oldest) scans.delete(oldest)
  }
  const status: ScanStatus = { id: newId(), stage: 'queued', progress: 0 }
  scans.set(status.id, status)
  return status
}

export interface ParsedGitHubUrl {
  owner: string
  repo: string
  url: string
}

export function parseGitHubUrl(input: string): ParsedGitHubUrl | undefined {
  const s = input.trim()
  const m =
    s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i) ??
    s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i) ??
    s.match(/^([\w.-]+)\/([\w.-]+)$/)
  if (!m) return undefined
  const owner = m[1]
  const repo = m[2]
  if (owner.startsWith('.') || repo.startsWith('.')) return undefined
  return { owner, repo, url: `https://github.com/${owner}/${repo}` }
}

interface GitHubMeta {
  exists: boolean
  private?: boolean
  sizeKb?: number
  defaultBranch?: string
  description?: string
}

async function fetchGitHubMeta(p: ParsedGitHubUrl): Promise<GitHubMeta> {
  try {
    const res = await fetch(`https://api.github.com/repos/${p.owner}/${p.repo}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'reposcope-scan' },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) return { exists: false }
    if (!res.ok) return { exists: true } // rate limited etc. — let the clone decide
    const data = (await res.json()) as {
      private?: boolean
      size?: number
      default_branch?: string
      description?: string
    }
    return {
      exists: true,
      private: data.private,
      sizeKb: data.size,
      defaultBranch: data.default_branch,
      description: data.description ?? undefined,
    }
  } catch {
    return { exists: true }
  }
}

/** Start a scan of a public GitHub repository. Returns immediately; poll getScan() for progress. */
export function startGitHubScan(input: string): ScanStatus {
  const status = register()
  const parsed = parseGitHubUrl(input)
  if (!parsed) {
    status.stage = 'error'
    status.error = {
      code: 'invalid-repo',
      message:
        'That does not look like a GitHub repository. Use a URL like https://github.com/owner/repo.',
    }
    return status
  }
  void runGitHubScan(status, parsed)
  return status
}

async function runGitHubScan(status: ScanStatus, parsed: ParsedGitHubUrl) {
  const update = (stage: ScanStatus['stage'], progress: number, message?: string) => {
    status.stage = stage
    status.progress = progress
    status.message = message
  }
  let dir: string | undefined
  try {
    update('reading', 5, `Looking up ${parsed.owner}/${parsed.repo}`)
    const meta = await fetchGitHubMeta(parsed)
    if (!meta.exists) {
      status.stage = 'error'
      status.error = {
        code: 'private-repo',
        message: `GitHub returned "not found" for ${parsed.owner}/${parsed.repo}. Either the repository does not exist or it is private — private repositories require authentication, which this MVP does not support. Upload the project folder instead.`,
      }
      return
    }
    if (meta.private) {
      status.stage = 'error'
      status.error = {
        code: 'private-repo',
        message:
          'This repository is private. Authentication is required to read it; upload the folder instead.',
      }
      return
    }
    if (meta.sizeKb && meta.sizeKb > MAX_REPO_KB) {
      status.stage = 'error'
      status.error = {
        code: 'too-large',
        message: `This repository is about ${Math.round(meta.sizeKb / 1024)} MB, above the ${Math.round(MAX_REPO_KB / 1024)} MB limit for the hosted scanner.`,
      }
      return
    }
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reposcope-'))
    update('reading', 10, 'Cloning repository (shallow)')
    const git = simpleGit({ timeout: { block: CLONE_TIMEOUT_MS } })
    await git.clone(parsed.url + '.git', dir, ['--depth', '1', '--single-branch', '--no-tags'])
    update('reading', 18, 'Reading files')
    const files = await readRepositoryFromDisk(dir)
    if (files.length === 0) {
      status.stage = 'error'
      status.error = {
        code: 'invalid-repo',
        message: 'The repository is empty or contains only ignored files.',
      }
      return
    }
    const repository: Repository = {
      name: parsed.repo,
      fullName: `${parsed.owner}/${parsed.repo}`,
      url: parsed.url,
      source: 'github',
      defaultBranch: meta.defaultBranch,
      scannedAt: new Date().toISOString(),
    }
    await finish(status, repository, files, update)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    status.stage = 'error'
    if (/Authentication|could not read Username|Repository not found|access denied/i.test(msg)) {
      status.error = {
        code: 'private-repo',
        message: `GitHub refused the clone of ${parsed.owner}/${parsed.repo}: the repository either does not exist or is private. Private repositories need authentication, which this MVP does not support — upload the project folder instead.`,
      }
    } else if (/timed out|timeout/i.test(msg)) {
      status.error = {
        code: 'too-large',
        message: 'Cloning took too long. Try a smaller repository or upload the folder.',
      }
    } else {
      status.error = {
        code: 'internal',
        message: `Scan failed: ${msg.split('\n')[0].slice(0, 200)}`,
      }
    }
  } finally {
    if (dir) fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Scan files that the browser read from a local folder. */
export function startUploadScan(name: string, rawFiles: RepoFile[]): ScanStatus {
  const status = register()
  const files = filterUploadedFiles(stripCommonRoot(rawFiles))
  if (files.length === 0) {
    status.stage = 'error'
    status.error = {
      code: 'invalid-repo',
      message: 'No analysable files were found in the uploaded folder.',
    }
    return status
  }
  const repository: Repository = {
    name,
    fullName: name,
    source: 'upload',
    scannedAt: new Date().toISOString(),
  }
  void finish(status, repository, files, (stage, progress, message) => {
    status.stage = stage
    status.progress = progress
    status.message = message
  }).catch((err) => {
    status.stage = 'error'
    status.error = {
      code: 'internal',
      message: `Scan failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  })
  return status
}

async function finish(
  status: ScanStatus,
  repository: Repository,
  files: RepoFile[],
  update: (stage: ScanStatus['stage'], progress: number, message?: string) => void,
) {
  update('reading', 20, `${files.length} files read`)
  const result: ScanResult = await analyzeRepository(repository, files, {
    provider: providerFromEnv(),
    onProgress: update,
  })
  result.id = status.id
  status.result = result
  update('done', 100, 'Done')
}

/** Insert a precomputed result (used for the bundled demo so it is shareable too). */
export function registerResult(result: ScanResult): ScanStatus {
  const status = register()
  status.stage = 'done'
  status.progress = 100
  status.result = { ...result, id: status.id }
  return status
}
