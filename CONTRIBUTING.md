# Contributing to RepoScope

Thanks for helping make codebases easier to understand. This guide covers the development workflow and the conventions the project follows.

## Development setup

```bash
git clone https://github.com/Formicaria/RepoScope.git
cd RepoScope
npm install
npm run dev          # API on :8787, web app on :5173
```

`npm run check` runs Prettier, both TypeScript projects and the Vitest suite — it is exactly what CI runs, so run it before pushing.

Useful while working on the analyzer:

```bash
npm run scan:local -- ../some-repo          # human-readable summary
npm run scan:local -- ../some-repo --json   # full ScanResult
```

## What makes a good pull request

- **One concern per PR.** A new route pattern, a UI fix and a scoring tweak are three PRs.
- **Analyzer changes come with a test** in `tests/analyzer.test.ts`. Extend `tests/fixtures/sample-app` if the existing fixture doesn't cover your case — keep it tiny and synthetic.
- **Verify against a real repository** and say which one in the PR description. The map should still make sense for it.
- **UI changes come with a screenshot.**
- Keep the product simple. New controls, panels and settings need a strong reason; the map should stay understandable without documentation.

## Conventions

- TypeScript strict mode, no `any` unless interfacing with untyped JSON.
- Formatting is Prettier's job — don't hand-format.
- Analysis must stay **deterministic**: the same input produces the same output. Anything model-generated goes behind `SummaryProvider` with a template fallback.
- **Never surface secret values.** Detectors report file and line only. A test asserts the fixture's fake secrets don't appear anywhere in the result.
- Heuristics should be explainable. If you add a classification rule, make the failure mode reportable (see the _Explain this classification_ item on the roadmap).
- Keep `shared/` free of Node and DOM APIs so it stays importable from both sides.

## Adding common things

See the _Extension points_ table in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for exactly which map or function to edit when adding a framework, storage layer, route pattern, entry-point convention, language, warning or node type.

## Reporting problems

Use the issue templates: **Bug report**, **Feature request**, or **Detection gap** (RepoScope missed or misclassified something in a public repository). For detection gaps, a public URL and the file that should have been recognised is enough to reproduce.

## Releasing

Versions follow semver and are recorded in [CHANGELOG.md](CHANGELOG.md). Bump `package.json`, add the changelog entry, tag `vX.Y.Z`.
