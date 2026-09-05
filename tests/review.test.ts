import { describe, expect, it } from 'vitest'
import { analyzeRepository } from '../server/analyzer/index.js'
import { ALL_RULES } from '../server/analyzer/review/index.js'
import { parsingAvailable } from '../server/analyzer/parse.js'
import type { RepoFile, ScanResult, Suggestion } from '../shared/types.js'

const repo = {
  name: 'app',
  fullName: 'tests/app',
  source: 'upload' as const,
  scannedAt: '2026-01-01T00:00:00Z',
}

const f = (path: string, content = ''): RepoFile => ({ path, size: content.length, content })

/** The manifest and entry point that make a fixture look like a deployed application. */
const APP_BASE: RepoFile[] = [
  f(
    'package.json',
    JSON.stringify({ name: 'app', main: 'src/server.ts', dependencies: { express: '^4' } }),
  ),
  f('src/server.ts', "import express from 'express'\nconst app = express()\napp.listen(3000)"),
  f('tests/server.test.ts', "import { x } from '../src/server'\ntest('boots', () => {})"),
]

async function review(files: RepoFile[]): Promise<ScanResult['review']> {
  const result = await analyzeRepository(repo, files)
  return result.review
}

const find = (r: ScanResult['review'], rule: string): Suggestion | undefined =>
  r?.suggestions.find((s) => s.rule === rule)

/**
 * Rules that read the syntax tree cannot run without the optional grammars. The fallback
 * build reports that honestly (see ReviewPanel), so these assertions are skipped rather
 * than failed when the parser is unavailable.
 */
const needsParser = () => !parsingAvailable()

describe('review rules', () => {
  it('gives every rule a stable id, a fix and a distinct identity', () => {
    const ids = ALL_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const rule of ALL_RULES) {
      expect(rule.id).toMatch(/^[a-z]+\/[a-z-]+$/)
    }
  })

  it('finds SQL built by interpolation and says how to parameterise it', async () => {
    if (needsParser()) return
    const r = await review([
      ...APP_BASE,
      f(
        'src/users.ts',
        'export async function get(id: string) {\n' +
          '  return db.query(`SELECT * FROM users WHERE id = ${id}`)\n' +
          '}',
      ),
    ])
    const finding = find(r, 'security/sql-injection')
    expect(finding).toBeDefined()
    expect(finding!.severity).toBe('critical')
    expect(finding!.evidence[0].path).toBe('src/users.ts')
    expect(finding!.evidence[0].line).toBe(2)
    // The fix must be concrete enough to act on without further research.
    expect(finding!.fix).toMatch(/parameter/i)
  })

  it('does not flag a parameterised query', async () => {
    const r = await review([
      ...APP_BASE,
      f(
        'src/users.ts',
        'export async function get(id: string) {\n' +
          '  return db.query("SELECT * FROM users WHERE id = $1", [id])\n' +
          '}',
      ),
    ])
    expect(find(r, 'security/sql-injection')).toBeUndefined()
  })

  it('reports a secret that falls back to a hard-coded default', async () => {
    const r = await review([
      ...APP_BASE,
      f('src/config.ts', 'export const secret = process.env.JWT_SECRET || "dev-secret-value"'),
    ])
    const finding = find(r, 'security/secret-default-value')
    expect(finding).toBeDefined()
    expect(finding!.severity).toBe('critical')
  })

  it('never echoes a credential into the evidence it shows', async () => {
    const r = await review([
      ...APP_BASE,
      f(
        'src/config.ts',
        'const password = "hunter2-super-secret-value"\nconst secret = process.env.SECRET || "fallback-secret-here"',
      ),
    ])
    const text = JSON.stringify(r)
    expect(text).not.toContain('hunter2-super-secret-value')
    expect(text).not.toContain('fallback-secret-here')
  })

  it('finds catch blocks that discard or merely log the error', async () => {
    if (needsParser()) return
    const body = (n: number) =>
      Array.from(
        { length: n },
        (_, i) =>
          `export async function op${i}() {\n  try {\n    await work()\n  } catch (e) {\n    console.error(e)\n  }\n}`,
      ).join('\n')
    const r = await review([
      ...APP_BASE,
      f('src/a.ts', body(4)),
      f('src/b.ts', 'export function x() {\n  try {\n    work()\n  } catch {}\n}'),
    ])
    const swallowed = r?.suggestions.filter((s) => s.rule === 'craft/swallowed-errors') ?? []
    expect(swallowed.length).toBe(2)
    expect(swallowed.some((s) => s.title.includes('discard'))).toBe(true)
    expect(swallowed.some((s) => s.title.includes('log'))).toBe(true)
  })

  it('does not flag a catch block that rethrows or returns a response', async () => {
    const r = await review([
      ...APP_BASE,
      f(
        'src/a.ts',
        'export async function op() {\n  try {\n    await work()\n  } catch (e) {\n    logger.error(e)\n    throw e\n  }\n}',
      ),
    ])
    expect(find(r, 'craft/swallowed-errors')).toBeUndefined()
  })

  it('spots comments that restate the line below them, and keeps the ones that explain why', async () => {
    if (needsParser()) return
    const narrating = Array.from(
      { length: 8 },
      (_, i) => `// set the user name ${i}\nconst userName${i} = getUserName(${i})`,
    ).join('\n')
    const r = await review([...APP_BASE, f('src/a.ts', narrating)])
    expect(find(r, 'craft/narrating-comments')).toBeDefined()

    const explaining = Array.from(
      { length: 8 },
      (_, i) =>
        `// The upstream API returns 204 with a body, because of a bug in their gateway ${i}\nconst userName${i} = getUserName(${i})`,
    ).join('\n')
    const clean = await review([...APP_BASE, f('src/a.ts', explaining)])
    expect(find(clean, 'craft/narrating-comments')).toBeUndefined()
  })

  it('reports images without alt text and inputs with nothing to label them', async () => {
    if (needsParser()) return
    const r = await review([
      f(
        'package.json',
        JSON.stringify({ name: 'app', dependencies: { react: '^18', next: '^14' } }),
      ),
      f('src/app/layout.tsx', 'export default function L() { return <html /> }'),
      f(
        'src/components/Profile.tsx',
        'export function Profile() {\n' +
          '  return (<div>\n' +
          '    <img src="/a.png" />\n' +
          '    <input type="text" name="a" />\n' +
          '    <input type="text" name="b" />\n' +
          '    <input type="text" name="c" />\n' +
          '  </div>)\n' +
          '}',
      ),
    ])
    expect(find(r, 'accessibility/images-without-alt')).toBeDefined()
    expect(find(r, 'accessibility/inputs-without-labels')).toBeDefined()
  })

  it('does not apply application rules to a library', async () => {
    // A library declares no framework dependency, so telling it to add helmet or a
    // .env.example would be nonsense.
    const r = await review([
      f('package.json', JSON.stringify({ name: 'my-lib', main: 'src/index.ts' })),
      f('src/index.ts', 'export const x = process.env.SOMETHING\nexport const y = 1'),
      f('src/b.ts', 'export const z = process.env.OTHER'),
      f('src/c.ts', 'export const w = process.env.THIRD'),
    ])
    expect(find(r, 'security/missing-security-headers')).toBeUndefined()
    expect(find(r, 'documentation/no-env-example')).toBeUndefined()
  })

  it('ignores examples, docs and tests when judging the shipped code', async () => {
    const noisy = 'export function x() {\n  try {\n    work()\n  } catch {}\n}'
    const r = await review([
      ...APP_BASE,
      f('examples/demo/index.ts', noisy),
      f('docs/snippets/sample.ts', noisy),
      f('tests/helpers.ts', noisy),
    ])
    expect(find(r, 'craft/swallowed-errors')).toBeUndefined()
  })

  it('produces an actionable shape for every finding', async () => {
    const r = await review([
      ...APP_BASE,
      f('src/bad.ts', 'export function x() {\n  try { work() } catch {}\n}'),
    ])
    expect(r!.suggestions.length).toBeGreaterThan(0)
    for (const s of r!.suggestions) {
      // Terse is fine ('No README'); vague is not.
      expect(s.title.length).toBeGreaterThan(5)
      expect(s.detail.length).toBeGreaterThan(30)
      expect(s.fix.length).toBeGreaterThan(30)
      expect(['critical', 'high', 'medium', 'low']).toContain(s.severity)
      // Anything pointing at code must say where, or it cannot be checked.
      if (s.evidence.length) expect(s.evidence[0].path).toBeTruthy()
    }
  })

  it('lowers the health score for confident security findings only', async () => {
    const clean = await analyzeRepository(repo, APP_BASE)
    const vulnerable = await analyzeRepository(repo, [
      ...APP_BASE,
      f('src/config.ts', 'export const s = process.env.JWT_SECRET || "hardcoded-fallback"'),
    ])
    expect(vulnerable.health.score).toBeLessThan(clean.health.score)
    expect(vulnerable.health.breakdown.some((b) => b.signal === 'Security review')).toBe(true)
  })

  it('survives a rule that throws', async () => {
    const { runReview } = await import('../server/analyzer/review/index.js')
    const result = runReview({
      files: [f('a.ts', 'const x = 1')],
      parsed: new Map(),
      graph: {
        nodes: [],
        edges: [],
        modules: [],
        moduleEdges: [],
        fileModule: new Map(),
        fileNode: new Map(),
      },
      dependencies: [],
      routes: [],
      entryPoints: [],
      frameworks: [],
      rules: [
        {
          id: 'test/throws',
          category: 'craft',
          severity: 'low',
          run() {
            throw new Error('boom')
          },
        },
        {
          id: 'test/works',
          category: 'craft',
          severity: 'low',
          run: () => ({ title: 'A finding that is long enough', detail: 'x', fix: 'y' }),
        },
      ],
    })
    expect(result.suggestions.map((s) => s.rule)).toEqual(['test/works'])
  })
})
