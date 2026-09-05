# Changelog

All notable changes to RepoScope are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

See [ROADMAP.md](ROADMAP.md) for what is planned next.

## [0.3.0] — 2026-09-05

Accuracy release aimed at what the map actually shows. Health scores rose sharply on
well-maintained projects because several findings turned out to be false positives.

### Added

- Vue, Svelte and Astro single-file components are parsed: the script block is extracted and
  read as TypeScript, with blank lines standing in for the template and style sections so
  reported line numbers still match the file. Parse coverage on a SvelteKit project went from
  46% to 100%.
- Module boundaries now come from declared packages — any directory with a `package.json`,
  `go.mod`, `Cargo.toml` or `pyproject.toml` — instead of a hard-coded list of folder names.
  A Cargo workspace under `crates/` gets one module per crate rather than one blob.
- Entry points are scored (manifest > framework root > package-root convention > convention >
  content signal), the best is kept per package, and the list is capped and ranked so the
  first is the primary way in.
- Framework roots are recognised: Next.js `app/layout` and `pages/_app`, SvelteKit's root
  layout, Nuxt's default layout, `App.vue` / `App.svelte`.
- `routesDetected` in scan diagnostics: routes found, before the per-module display cap.

### Fixed

- A Cargo/Go/npm workspace in an unconventionally named folder collapsed into a single
  module. ripgrep's 13 crates were one node joined by one edge; they are now 23 modules with
  16 connections.
- Secret-carrying files inside test fixtures (`tests/client_certs/client.pem`,
  `tests/test_apps/.env`) were reported as critical and cost 20 health points. They are now
  reported at info severity and excluded from the score: httpie +30, chi +23, flask +18.
- File-based API routes were anchored to the repository root, so a Next.js or SvelteKit app
  under `apps/web/` reported no routes at all. linkwarden went from 0 to 58.
- The repository root was reported as a dead module, and standalone tooling packages that
  nothing imports by design were reported as dead code.
- Test files (`*_test.go`, `*.spec.ts`, `test_*.py`) could be lifted onto the map as entry
  points.
- Example and sample folders that declare their own manifest were classified as APIs or
  applications rather than documentation.
- A package whose only file was lifted into an entry node left an empty module behind.
- Module labels showed raw package identifiers (`github.com/go-chi/chi/v5` rather than `chi`).
- The benchmark's `routes` metric counted the display-capped subset, and its corpus totals
  compared a `--only` subset against the full snapshot.

### Changed

- `detectEntryPoints` takes the package directories and returns a ranked, capped list.
- `classifyModule` takes the package directories so any manifest-bearing directory is typed
  as an application.

## [0.2.0] — 2026-09-05

Accuracy release. The unresolved-local rate across the benchmark corpus fell from 3.4% to 0.6%.

### Added

- Syntax-tree import extraction using tree-sitter grammars for TypeScript, TSX, JavaScript, Python, Go, Rust, C#, Java, Kotlin, Scala, Ruby, PHP and C/C++. Multi-line import lists, `import type`, re-exports, `import()` and `require()` are read correctly, and imports appearing inside comments, strings or template literals are no longer mistaken for real ones.
- Workspace package resolution: every `package.json`, `go.mod` and `Cargo.toml` in the repository maps its declared name to its folder, so `@acme/ui` links to `packages/ui` rather than looking like a third-party package. Covers npm/pnpm/yarn workspaces, Go multi-module repositories and Cargo workspace crates.
- Java, Kotlin and Scala imports now resolve internally through the `package` each file declares.
- Vite/Vitest/Nuxt/Astro `resolve.alias` entries, `jsconfig.json` paths and SvelteKit's `$lib` are honoured.
- Python `from . import module` and `from pkg import submodule` resolve to the module they name.
- `npm run bench` benchmark harness over a ten-repository corpus, with a committed snapshot, a `--diff` mode and a weekly CI workflow.
- Import diagnostics on every scan (`ScanResult.diagnostics`): files parsed versus regex-scanned, and every specifier that pointed inside the repository but failed to resolve.
- CI job that runs the suite with the optional grammars removed, so the regex fallback cannot rot.

### Fixed

- Imports of the repository root (`require('../..')`) produced a path with a leading slash and never resolved.
- `tsconfig` path aliases with a wildcard in the middle of the target (`"@vue/*": ["packages/*/src"]`) had the wildcard position discarded, so every such import failed to resolve.
- Asset and build-output specifiers (`./logo.png`, `./dist/bundle.cjs.js`) are no longer reported as unresolved; ingest filters those files on purpose.

### Changed

- `analyzeImports` is now asynchronous and returns `{ imports, diagnostics }`.
- Type-only imports create edges with lower confidence than value imports.
- `web-tree-sitter` and `tree-sitter-wasms` are optional dependencies; without them the analyzer falls back to regular expressions.

## [0.1.0] — 2026-09-03

First working end-to-end MVP.

### Added

- Landing page with GitHub URL input, browser-side folder upload and a bundled demo scan.
- Five-stage scan progress screen with graceful errors for invalid, private, oversized and empty repositories.
- Deterministic analyzer: languages, manifests and frameworks across npm / PyPI / Go / Cargo / NuGet / RubyGems / Composer / Maven, entry points, API routes for common frameworks, storage layers, per-language import resolution (TS/JS, Python, Go, Rust, C#, partial Ruby/PHP/Dart/C), folder-to-module grouping with monorepo splitting, typed nodes, file-level edges, importance scoring.
- Warnings: unclear entry points, dead modules, missing tests, duplicate functionality, excessive complexity, circular imports, exposed secrets (values never shown), large files, unused dependencies.
- Estimated health score with visible breakdown; template-based summary, findings and next actions; optional OpenAI-compatible summary provider.
- Interactive architecture map (React Flow + dagre): expandable modules, focus mode, zoom/pan/fit/reset, layout direction, type-aware colours and glyphs, edge legend.
- Sidebar, node inspector and collapsible analysis panel.
- JSON and Markdown (with Mermaid) exports, in-memory share links, last scan restored from `localStorage`.
- CLI (`npm run scan:local`), demo generator, Vitest suite, CI workflow.
