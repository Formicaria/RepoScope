# Analyzer benchmark

RepoScope's analysis is a pile of heuristics. Heuristics that nobody measures drift, so every
change to the analyzer is checked against real repositories before and after.

```bash
npm run bench                    # scan the corpus, write snapshot.json
npm run bench -- --diff          # scan and print the delta, leaving the snapshot alone
npm run bench -- --only flask,chi
```

Clones are cached in `.bench-cache/` (git-ignored). The first run takes a few minutes; later
runs take seconds. `benchmarks/snapshot.json` is committed so deltas are reviewable in a pull
request diff.

## The corpus

`corpus.json` lists ten public repositories, each present because it exercises something
specific: a Python `src/` layout, a Cargo workspace, tsconfig path aliases with a wildcard in
the middle, SvelteKit file routing, a pnpm monorepo, a Go library with sub-packages. Add a
repository when you fix a bug that no existing entry would have caught.

## Metrics

| Metric                                | Meaning                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`unresolvedLocalRate`**             | The headline. Share of specifiers that point inside the repository but did not resolve to a file. Every one is an analyzer gap, so lower is unambiguously better and no hand labelling is needed. |
| `coverage`                            | Share of files whose imports came from a syntax tree rather than a regular expression.                                                                                                            |
| `resolvedInternal`                    | Internal edges found. Higher is _usually_ better — but a drop can mean false edges were removed, so check the samples before celebrating either direction.                                        |
| `moduleEdges`                         | Connections on the high-level map. Sudden changes mean module grouping moved.                                                                                                                     |
| `nodeTypes`                           | Histogram of module classifications. Catches "everything became a Module" regressions.                                                                                                            |
| `warningKinds`, `health`              | Warning mix and score, to keep scoring calibrated against real projects.                                                                                                                          |
| `routes`, `entryPoints`, `frameworks` | Detection breadth.                                                                                                                                                                                |
| `ms`                                  | Analysis time, so accuracy work does not quietly cost minutes.                                                                                                                                    |

`unresolvedSamples` records a few of the specifiers that failed, which is usually enough to
find the cause without re-running the scan.

## Reading a result

A change is good when `unresolvedLocalRate` falls and the node-type histogram stays stable.
When `resolvedInternal` moves a lot, look at the samples: parsing with a real grammar _lowered_
the count on `vue-core` by 149 because the regex extractor had been matching import statements
inside comments and compiler test fixtures — fewer edges, more correct map.

A new review rule should be checked against the corpus before it ships. The differential is
the test: quiet on Express and Flask, loud on an application with real problems. A rule that
fires on every repository is measuring style, not defects.

Repositories are cloned at their default branch, so a stale snapshot includes upstream drift.
The commit SHA is recorded per repository and the tool says when it changed.
