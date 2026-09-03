import { describe, expect, it } from 'vitest'
import demo from '../src/data/demo.json'
import { toMarkdown } from '../shared/report.js'
import type { ScanResult } from '../shared/types'
import { parseGitHubUrl } from '../server/scans.js'

describe('export and url parsing', () => {
  it('renders a markdown report from the demo scan', () => {
    const md = toMarkdown(demo as unknown as ScanResult)
    expect(md).toContain('# fastapi/full-stack-fastapi-template — architecture report')
    expect(md).toContain('```mermaid')
    expect(md).toContain('## Warnings')
    expect(md).toContain('Estimated health')
  })

  it('parses GitHub URLs in common shapes', () => {
    expect(parseGitHubUrl('https://github.com/owner/repo')).toMatchObject({
      owner: 'owner',
      repo: 'repo',
    })
    expect(parseGitHubUrl('github.com/owner/repo.git/')).toMatchObject({
      owner: 'owner',
      repo: 'repo',
    })
    expect(parseGitHubUrl('git@github.com:owner/repo.git')).toMatchObject({
      owner: 'owner',
      repo: 'repo',
    })
    expect(parseGitHubUrl('owner/repo')).toMatchObject({ owner: 'owner', repo: 'repo' })
    expect(parseGitHubUrl('https://github.com/owner/repo/tree/main/src')).toMatchObject({
      owner: 'owner',
      repo: 'repo',
    })
    expect(parseGitHubUrl('https://gitlab.com/owner/repo')).toBeUndefined()
    expect(parseGitHubUrl('not a url')).toBeUndefined()
  })
})
