# Changelog

All notable changes to RepoScope are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

See [ROADMAP.md](ROADMAP.md) for what is planned next.

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
