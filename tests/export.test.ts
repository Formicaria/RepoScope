import { describe, expect, it } from 'vitest'
import demo from '../src/data/demo.json'
import { toMarkdown } from '../shared/report.js'
import type { ScanResult } from '../shared/types'
import { parseGitHubUrl } from '../server/scans.js'

describe('export and url parsing', () => {
  it('renders a markdown report from the demo scan', () => {
    const scan = demo as unknown as ScanResult
    const md = toMarkdown(scan)
    // Assert the report's shape, not which repository happens to be bundled as the demo.
    expect(md).toContain(`# ${scan.repository.fullName} — architecture report`)
    expect(md).toContain('```mermaid')
    expect(md).toContain('## Warnings')
    expect(md).toContain('Estimated health')
  })

  it('includes the code review, with a fix and evidence for each finding', () => {
    const scan = demo as unknown as ScanResult
    const md = toMarkdown(scan)
    expect(md).toContain('## Code review')
    for (const s of scan.review?.suggestions ?? []) {
      expect(md).toContain(s.title)
      expect(md).toContain(s.fix)
      // Anything pointing at code must cite where, or a reader cannot check it.
      if (s.evidence[0]?.path) expect(md).toContain(s.evidence[0].path)
    }
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
