# Roadmap

RepoScope's goal is unchanged from the first commit: **paste a repository, scan it, and immediately understand how the software is put together.** Everything below serves that goal. Items are grouped by release; within a release they are roughly in priority order. Nothing here is a promise — it is the current plan, and issues and pull requests can reorder it.

Status legend: ✅ done · 🚧 in progress · ⏳ planned · 💡 idea, needs a design

## 0.1 — MVP ✅

Shipped. Paste a public GitHub URL or upload a folder, watch the five-stage scan, explore the map, inspect nodes, read findings, export JSON/Markdown, share a link.

- ✅ Deterministic analyzer: languages, frameworks, dependencies, entry points, routes, storage, imports, module grouping, warnings, health score, template summary
- ✅ Interactive map with expandable modules, focus mode, zoom/pan/fit/reset, layout direction
- ✅ Inspector, analysis panel, warnings list
- ✅ JSON + Markdown export, in-memory share links, last scan restored from `localStorage`
- ✅ Browser-side folder upload with client-side ignore rules
- ✅ Graceful errors for invalid, private, oversized and empty repositories
- ✅ Optional OpenAI-compatible summary provider behind an interface
- ✅ Tests for parsing, graph generation, warnings, scoring and export; CI

## 0.2 — Trust the map 🚧

Make the analysis right more often, and make it obvious _why_ the map looks the way it does.

- ✅ **Real parsers.** Imports come from tree-sitter syntax trees instead of regular expressions, so multi-line lists, `import type`, re-exports and dynamic imports are read correctly — and imports inside comments, strings and template literals are not. The grammars are optional; the regex path still works without them.
- ✅ **Workspace and alias resolution.** tsconfig/jsconfig `paths` with a wildcard anywhere in the target, Vite aliases, SvelteKit `$lib`, npm/pnpm workspace packages, Go multi-module repositories and Cargo workspace crates.
- ✅ **Java / Kotlin / Scala internal resolution** through the `package` each file declares.
- ✅ **Benchmark corpus.** `npm run bench` scans ten public repositories and diffs against a committed snapshot; the unresolved-local rate fell from 3.4% to 0.6%.
- ⏳ **Edge evidence.** Hover or click an aggregated edge to see the actual file-to-file imports behind it.
- ⏳ **Explain this classification.** Each module node shows which rule typed it (folder name, route density, JSX share, …) so mis-typings are debuggable and reportable.
- ✅ **Package-aware module boundaries.** Every declared package is its own module, whatever the folder is called; large packages still split into sub-folders.
- ⏳ **Two-level hierarchy for monorepos.** Collapsible package groups (package → module → file) rather than a flat list of package modules.
- ⏳ **C# project references** from `.csproj`, and NuGet-style namespace disambiguation.
- ⏳ **Django `urls.py`, NestJS decorators, tRPC and GraphQL schema routes.**
- ⏳ **Calibrate the health score** against the corpus now that the fixture-secret false positive is gone; several penalties are still guesses.
- ✅ **Framework-aware, ranked entry points** (Next.js, Nuxt, SvelteKit, package-relative `main`), capped so a monorepo shows one way in per package instead of 32 candidates.
- ✅ **Single-file components.** Vue, Svelte and Astro script blocks are parsed.
- ⏳ **Symbol-level edges.** Use the names each import binds (already parsed) so a barrel import does not imply a dependency on everything the barrel re-exports.
- ⏳ **Frontend → backend edges.** Link a `fetch('/api/users')` call to the route that serves it.
- ⏳ Smarter "unused dependency" detection (CLI tools, plugins referenced in config files, peer dependencies).

## 0.3 — Bigger repositories, faster

- ⏳ **Persist scans** in SQLite (results, not source) so share links survive restarts and re-scans can diff.
- ⏳ **Streaming progress** over Server-Sent Events instead of polling, with per-stage timing.
- ⏳ **Worker-thread analysis** so a large scan never blocks the API.
- ⏳ **Incremental rescans** keyed on the commit SHA: reuse import resolution for unchanged files.
- ⏳ Raise the file cap with sampling for very large repositories, and show what was skipped.
- ⏳ Graph performance pass: virtualised file nodes inside expanded modules, edge bundling for hubs with 30+ dependents.

## 0.4 — Private code

- ⏳ **GitHub token** (personal access token, pasted per session, never stored) for private repositories and higher API rate limits.
- ⏳ **GitLab and Bitbucket URLs.**
- ⏳ **Branch / tag / commit selection** from the URL (`/tree/<branch>`) or a picker.
- 💡 GitHub App installation for organisations, with scans triggered from a pull request check.

## 0.5 — Understanding, not just mapping

- ⏳ **Per-module purpose text** generated behind the existing provider interface, cached, clearly marked as model-generated, always with the template fallback.
- ⏳ **Questions about the codebase** ("where is auth handled?") answered by pointing at nodes on the map, using only the deterministic facts as context.
- ⏳ **Architecture diffs** between two scans of the same repository: new modules, removed edges, warnings fixed or introduced.
- ⏳ **Ownership overlay** from `CODEOWNERS`.
- 💡 Runtime signals: import a coverage report or OpenTelemetry trace to weight edges by actual calls rather than static imports.

## Later / exploratory 💡

- Embeddable read-only map (`<iframe>` or a static HTML export) for READMEs and internal wikis.
- VS Code extension that opens the map for the current workspace.
- A CLI-only mode that prints the Markdown report, for CI comments on pull requests.
- Plug-in analyzers so teams can add their own framework conventions without forking.
- Team workspaces and history — only if the single-user product proves worth it first.

## Explicit non-goals for now

- Accounts, billing, multi-user collaboration and enterprise features.
- Executing repository code (all analysis is static).
- Replacing linters, security scanners or dependency auditors — RepoScope points at fragile spots; specialised tools should confirm them.
- Pretending the health score is scientific. It stays an estimate with a visible breakdown.

## How to influence this

Open an issue using the _Feature request_ or _Detection gap_ template, or comment on an existing one. Pull requests that come with a test and a real public repository the change was verified on are the fastest way to move an item from ⏳ to ✅.
