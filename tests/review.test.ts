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

  /**
   * These exact shapes leaked in 0.4.0: the redaction guard looked for `\bsecret\b`, which
   * never matches `JWT_SECRET` because `_` is a word character. Every line here is a real
   * one taken from the scan that found the bug.
   */
  it('redacts credentials that are part of a longer identifier', async () => {
    const r = await review([
      ...APP_BASE,
      f(
        'src/token.utils.ts',
        'export const sign = (id: string) =>\n' +
          "  jwt.sign({ user: { id } }, process.env.JWT_SECRET || 'superSecretValue', {\n" +
          "    expiresIn: '60d',\n" +
          '  })\n' +
          "const AWS_SECRET_ACCESS_KEY = 'AKIAZZZZQQQQ1234ABCD'\n" +
          "const DATABASE_URL = 'postgres://admin:hunter2pass@db.internal:5432/app'\n",
      ),
    ])
    const text = JSON.stringify(r)
    expect(text).not.toContain('superSecretValue')
    expect(text).not.toContain('AKIAZZZZQQQQ1234ABCD')
    expect(text).not.toContain('hunter2pass')
  })

  it('does not redact ordinary string literals', async () => {
    const { redact } = await import('../server/analyzer/review/index.js')
    expect(redact("const author = 'Jane Doe'")).toContain('Jane Doe')
    expect(redact('log.info(`user ${id} signed in`)')).toContain('signed in')
    expect(redact(undefined)).toBeUndefined()
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

  it('ignores tests written in the same file as the code they test', async () => {
    if (needsParser()) return
    // Two distinct blocks, each repeated three times, entirely inside `#[cfg(test)]`.
    const block = (kind: string, i: number) =>
      `        let builder_${kind}${i} = GlobBuilder::new(pattern_${kind});\n` +
      `        builder_${kind}${i}.set_case_insensitive(${kind === 'ci'});\n` +
      `        let glob_${kind}${i} = builder_${kind}${i}.build().unwrap();\n` +
      `        let matcher_${kind}${i} = glob_${kind}${i}.compile_matcher();\n` +
      `        assert!(matcher_${kind}${i}.is_match(candidate_${kind}));\n` +
      `        assert_eq!(glob_${kind}${i}.glob(), pattern_${kind});`
    const repeated = (kind: string) =>
      [0, 1, 2]
        .map((i) => block(kind, i).replace(new RegExp(`_${kind}${i}`, 'g'), `_${kind}`))
        .join('\n        drop(());\n')
    const tests =
      '#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn matching() {\n' +
      repeated('ci') +
      '\n' +
      repeated('cs') +
      '\n    }\n}\n'
    const lib = 'pub fn compile(pattern: &str) -> Glob {\n    Glob::new(pattern)\n}\n\n'

    const withTests = await review([
      f('Cargo.toml', '[package]\nname = "globs"\nversion = "0.1.0"'),
      f('src/lib.rs', lib + tests),
    ])
    expect(find(withTests, 'craft/duplicated-blocks')).toBeUndefined()

    // The same duplication outside a test block is still reported, so the exclusion is
    // narrow rather than a way of hiding findings.
    const inProductCode = await review([
      f('Cargo.toml', '[package]\nname = "globs"\nversion = "0.1.0"'),
      f(
        'src/lib.rs',
        lib + tests.replace('#[cfg(test)]\nmod tests', 'pub mod helpers').replace('#[test]\n', ''),
      ),
    ])
    expect(find(inProductCode, 'craft/duplicated-blocks')).toBeDefined()
  })

  it('tells commented-out code apart from documentation and wrapped prose', async () => {
    if (needsParser()) return
    const prose = [
      '/// Decompresses the stream.',
      '///',
      '/// # Example',
      '///',
      '/// ```',
      '/// use std::io::Read;',
      '/// let reader = DecompressionReader::new(path)?;',
      '/// ```',
      '// We close stdout before reading, because if the child is still writing',
      '// from the process, then closing stdout above results in',
      '// return `false` even when the path is something resembling',
      '// if we know we have not hit EOF (so we anticipate a broken pipe',
      '// GPL (gpl.txt, etc.)',
      'pub fn run() -> u8 {',
      '    0',
      '}',
    ].join('\n')
    const clean = await review([
      f('Cargo.toml', '[package]\nname = "d"\nversion = "0.1.0"'),
      f('src/lib.rs', prose),
    ])
    expect(find(clean, 'craft/commented-out-code')).toBeUndefined()

    const dead = Array.from(
      { length: 8 },
      (_, i) => `    // let value_${i} = compute_${i}(input);\n    let value_${i} = 0;`,
    ).join('\n')
    const flagged = await review([
      f('Cargo.toml', '[package]\nname = "d"\nversion = "0.1.0"'),
      f('src/lib.rs', `pub fn run() {\n${dead}\n}`),
    ])
    expect(find(flagged, 'craft/commented-out-code')).toBeDefined()
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

describe('.reposcope.json', () => {
  const cfg = (value: unknown) => f('.reposcope.json', JSON.stringify(value))
  const LEAKY = f('src/config.ts', 'export const s = process.env.JWT_SECRET || "dev-secret-value"')

  it('is absent by default and says nothing about being configured', async () => {
    const r = await review([...APP_BASE, LEAKY])
    expect(r?.configured).toBeUndefined()
    expect(find(r, 'security/secret-default-value')).toBeDefined()
  })

  it('switches a rule off when the repository disables it', async () => {
    const r = await review([
      ...APP_BASE,
      LEAKY,
      cfg({ review: { disable: ['security/secret-default-value'] } }),
    ])
    expect(find(r, 'security/secret-default-value')).toBeUndefined()
    expect(r?.configured?.source).toBe('.reposcope.json')
    expect(r?.configured?.rulesDisabled).toBe(1)
  })

  it('excludes ignored paths, including a bare directory prefix', async () => {
    const r = await review([
      ...APP_BASE,
      f('legacy/db/query.ts', LEAKY.content!),
      cfg({ review: { ignore: ['legacy'] } }),
    ])
    expect(find(r, 'security/secret-default-value')).toBeUndefined()
    expect(r?.configured?.pathsIgnored).toBe(1)
  })

  it('applies a severity override without hiding the finding', async () => {
    const r = await review([
      ...APP_BASE,
      LEAKY,
      cfg({ review: { severity: { 'security/secret-default-value': 'low' } } }),
    ])
    expect(find(r, 'security/secret-default-value')?.severity).toBe('low')
  })

  it('treats a severity of "off" as disabling the rule', async () => {
    const r = await review([
      ...APP_BASE,
      LEAKY,
      cfg({ review: { severity: { 'security/secret-default-value': 'off' } } }),
    ])
    expect(find(r, 'security/secret-default-value')).toBeUndefined()
  })

  it('reports a malformed config instead of silently obeying or ignoring it', async () => {
    const r = await review([...APP_BASE, LEAKY, f('.reposcope.json', '{ "review": ')])
    expect(r?.configured?.problems.join(' ')).toMatch(/not valid JSON/)
    // A broken config must not disable the review.
    expect(find(r, 'security/secret-default-value')).toBeDefined()
  })

  it('reports fields of the wrong shape and keeps the rest of the config', async () => {
    const r = await review([
      ...APP_BASE,
      LEAKY,
      cfg({
        review: { ignore: 'legacy', severity: { 'security/secret-default-value': 'urgent' } },
      }),
    ])
    const problems = r!.configured!.problems.join(' ')
    expect(problems).toMatch(/"review.ignore"/)
    expect(problems).toMatch(/severity/)
    expect(find(r, 'security/secret-default-value')?.severity).toBe('critical')
  })

  it('matches path patterns the way the documentation says it does', async () => {
    const { matchesPattern } = await import('../server/analyzer/review/index.js')
    expect(matchesPattern('legacy', 'legacy/db/query.ts')).toBe(true)
    expect(matchesPattern('legacy', 'legacy-tools/db.ts')).toBe(false)
    expect(matchesPattern('src/**', 'src/a/b.ts')).toBe(true)
    expect(matchesPattern('src/**', 'src')).toBe(true)
    expect(matchesPattern('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matchesPattern('src/*.ts', 'src/a/b.ts')).toBe(false)
  })
})
