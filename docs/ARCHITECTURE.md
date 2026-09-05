# RepoScope architecture

This document describes how RepoScope itself is put together: the data model, the analysis pipeline, the UI, and where to plug in new detection rules.

## Layout

```
reposcope/
├── shared/                 Types and pure helpers used by both server and client
│   ├── types.ts            The data model (see below)
│   ├── graph.ts            aggregateEdges(): collapse file-level edges onto visible nodes
│   └── report.ts           JSON / Markdown report builders
├── server/
│   ├── index.ts            Express app: POST /api/scan, POST /api/scan/upload, GET /api/scan/:id
│   ├── scans.ts            In-memory scan registry, GitHub lookup, shallow clone, error mapping
│   └── analyzer/
│       ├── index.ts        analyzeRepository(): runs the stages below, reports progress
│       ├── ingest.ts       Ignore rules, size caps, secret-file handling (disk + upload)
│       ├── detect.ts       Languages, manifests → dependencies & frameworks, entry points, routes, storage
│       ├── parse.ts        tree-sitter grammars: syntax-tree import extraction (optional)
│       ├── imports.ts      Import resolution per language + accuracy diagnostics
│       ├── graph.ts        Files → modules → typed nodes, edges, importance
│       ├── warnings.ts     Warning detectors + Tarjan cycle finder
│       ├── score.ts        Estimated health score
│       ├── summary.ts      Template summary + SummaryProvider interface (optional LLM)
│       └── paths.ts        Tiny posix path helpers
├── src/                    React client (Vite)
│   ├── App.tsx             View state machine: landing → scanning → map; share-link handling
│   ├── components/         Landing, ScanProgress, MapView, Sidebar, Graph, GraphNodes, Inspector, AnalysisPanel, Dialogs, ui
│   ├── lib/
│   │   ├── api.ts          Fetch wrappers, polling, browser-side folder reading
│   │   ├── viewModel.ts    ScanResult + UI state → React Flow nodes/edges with a dagre layout
│   │   ├── storage.ts      localStorage (last scan, settings)
│   │   ├── export.ts       Download helpers (report builders live in shared/)
│   │   └── nodeStyles.ts   Colours, labels, legend order
│   └── data/demo.json      Bundled demo scan (regenerate with npm run demo:generate)
├── scripts/                scan-local.ts (CLI), generate-demo.ts, benchmark.ts
├── benchmarks/             corpus.json + committed snapshot.json (see benchmarks/README.md)
└── tests/                  Vitest suites + tests/fixtures/sample-app (a tiny synthetic repo)
```

## Data model (`shared/types.ts`)

| Type             | Purpose                                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Repository`     | name, full name, URL, source (`github` / `upload` / `demo`), scan time                                                                                                                                                                                                          |
| `RepoFile`       | `path`, `size`, optional `content` — the analyzer's only input                                                                                                                                                                                                                  |
| `ProjectNode`    | id, name, `type` (`entry` `app` `module` `service` `api` `component` `database` `integration` `config` `test` `docs` `file`), path, description, importance 0–1, dependencies, dependents, warning ids, `children` / `parent`, `meta` (files, lines, language, routes, package) |
| `ProjectEdge`    | source, target, `type` (`imports` `calls` `depends` `dataflow` `owns` `tests`), confidence 0–1, optional label and weight                                                                                                                                                       |
| `Module`         | folder group: id, path, type, file list, line count                                                                                                                                                                                                                             |
| `Dependency`     | name, version, ecosystem, dev flag, `used` flag, category                                                                                                                                                                                                                       |
| `Warning`        | kind, severity (`info` / `warning` / `critical`), title, detail, optional path and node id                                                                                                                                                                                      |
| `Finding`        | strength / risk / observation with title and detail                                                                                                                                                                                                                             |
| `HealthScore`    | score, label, breakdown of `{ signal, delta, note }`                                                                                                                                                                                                                            |
| `ProjectSummary` | headline, description, architecture, key findings, next actions                                                                                                                                                                                                                 |
| `ScanStatus`     | id, stage, progress, message, error, result                                                                                                                                                                                                                                     |
| `ScanResult`     | everything above plus languages, frameworks, entry points, stats                                                                                                                                                                                                                |

Node ids are stable and self-describing: `entry:<path>`, `mod:<slug>`, `file:<path>`, `store:<slug>`, `ext:<slug>`.

Edges are stored at the **finest level** (file → file, file → integration/storage). The server aggregates them to module level for stats and `dependencies`/`dependents`; the client aggregates them again for whatever set of nodes is currently visible (`shared/graph.ts::aggregateEdges`). That single function is why expand/collapse never needs a server round-trip.

## Pipeline

1. **Ingest** (`ingest.ts`). Walk the clone (or filter the uploaded list). Skip `IGNORED_DIRS` and generated/binary patterns. Files matching `SECRET_FILE_PATTERNS` are kept as name + size only. Content is read for text files up to 256 KB; caps at 6,000 files.
2. **Detect** (`detect.ts`).
   - `detectLanguages` — by extension, code languages only.
   - `detectManifests` — `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `*.csproj`, `Gemfile`, `composer.json`, `pom.xml`/Gradle → `Dependency[]`, frameworks (from `KNOWN_DEPENDENCIES` plus config-file signals) and entry hints (`main`, `bin`, `start` scripts).
   - `detectEntryPoints` — hints + name patterns + content signals (`listen(`, `createRoot(`, `func main`, `if __name__`), excluding examples/docs/tests and comment lines.
   - `detectRoutes` — regex patterns per framework plus file-based routes.
   - `detectStorage` — ORM/driver dependencies, `schema.prisma`, migrations, compose services.
3. **Imports** (`parse.ts` + `imports.ts`). Each file is parsed with a tree-sitter grammar
   (`parseFile`), giving exact specifiers plus the names they bind, whether the import is
   type-only, and the `package` a JVM/C#/PHP file declares. Files with no grammar — and any
   file that fails to parse, or a checkout with the optional grammars omitted — fall back to
   the `extractSpecifiers` regexes, so results degrade instead of disappearing. Then resolve: JS/TS (relative, `tsconfig` `paths` scoped to the folder holding the tsconfig, `@/`/`~/` fallbacks, extension probing, `index` files), Python (relative dots; every suffix of the dotted path is registered so any project root works), Go (`go.mod` module prefix, multi-module repositories), Rust (`mod`, `crate::`, sibling crates in a
   Cargo workspace), JVM and C# (through the package/namespace map built from the parse).
   Bare specifiers are also matched against **workspace packages** — every `package.json`,
   `go.mod` and `Cargo.toml` in the repository maps its declared name to its folder — so
   `@acme/ui` links to `packages/ui` instead of looking external. Anything still unresolved
   becomes an external package name, minus standard libraries.

   The stage returns `ImportDiagnostics` alongside the imports: how many files were parsed
   versus regex-scanned, and every specifier that pointed inside the repository yet failed to
   resolve. Those failures are always analyzer gaps, which is what `npm run bench` measures.

4. **Graph** (`graph.ts`).
   - `moduleKeyFor` groups files: root files split into code/config/docs; container folders (`src`, `lib`, `app`, `backend`, …) are looked through one level; monorepo packages (`apps/*`, `packages/*`, …) stay whole under `SPLIT_PACKAGE_THRESHOLD` code files and are split into sub-folders above it.
   - `classifyModule` assigns a `NodeType` from folder name, route density, JSX share and workspace position.
   - Up to `MAX_ENTRY_NODES` entry points are lifted to top-level `entry` nodes.
   - Storage nodes come from `detectStorage`; integration nodes are created only for categorised dependencies that are actually imported. ORM nodes get a `dataflow` edge to the concrete database.
   - Importance = normalised `2·in + out + log2(files)` over module/entry nodes.
5. **Warnings** (`warnings.ts`). Each detector appends `Warning`s; ids are attached to the relevant node, its file node and its parent. Cycles use an iterative Tarjan SCC over import edges. Secret detection never includes the matched text.
6. **Score** (`score.ts`). Start at 100, apply deltas per signal, clamp, label. The breakdown is part of the result so the UI can show it.
7. **Summary** (`summary.ts`). `buildTemplateSummary` writes the prose from facts; `SummaryProvider.summarize(draft, facts)` may rewrite `headline`/`description`/`architecture`. `providerFromEnv` returns the template provider unless `REPOSCOPE_LLM_URL` and `REPOSCOPE_LLM_MODEL` are set.

`analyzeRepository` yields to the event loop between stages so progress updates reach the poller.

## API

| Method & path           | Body / params                                | Returns                                                                        |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| `POST /api/scan`        | `{ url }`                                    | initial `ScanStatus` (stage `queued`/`reading`, or `error` for an invalid URL) |
| `POST /api/scan/upload` | `{ name, files: RepoFile[] }` (≤ 60 MB JSON) | initial `ScanStatus`                                                           |
| `GET /api/scan/:id`     |                                              | current `ScanStatus`; `result` present when `stage === 'done'`                 |
| `GET /api/health`       |                                              | `{ ok: true }`                                                                 |

Scans live in a `Map` capped at 50 entries. GitHub metadata (`/repos/:owner/:repo`) is consulted for existence, privacy and size before cloning; if the API is unreachable the clone decides. Clone errors are mapped to `private-repo`, `too-large` or `internal`.

## Client

`App.tsx` holds a discriminated-union `View`. `MapView` owns interaction state (selected, focus, expanded set, panel, dialogs) and passes it to `Graph`, which calls `buildView` from `lib/viewModel.ts`:

1. Visible set = top-level nodes (filtered by settings) with expanded modules replaced by their children.
2. `aggregateEdges` onto the visible set.
3. Focus dims everything outside the focused node's neighbourhood.
4. Dagre lays out top-level containers (expanded modules become one box sized for a grid of file nodes).
5. Edges pick source/target handles by relative position so back-edges don't loop around.

React Flow renders custom `tz`/`tzGroup` nodes. Fit-to-view is triggered on structure changes (after `useNodesInitialized`) and on explicit requests (focus, expand) via a token.

## Extension points

| I want to…                                           | Edit                                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Recognise a new framework or categorise a dependency | `KNOWN_DEPENDENCIES` in `detect.ts` (add `framework` and/or `category`); labels in `INTEGRATION_LABELS` (`graph.ts`)               |
| Detect a new storage layer                           | `detectStorage` byDep map in `detect.ts`; `STORAGE_DEP_NAMES` / `STORAGE_BY_DEP` in `graph.ts`                                     |
| Detect routes for a new framework                    | `ROUTE_PATTERNS` in `detect.ts`                                                                                                    |
| Add an entry-point convention                        | `ENTRY_NAME_PATTERNS` or the content signals in `detectEntryPoints`                                                                |
| Resolve imports for a new language                   | `extractSpecifiers` + a `resolveX` function + the switch in `analyzeImports`                                                       |
| Change how folders become modules                    | `moduleKeyFor`, `CONTAINER_DIRS`, `WORKSPACE_DIRS`, `classifyModule` in `graph.ts`                                                 |
| Add a warning                                        | a block in `detectWarnings`, a `WarningKind` in `shared/types.ts`, a delta in `score.ts`, optionally a next-action in `summary.ts` |
| Add a node type                                      | `NodeType` in `shared/types.ts`, colour/label/glyph in `nodeStyles.ts` and `GraphNodes.tsx`                                        |
| Use a different LLM                                  | implement `SummaryProvider` in `summary.ts`                                                                                        |

Every analyzer change should come with a case in `tests/analyzer.test.ts` or `tests/parse.test.ts`, and a `npm run bench -- --diff` run showing its effect on real repositories. It should also keep working with the optional grammars removed (delete `node_modules/web-tree-sitter` and `node_modules/tree-sitter-wasms`, or set `REPOSCOPE_NO_PARSE=1`), which CI checks.
