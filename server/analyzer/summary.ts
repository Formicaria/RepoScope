import type { Finding, ProjectSummary, ScanResult } from '../../shared/types.js'

/**
 * Summary generation. The deterministic template provider is always used first; an optional LLM
 * provider can rewrite the prose but never changes the facts (nodes, edges, warnings, score).
 */
export interface SummaryProvider {
  name: string
  summarize(draft: ProjectSummary, facts: SummaryFacts): Promise<ProjectSummary>
}

export type SummaryFacts = Omit<ScanResult, 'summary' | 'id'>

export function buildTemplateSummary(facts: SummaryFacts): ProjectSummary {
  const {
    repository,
    languages,
    frameworks,
    entryPoints,
    nodes,
    warnings,
    health,
    stats,
    dependencies,
  } = facts
  const top = nodes.filter((n) => !n.parent)
  const byType = (t: string) => top.filter((n) => n.type === t)
  const primaryLang = languages[0]?.name
  const langList = languages.slice(0, 3).map((l) => l.name)
  const fw = frameworks.filter(
    (f) =>
      ![
        'TypeScript',
        'Docker',
        'GitHub Actions',
        'Vitest',
        'Jest',
        'pytest',
        'Docker Compose',
      ].includes(f),
  )

  const apis = byType('api')
  const services = byType('service')
  const dbs = byType('database')
  const uis = byType('component')
  const integrations = byType('integration')
  const apps = byType('app')
  const entries = byType('entry')

  const kind = (() => {
    const hasUI =
      uis.length > 0 ||
      frameworks.some((f) =>
        [
          'React',
          'Vue',
          'Svelte',
          'Angular',
          'Next.js',
          'Nuxt',
          'SvelteKit',
          'Astro',
          'Solid',
          'Remix',
        ].includes(f),
      )
    const hasAPI =
      apis.length > 0 ||
      frameworks.some((f) =>
        [
          'Express',
          'Fastify',
          'Koa',
          'Hono',
          'NestJS',
          'FastAPI',
          'Flask',
          'Django',
          'Gin',
          'Echo',
          'Fiber',
          'Chi',
          'ASP.NET Core',
          'Actix',
          'Axum',
          'Rocket',
          'Ruby on Rails',
          'Laravel',
          'Spring Boot',
        ].includes(f),
      )
    if (apps.length > 1) return 'monorepo'
    if (hasUI && hasAPI) return 'full-stack application'
    if (hasAPI) return 'backend service'
    if (hasUI) return 'frontend application'
    if (entries.some((e) => /cli|bin/i.test(e.path))) return 'command-line tool'
    if (dependencies.length === 0 && stats.files < 30) return 'small project'
    return 'library or service'
  })()

  const headline =
    `${repository.name} is a ${primaryLang ?? ''} ${kind}${fw.length ? ` built with ${joinNatural(fw.slice(0, 4))}` : ''}.`.replace(
      /\s+/g,
      ' ',
    )

  const descriptionParts: string[] = []
  descriptionParts.push(
    `The repository contains ${stats.files} files across ${stats.modules} modules${langList.length ? `, written mainly in ${joinNatural(langList)}` : ''}.`,
  )
  if (entries.length)
    descriptionParts.push(`Execution starts in ${joinNatural(entries.map((e) => e.path))}.`)
  else if (entryPoints.length)
    descriptionParts.push(`Likely entry points: ${joinNatural(entryPoints.slice(0, 3))}.`)
  if (dbs.length)
    descriptionParts.push(`Data is persisted through ${joinNatural(dbs.map((d) => d.name))}.`)
  if (integrations.length)
    descriptionParts.push(
      `It integrates with ${joinNatural(integrations.slice(0, 5).map((i) => i.name))}.`,
    )

  const archParts: string[] = []
  if (apps.length)
    archParts.push(
      `The codebase is organised into ${apps.length} application packages: ${joinNatural(apps.map((a) => a.name))}.`,
    )
  if (uis.length)
    archParts.push(`The UI layer lives in ${joinNatural(uis.slice(0, 4).map((u) => u.path))}.`)
  if (apis.length) {
    const routeCount = apis.reduce((n, a) => n + (a.meta?.routes?.length ?? 0), 0)
    archParts.push(
      `Requests enter through ${joinNatural(apis.slice(0, 4).map((a) => a.path))}${routeCount ? ` (${routeCount} detected routes)` : ''}.`,
    )
  }
  if (services.length)
    archParts.push(
      `Business logic sits in ${joinNatural(services.slice(0, 4).map((s) => s.path))}.`,
    )
  if (dbs.length) {
    const dataModules = top.filter((n) => n.type === 'database' && n.id.startsWith('mod:'))
    if (dataModules.length)
      archParts.push(`Persistence is handled by ${joinNatural(dataModules.map((d) => d.path))}.`)
  }
  const hub = [...top]
    .filter((n) => n.id.startsWith('mod:'))
    .sort((a, b) => b.dependents.length - a.dependents.length)[0]
  if (hub && hub.dependents.length >= 2)
    archParts.push(
      `"${hub.name}" is the most depended-upon module (${hub.dependents.length} dependents), so changes there ripple widely.`,
    )
  if (!archParts.length)
    archParts.push(
      `The project is small enough that its ${stats.modules} modules can be read top to bottom; the graph shows how they reference each other.`,
    )

  const keyFindings: Finding[] = []
  let fid = 0
  const finding = (kind: Finding['kind'], title: string, detail: string) =>
    keyFindings.push({ id: `f${++fid}`, kind, title, detail })

  if (health.score >= 80)
    finding(
      'strength',
      'Healthy fundamentals',
      `Estimated health ${health.score}/100 — tests, documentation and configuration are mostly in place.`,
    )
  const hasTests = !warnings.some((w) => w.kind === 'missing-tests' && w.severity !== 'info')
  if (hasTests && byType('test').length)
    finding(
      'strength',
      'Test suite present',
      `${byType('test')
        .map((t) => t.path)
        .join(', ')} contains automated tests.`,
    )
  if (dbs.length && (services.length || apis.length))
    finding(
      'observation',
      'Layered architecture',
      'API/service code is separated from the persistence layer, which keeps data access in one place.',
    )
  for (const w of warnings.filter((w) => w.severity === 'critical').slice(0, 3))
    finding('risk', w.title, w.detail)
  for (const w of warnings.filter((w) => w.severity === 'warning').slice(0, 3))
    finding('risk', w.title, w.detail)
  if (integrations.length >= 4)
    finding(
      'observation',
      'Many external integrations',
      `${integrations.length} third-party services are wired in; each is a potential point of failure worth isolating behind an interface.`,
    )
  if (!keyFindings.length)
    finding(
      'observation',
      'Nothing unusual',
      'No significant risks were detected with the available heuristics.',
    )

  const nextActions: string[] = []
  for (const w of warnings.slice(0, 6)) {
    switch (w.kind) {
      case 'missing-tests':
        if (!nextActions.some((a) => a.startsWith('Add tests')))
          nextActions.push(
            w.severity === 'critical'
              ? 'Add a test runner and cover the entry point and core modules first.'
              : `Add tests for ${w.path ?? 'untested modules'}.`,
          )
        break
      case 'exposed-secret':
        if (!nextActions.some((a) => a.startsWith('Rotate')))
          nextActions.push(
            'Rotate any credential flagged as exposed and load secrets from the environment.',
          )
        break
      case 'circular-dependency':
        if (!nextActions.some((a) => a.startsWith('Break')))
          nextActions.push('Break import cycles by extracting shared types into a leaf module.')
        break
      case 'dead-module':
        nextActions.push(`Confirm whether ${w.path} is still used; delete it if not.`)
        break
      case 'unclear-entry':
        nextActions.push('Document the primary entry point and run command in the README.')
        break
      case 'excessive-complexity':
        if (!nextActions.some((a) => a.startsWith('Split')))
          nextActions.push(`Split ${w.path ?? 'oversized modules'} into smaller units.`)
        break
      case 'unused-dependency':
        nextActions.push('Prune dependencies that are declared but never imported.')
        break
      default:
        break
    }
  }
  if (!nextActions.length)
    nextActions.push('Keep the module boundaries visible in the map as the project grows.')

  return {
    headline,
    description: descriptionParts.join(' '),
    architecture: archParts.join(' '),
    keyFindings,
    nextActions: nextActions.slice(0, 5),
  }
}

function joinNatural(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Default provider: returns the deterministic template as-is. */
export const templateProvider: SummaryProvider = {
  name: 'template',
  summarize: async (draft) => draft,
}

/**
 * Optional Ollama / OpenAI-compatible provider. Enabled with NEST_LLM_URL (e.g. http://localhost:11434/v1)
 * and NEST_LLM_MODEL. Any failure falls back to the template output so scans never depend on it.
 */
export function createOpenAICompatibleProvider(
  baseUrl: string,
  model: string,
  apiKey?: string,
): SummaryProvider {
  return {
    name: `llm:${model}`,
    async summarize(draft, facts) {
      const prompt = [
        'You are a senior software architect. Rewrite the following architecture summary so it reads naturally.',
        'Do not invent facts. Keep every module path, framework and number exactly as given.',
        'Return JSON with keys: headline, description, architecture (strings).',
        '',
        JSON.stringify({
          repository: facts.repository.name,
          languages: facts.languages.map((l) => l.name),
          frameworks: facts.frameworks,
          entryPoints: facts.entryPoints,
          modules: facts.nodes
            .filter((n) => !n.parent)
            .map((n) => ({ name: n.name, type: n.type, path: n.path })),
          draft,
        }),
      ].join('\n')
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 25_000)
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
          }),
          signal: ctrl.signal,
        })
        if (!res.ok) return draft
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
        const text = data.choices?.[0]?.message?.content ?? ''
        const json = text.match(/\{[\s\S]*\}/)?.[0]
        if (!json) return draft
        const parsed = JSON.parse(json) as Partial<ProjectSummary>
        return {
          ...draft,
          headline: typeof parsed.headline === 'string' ? parsed.headline : draft.headline,
          description:
            typeof parsed.description === 'string' ? parsed.description : draft.description,
          architecture:
            typeof parsed.architecture === 'string' ? parsed.architecture : draft.architecture,
        }
      } catch {
        return draft
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): SummaryProvider {
  if (env.NEST_LLM_URL && env.NEST_LLM_MODEL)
    return createOpenAICompatibleProvider(
      env.NEST_LLM_URL,
      env.NEST_LLM_MODEL,
      env.NEST_LLM_API_KEY,
    )
  return templateProvider
}
