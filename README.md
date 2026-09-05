<p align="center">
  <img src="docs/screenshots/map.png" alt="RepoScope architecture map" width="900" />
</p>

<h1 align="center">RepoScope</h1>

<p align="center">
  Paste a repository. Scan it. Immediately understand how the software is put together.
</p>

<p align="center">
  <a href="https://github.com/Formicaria/RepoScope/actions/workflows/ci.yml"><img src="https://github.com/Formicaria/RepoScope/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node 20+" />
  <a href="ROADMAP.md"><img src="https://img.shields.io/badge/status-MVP-orange" alt="Status: MVP" /></a>
</p>

---

RepoScope reads a public GitHub repository (or a folder from your machine), detects its languages, frameworks, entry points, API routes, services, storage layers and external integrations, resolves the import graph, and draws an **interactive architecture map** — with warnings where things look fragile, an estimated health score, key findings, and one-click exports.

Analysis is **deterministic**: no LLM is needed. An optional OpenAI-compatible provider (Ollama works) can polish the summary prose, and nothing else.

## Quick start

Requires **Node.js 20+** and `git` on your `PATH` (used for shallow clones).

```bash
git clone https://github.com/Formicaria/RepoScope.git
cd RepoScope
npm install
npm run dev
```

Open <http://localhost:5173>, paste a repository URL such as `https://github.com/fastapi/full-stack-fastapi-template`, and click **Scan Project**. Or click **try the demo** to load the bundled sample scan without touching the network.

Production build (one process serving the client and the API on port 8787):

```bash
npm run build
npm start
```

## What you get

<table>
<tr>
<td width="50%"><img src="docs/screenshots/landing.png" alt="Landing page" /></td>
<td width="50%"><img src="docs/screenshots/progress.png" alt="Scan progress" /></td>
</tr>
<tr>
<td><img src="docs/screenshots/inspector.png" alt="Node inspector with routes and warnings" /></td>
<td><img src="docs/screenshots/expanded.png" alt="Expanded module showing its files" /></td>
</tr>
<tr>
<td colspan="2"><img src="docs/screenshots/review-detail.png" alt="Code review finding with evidence and a specific fix" /></td>
</tr>
</table>

- **Architecture map, not a folder tree.** Nodes are entry points, apps, APIs, services, UI layers, modules, storage and external integrations. Edges are imports, data flow, dependencies and test coverage. Colour and shape encode type; edge weight encodes how many files talk to each other.
- **High-level first, detail on demand.** Files are grouped into modules; double-click (or press _Expand_) to reveal a module's files. _Focus_ dims everything except a component's neighbourhood. _Reset_ puts it all back.
- **Inspector.** Click any node for its purpose, location, detected routes, dependencies, dependents, files and warnings.
- **Analysis panel.** Project summary, architecture explanation, key findings, recommended next actions and the full warning list.
- **Warnings** for unclear entry points, dead-looking modules, missing tests, duplicate functionality, excessive complexity, circular imports, exposed secrets, very large files and unused dependencies.
- **A code review**, not just a map. 37 rules look for the things a senior engineer would raise in review — injection sinks, swallowed errors, secrets with hard-coded fallbacks, `any` used as an escape hatch, comments that restate the line below them, form fields with nothing to label them. Every finding names the file and line, explains the consequence, and says exactly what to change.
- **Estimated health score** (0–100) from measurable signals, with the breakdown shown. It is labelled an estimate because that is what it is.
- **Exports.** JSON of the full data model, a Markdown architecture report (with a Mermaid diagram), and a read-only share link.
- **Folder upload** that reads files in your browser; `node_modules`, build output and `.git` never leave your machine, and secret files are listed by name only.

## Commands

| Command                                 | What it does                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run dev`                           | API (`:8787`) + web app (`:5173`) with hot reload                                 |
| `npm run build`                         | Build the client into `dist/`                                                     |
| `npm start`                             | Serve `dist/` and the API on `PORT` (default 8787)                                |
| `npm run check`                         | Prettier check + TypeScript + tests — what CI runs                                |
| `npm test`                              | Vitest suite                                                                      |
| `npm run typecheck`                     | `tsc` for client and server                                                       |
| `npm run format`                        | Prettier write                                                                    |
| `npm run scan:local -- ./some/repo`     | Analyse a folder from the terminal (`--json`, `--review`, `--fail-on=<severity>`) |
| `npm run demo:generate -- <github url>` | Regenerate `src/data/demo.json` from a real repository                            |

## How it works

```
GitHub URL ──► shallow clone ──┐
                               ├──► ingest      ignore rules, size caps, secrets never read
Folder upload (browser) ───────┘        │
                                        ▼
                                     detect      languages · manifests & frameworks · entry points · routes · storage
                                        │
                                        ▼
                                     imports     per-language extraction + resolution (relative, tsconfig aliases, packages)
                                        │
                                        ▼
                                     graph       folders → typed modules · file-level edges · integration & storage nodes · importance
                                        │
                                        ▼
                                     warnings ──► health score ──► template summary ──► (optional LLM rewrite)
```

Every stage is a pure function over the previous stage's output, so the parser, graph builder, scoring and UI can evolve independently. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data model, module layout and extension points.

### Supported languages

| Language                | Import resolution | How                                                                                                          |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| TypeScript / JavaScript | ✅                | relative paths, `tsconfig`/`jsconfig` `paths` (wildcards included), Vite aliases, `$lib`, workspace packages |
| Vue / Svelte / Astro    | ✅                | the component's script block is extracted and parsed as TypeScript                                           |
| Python                  | ✅                | absolute, relative and `from . import module`, any project root                                              |
| Go                      | ✅                | module-local packages, multi-module repositories                                                             |
| Rust                    | ✅                | `mod`, `crate::`, and sibling crates in a Cargo workspace                                                    |
| Java / Kotlin / Scala   | ✅                | resolved through the `package` each file declares                                                            |
| C#                      | ✅                | namespace-level `using`                                                                                      |
| Ruby, PHP, Dart, C/C++  | partial           | relative requires / includes, PHP namespaces                                                                 |
| Everything else         | counted           | grouped by folder, no edges                                                                                  |

Files are parsed with [tree-sitter](https://tree-sitter.github.io/) grammars, so multi-line import lists, `import type`, re-exports and dynamic imports are read correctly — and imports that only appear inside comments, strings or template literals are correctly _not_ read. The grammars are an optional dependency. If they are missing or fail to load, the analyzer falls back to regular expressions — lower accuracy, no loss of function. Set `REPOSCOPE_NO_PARSE=1` to force that path.

Route detection covers Express/Koa/Fastify/Hono, FastAPI/Flask, Next.js/SvelteKit/Nuxt file routes, Go `net/http`/gin/echo/chi/fiber, ASP.NET attributes, Spring, Rails `routes.rb`, Laravel and axum/actix. Storage detection covers the common ORMs and drivers across ecosystems plus `docker-compose` services and Prisma schemas. Found a gap? Open a [detection gap issue](.github/ISSUE_TEMPLATE/detection_gap.md).

## The code review

Alongside the map, RepoScope reviews the code it read. The rules are grouped by what they protect:

| Category            | Examples                                                                                                                                                                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Security**        | SQL and command injection through interpolation, `eval` / `pickle.loads` / `yaml.load`, XSS sinks, disabled TLS verification, weak hashing and predictable tokens, secrets with hard-coded fallbacks, open CORS, debug mode in committed config, request-derived file paths, missing security headers, unrate-limited auth routes |
| **Reliability**     | Catch blocks that discard or merely log the error, missing React error boundaries, components that fetch without a loading or error state                                                                                                                                                                                         |
| **Craft**           | Comments that restate the line below them, leftover TODOs and placeholder values, commented-out code, stray `console.log`, decorative comments, mixed naming conventions                                                                                                                                                          |
| **Maintainability** | `any` as an escape hatch, oversized and deeply nested functions, long parameter lists, duplicated blocks, hard-coded environment URLs, loose TypeScript config, no linter                                                                                                                                                         |
| **Accessibility**   | Images without `alt`, click handlers a keyboard cannot reach, form fields with nothing to label them                                                                                                                                                                                                                              |
| **Testing & docs**  | No CI, untested security-sensitive modules, a thin or missing README, undocumented environment variables                                                                                                                                                                                                                          |

Three things keep the list worth reading:

- **Every finding cites a file and a line**, with the surrounding source redacted of anything that looks like a credential. A suggestion you cannot check is one you learn to skim past.
- **Each says what to change**, concretely enough to act on — "pass values as parameters: `db.query("… = $1", [id])`", not "consider security best practices".
- **Context decides severity.** Application-only rules do not fire on libraries; an injection sink in a compiler is reported at lower confidence than the same line in a request handler; examples, docs, generated code and test fixtures are excluded, because an example is _supposed_ to print to the console.

### Running the review in CI

`scan:local` can gate a build. It exits `1` when anything at or above the given severity is found, and prints exactly which findings failed and where:

```bash
npm run scan:local -- . --review --fail-on=high
npm run scan:local -- . --review --category=security --fail-on=critical
npm run scan:local -- . --json > review.json
```

### Tuning it: `.reposcope.json`

A rule that disagrees with a deliberate choice should be switched off by the people who made that choice, in a file they review like any other — otherwise the first false positive becomes permanent noise, and a list with permanent noise in it stops being read.

```json
{
  "review": {
    "disable": ["craft/narrating-comments"],
    "ignore": ["legacy/**", "src/generated"],
    "severity": { "security/permissive-cors": "low" }
  }
}
```

- `disable` — rule ids to switch off; `severity: "off"` does the same thing.
- `ignore` — path patterns (`*` within a segment, `**` across them). A pattern with no wildcard covers the directory and everything beneath it, so `"legacy"` is enough.
- `severity` — override a rule's severity, which is how you keep a finding visible without failing the build on it.

A malformed config is reported, not obeyed: the problem appears in the review panel and the CLI output, and the review still runs. Whenever a config is present the UI says so, along with how much was switched off — a clean list should never be ambiguous about why it is clean.

It is static analysis over heuristics: it does not run the code, does not know what the product is meant to do, and will sometimes be wrong. That is why each finding carries a confidence and its evidence. It is a first reviewer, not a substitute for one — and not a substitute for a real SAST tool on code that handles money or personal data.

### Accuracy

Analyzer changes are judged against a corpus of ten real public repositories rather than by intuition:

```bash
npm run bench            # scan the corpus, write benchmarks/snapshot.json
npm run bench -- --diff  # scan and print the delta against the committed snapshot
```

The headline metric is the **unresolved-local rate**: the share of import specifiers that unambiguously point inside the repository (relative paths, configured aliases, workspace packages) but could not be resolved to a file. Those are always analyzer gaps, which makes the number ground truth that needs no hand labelling. It currently sits at **0.6%** across the corpus, down from 3.4% on regular expressions alone. See [benchmarks/README.md](benchmarks/README.md).

### Optional LLM summary

Copy `.env.example` to `.env` and set:

```bash
REPOSCOPE_LLM_URL=http://localhost:11434/v1   # any OpenAI-compatible endpoint, e.g. Ollama
REPOSCOPE_LLM_MODEL=llama3.1
REPOSCOPE_LLM_API_KEY=                        # optional
```

The model only rewrites the three prose fields of the summary. Nodes, edges, warnings and the score are never generated by it, and any failure falls back to the template output.

## Privacy and secrets

- Secret-carrying files (`.env*`, `*.pem`, `*.key`, `credentials.json`, …) are recorded by name and **never read, stored or displayed**.
- Secret patterns found inside source files are reported by file and line only; the matched value is never included in the result, the exports or the UI.
- Clones are shallow, live in a temp directory, and are deleted as soon as analysis finishes.
- Scan results are kept in the API's memory only. There are no accounts and nothing is written to disk.

## Limitations (MVP)

- Private repositories are not supported yet — upload the folder instead. See the [roadmap](ROADMAP.md).
- Module types come from folder names and contents; "unused dependency" and "dead module" are best-effort; dynamic imports and plugins are invisible.
- Repositories above ~400 MB (as reported by GitHub) or 6,000 analysable files are refused or truncated.
- Share links only work while the server process that produced them is running.

## Contributing

Bug reports, detection gaps and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and how to add a framework, route pattern or warning. The [roadmap](ROADMAP.md) lists what's planned and where help is most useful.

## License

[MIT](LICENSE) © Formicaria
