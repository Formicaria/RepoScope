import { evidenceFrom, type ReviewContext, type Rule } from './context.js'

/**
 * Rules about what the user of the software experiences: accessibility, error and loading
 * states, and the project hygiene that decides whether the next engineer can ship safely.
 */

const FRONTEND_FRAMEWORKS = [
  'React',
  'Next.js',
  'Vue',
  'Nuxt',
  'Svelte',
  'SvelteKit',
  'Angular',
  'Solid',
  'Astro',
  'Remix',
]

function hasFrontend(ctx: ReviewContext): boolean {
  return FRONTEND_FRAMEWORKS.some((f) => ctx.frameworks.has(f))
}

const imagesWithoutAlt: Rule = {
  id: 'accessibility/images-without-alt',
  category: 'accessibility',
  severity: 'medium',
  confidence: 'certain',
  effort: 'quick',
  run(ctx) {
    const hits: { path: string; line: number }[] = []
    let total = 0
    for (const { file, structure } of ctx.structures) {
      for (const el of structure.elements) {
        if (el.name !== 'img' && el.name !== 'Image') continue
        total++
        if (!el.attrs.includes('alt')) hits.push({ path: file.path, line: el.line })
      }
    }
    if (!hits.length) return
    return {
      title: `${hits.length} of ${total} images have no \`alt\` attribute`,
      detail:
        'A screen reader announces the file name — or nothing — where the image should have been. Alt text is also what shows when the image fails to load, which is the common case on a slow connection.',
      fix: 'Describe what the image conveys, in the context it appears: `alt="Revenue by quarter, rising through Q3"`. For purely decorative images use `alt=""` so assistive technology skips them deliberately rather than by accident.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const clickableNonInteractive: Rule = {
  id: 'accessibility/clickable-non-interactive',
  category: 'accessibility',
  severity: 'medium',
  confidence: 'likely',
  effort: 'moderate',
  run(ctx) {
    const hits: { path: string; line: number }[] = []
    for (const { file, structure } of ctx.structures) {
      for (const el of structure.elements) {
        if (!/^(div|span|li|td|section|article|p|img)$/.test(el.name)) continue
        if (!el.attrs.includes('onClick')) continue
        const keyboardReachable =
          el.attrs.includes('onKeyDown') ||
          el.attrs.includes('onKeyPress') ||
          el.attrs.includes('tabIndex')
        const announced = el.attrs.includes('role')
        if (!keyboardReachable || !announced) hits.push({ path: file.path, line: el.line })
      }
    }
    if (!hits.length) return
    return {
      title: `${hits.length} clickable elements that a keyboard cannot reach`,
      detail:
        'A `<div onClick>` is invisible to keyboard and screen-reader users: it takes no focus, announces no role, and does not respond to Enter or Space. Anyone not using a mouse simply cannot perform the action.',
      fix: 'Use `<button type="button">` and style it — that gets focus, keyboard activation and the right role for free. When the element genuinely cannot be a button, add `role="button"`, `tabIndex={0}` and a key handler together; all three are required, not alternatives.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const inputsWithoutLabels: Rule = {
  id: 'accessibility/inputs-without-labels',
  category: 'accessibility',
  severity: 'medium',
  confidence: 'likely',
  effort: 'quick',
  run(ctx) {
    const hits: { path: string; line: number }[] = []
    let total = 0
    for (const { file, structure } of ctx.structures) {
      for (const el of structure.elements) {
        if (!/^(input|select|textarea)$/.test(el.name)) continue
        const type = structure.attributes.find(
          (a) => a.line === el.line && a.name === 'type',
        )?.value
        if (type && /hidden|submit|button/.test(type)) continue
        total++
        const labelled =
          el.attrs.includes('id') ||
          el.attrs.some((a) => /^aria-label(ledby)?$/.test(a)) ||
          el.attrs.includes('title')
        if (!labelled) hits.push({ path: file.path, line: el.line })
      }
    }
    if (hits.length < 3) return
    return {
      title: `${hits.length} of ${total} form fields have nothing to label them`,
      detail:
        'Without a `<label for>`, `aria-label` or `aria-labelledby`, a screen reader announces the field as "edit text" with no indication of what belongs in it. Placeholder text does not count — it disappears as soon as the user types.',
      fix: 'Give each field an `id` and a matching `<label htmlFor>`; that also makes the label clickable, which enlarges the tap target. Use `aria-label` only where a visible label genuinely cannot exist.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const noErrorBoundary: Rule = {
  id: 'reliability/no-error-boundary',
  category: 'reliability',
  severity: 'medium',
  confidence: 'likely',
  effort: 'moderate',
  run(ctx) {
    if (!ctx.frameworks.has('React') && !ctx.frameworks.has('Next.js')) return
    const componentFiles = ctx.sourceFiles.filter((f) => /\.(tsx|jsx)$/.test(f.path))
    if (componentFiles.length < 8) return
    const hasBoundary = ctx.sourceFiles.some(
      (f) =>
        /componentDidCatch|getDerivedStateFromError|ErrorBoundary|react-error-boundary/.test(
          f.content ?? '',
        ) || /(^|\/)(error|global-error)\.(tsx|jsx)$/.test(f.path),
    )
    if (hasBoundary) return
    return {
      title: 'No error boundary anywhere in the React tree',
      detail:
        'An exception thrown while rendering unmounts the entire component tree — React replaces the app with a blank page. The user sees nothing, no message and no way back, and the error is never reported.',
      fix: 'Wrap the app, and any independently failing region, in an error boundary that renders a recovery UI and reports the error. In Next.js the App Router does this with `error.tsx` and `global-error.tsx`; elsewhere `react-error-boundary` is a few lines.',
      evidence: [],
    }
  },
}

const unhandledAsyncUi: Rule = {
  id: 'reliability/fetch-without-states',
  category: 'reliability',
  severity: 'medium',
  confidence: 'possible',
  effort: 'moderate',
  run(ctx) {
    if (!hasFrontend(ctx)) return
    const hits: { path: string; line: number }[] = []
    for (const { file, structure } of ctx.structures) {
      if (!/\.(tsx|jsx|vue|svelte)$/.test(file.path)) continue
      const text = file.content ?? ''
      const fetches = structure.calls.filter((c) => /^(fetch|axios(\.\w+)?)$/.test(c.name))
      if (!fetches.length) continue
      // A component that fetches but never renders a loading or error state.
      const handlesLoading =
        /\b(isLoading|loading|isPending|pending|isFetching|Suspense|skeleton)\b/i.test(text)
      const handlesError = /\b(isError|error|hasError|onError|catch)\b/.test(text)
      if (!handlesLoading || !handlesError) hits.push({ path: file.path, line: fetches[0].line })
    }
    if (hits.length < 2) return
    return {
      title: `${hits.length} components fetch data without a loading or error state`,
      detail:
        'On a fast connection this looks fine. On a slow one the user sees an empty screen with no indication anything is happening, and when the request fails they see that empty screen forever — with no way to tell whether the app is broken or simply has no data.',
      fix: 'Render all three states explicitly: pending, failed (with a retry) and empty. A data-fetching library such as TanStack Query or SWR gives you the flags; the work is deciding what each state should say.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const noTypeChecking: Rule = {
  id: 'maintainability/loose-type-checking',
  category: 'maintainability',
  severity: 'medium',
  confidence: 'certain',
  effort: 'moderate',
  run(ctx) {
    const tsconfig = ctx.files.find((f) => /(^|\/)tsconfig\.json$/.test(f.path))
    if (!tsconfig?.content) return
    const text = tsconfig.content
    if (/"strict"\s*:\s*true/.test(text)) return
    const missing: string[] = []
    if (!/"noImplicitAny"\s*:\s*true/.test(text)) missing.push('noImplicitAny')
    if (!/"strictNullChecks"\s*:\s*true/.test(text)) missing.push('strictNullChecks')
    if (!missing.length) return
    return {
      title: 'TypeScript strict mode is off',
      detail: `\`strict\` is not enabled and ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} unset, so the compiler accepts implicit \`any\` and ignores null and undefined. Most of the value of using TypeScript is in exactly those checks — without them the types document intent but catch very little.`,
      fix: 'Turn on `"strict": true` and fix the errors incrementally: enable it, then use `// @ts-expect-error` with a note on the files you cannot fix immediately so the list is visible and shrinking.',
      evidence: [{ path: tsconfig.path }],
    }
  },
}

const noLinting: Rule = {
  id: 'maintainability/no-linter',
  category: 'maintainability',
  severity: 'low',
  confidence: 'certain',
  effort: 'quick',
  run(ctx) {
    const configs =
      /(^|\/)(\.eslintrc|eslint\.config|biome\.json|\.prettierrc|prettier\.config|ruff\.toml|\.flake8|setup\.cfg|\.golangci|rustfmt\.toml|\.rubocop\.yml|\.editorconfig)/
    if (ctx.files.some((f) => configs.test(f.path))) return
    if (ctx.sourceFiles.length < 15) return
    return {
      title: 'No linter or formatter configuration',
      detail:
        'Without a shared formatter, diffs fill with whitespace changes and review attention goes to style instead of behaviour. Without a linter, the whole class of mistakes a linter catches has to be caught by a human, every time.',
      fix: 'Add a formatter and a linter with the default rules, run them once across the codebase in a single commit, then enforce them in CI so the question never comes up in review again.',
      evidence: [],
    }
  },
}

const noCi: Rule = {
  id: 'testing/no-continuous-integration',
  category: 'testing',
  severity: 'medium',
  confidence: 'certain',
  effort: 'moderate',
  run(ctx) {
    const ci =
      /(^\.github\/workflows\/|^\.gitlab-ci\.yml$|^\.circleci\/|^Jenkinsfile$|^azure-pipelines\.yml$|^\.drone\.yml$|^bitbucket-pipelines\.yml$)/
    if (ctx.files.some((f) => ci.test(f.path))) return
    if (ctx.sourceFiles.length < 15) return
    return {
      title: 'Nothing runs automatically on a change',
      detail:
        'With no CI, whether the tests pass depends on each contributor remembering to run them, and the first sign of a broken build is usually a broken deploy.',
      fix: 'Add one workflow that installs, type-checks, lints, tests and builds on every push and pull request. Make it required to merge — a check nobody has to remember is the only kind that holds.',
      evidence: [],
    }
  },
}

const missingReadmeSections: Rule = {
  id: 'documentation/thin-readme',
  category: 'documentation',
  severity: 'medium',
  confidence: 'likely',
  effort: 'quick',
  run(ctx) {
    const readme = ctx.files.find((f) => /^readme(\.\w+)?$/i.test(f.path))
    if (!readme) {
      return {
        severity: 'high' as const,
        title: 'No README',
        detail:
          'A new contributor — or you in six months — has no way to learn what this is, how to run it, or how to run the tests, without reading the source and guessing.',
        fix: 'Write one that answers four questions: what this is, how to run it locally, how to run the tests, and how the code is laid out. Half a page beats nothing, and beats a page of badges.',
        evidence: [],
      }
    }
    const text = readme.content ?? ''
    if (text.length < 400) {
      return {
        title: 'The README is a stub',
        detail:
          'It is short enough that it cannot be answering how to install, run and test the project — which is what anyone opening the repository needs first.',
        fix: 'Cover: what the project is in one sentence, prerequisites, install and run commands, how to run the tests, and where the important code lives.',
        evidence: [{ path: readme.path }],
      }
    }
    const missing: string[] = []
    if (!/```|^\s{4}\S/m.test(text)) missing.push('a runnable command')
    if (!/\b(install|setup|getting started|quick ?start)\b/i.test(text))
      missing.push('install steps')
    if (!/\b(test|testing)\b/i.test(text)) missing.push('how to run the tests')
    if (missing.length < 2) return
    return {
      severity: 'low' as const,
      title: `The README is missing ${missing.join(' and ')}`,
      detail:
        'The first thing a reader wants is to get it running. When that is not in the README they either guess from the manifest or give up.',
      fix: `Add a short "Getting started" section with the exact commands, and a line on how to run the tests. Keep them accurate — a command that does not work is worse than no command.`,
      evidence: [{ path: readme.path }],
    }
  },
}

const noEnvExample: Rule = {
  id: 'documentation/no-env-example',
  category: 'documentation',
  severity: 'low',
  confidence: 'likely',
  effort: 'quick',
  run(ctx) {
    // A library reads environment variables on behalf of its host; it has nothing to document.
    if (!ctx.isApplication) return
    const usesEnv = ctx.sourceFiles.filter((f) =>
      /process\.env\.\w+|os\.environ|os\.getenv|ENV\[|Environment\.GetEnvironmentVariable/.test(
        f.content ?? '',
      ),
    )
    if (usesEnv.length < 3) return
    if (ctx.files.some((f) => /\.env\.(example|sample|template|dist)$/.test(f.path))) return
    if (ctx.files.some((f) => /(^|\/)env\.(example|sample)$/i.test(f.path))) return
    return {
      title: 'Environment variables are required but never documented',
      detail: `${usesEnv.length} files read environment variables and there is no \`.env.example\`. Someone setting the project up has to discover each variable by running it, hitting an error, and grepping for the name.`,
      fix: 'Commit a `.env.example` listing every variable with a comment on what it is for and a safe placeholder value. Validate the required set at startup so a missing one fails immediately with a clear message.',
      evidence: evidenceFrom(
        ctx,
        usesEnv.slice(0, 5).map((f) => ({ path: f.path })),
      ),
      occurrences: usesEnv.length,
    }
  },
}

const untestedCriticalPaths: Rule = {
  id: 'testing/untested-critical-modules',
  category: 'testing',
  severity: 'high',
  confidence: 'likely',
  effort: 'large',
  run(ctx) {
    const testFiles = ctx.files.filter((f) =>
      /(\.(test|spec)\.[cm]?[jt]sx?|_test\.(go|py|rb|rs)|Tests?\.cs)$|(^|\/)(tests?|__tests__|spec)\//.test(
        f.path,
      ),
    )
    if (!testFiles.length) return // "no tests at all" is already reported as a warning
    // Modules that handle auth, payment or data mutation and are not referenced by any test.
    const sensitive = ctx.graph.modules.filter((m) =>
      /auth|login|session|token|payment|billing|checkout|permission|role|access|crypto|password/i.test(
        m.path,
      ),
    )
    if (!sensitive.length) return
    const testedPaths = new Set<string>()
    for (const t of testFiles) {
      const content = t.content ?? ''
      for (const m of sensitive)
        if (content.includes(m.name) || content.includes(m.path)) testedPaths.add(m.id)
    }
    const untested = sensitive.filter((m) => !testedPaths.has(m.id))
    if (!untested.length) return
    return {
      title: `${untested.length} security-sensitive module${untested.length === 1 ? '' : 's'} with no tests`,
      detail: `${untested
        .slice(0, 3)
        .map((m) => m.path)
        .join(
          ', ',
        )} handle authentication, permissions or payments, and no test file references them. These are the modules where a regression is least likely to be noticed and most expensive when it is.`,
      fix: 'Write tests for the decisions rather than the plumbing: that an expired token is rejected, that a user cannot read another user’s record, that a failed payment does not grant access. A dozen such tests are worth more than broad coverage elsewhere.',
      evidence: untested.slice(0, 5).map((m) => ({ path: m.path })),
      occurrences: untested.length,
    }
  },
}

export const productRules: Rule[] = [
  imagesWithoutAlt,
  clickableNonInteractive,
  inputsWithoutLabels,
  noErrorBoundary,
  unhandledAsyncUi,
  noTypeChecking,
  noLinting,
  noCi,
  missingReadmeSections,
  noEnvExample,
  untestedCriticalPaths,
]
