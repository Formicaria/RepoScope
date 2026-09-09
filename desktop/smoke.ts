/**
 * The `--smoke` probe: what runs *inside* the window to check the shell actually works.
 *
 * Written as a real function and shipped to the renderer with `Function.prototype.toString`,
 * rather than as a hand-escaped template literal. The first version was the latter, and the
 * nested backticks and `\n` sequences silently produced invalid JavaScript — the probe threw
 * in the renderer and the smoke test hung. A function the compiler checks cannot go wrong
 * that way.
 *
 * It runs in the page, so it has no Node and no imports: everything it touches is a browser
 * global or the preload bridge, and the `any`s below are that boundary, not laziness.
 */

export interface SmokeReport {
  bridge: boolean
  version?: string
  updateMode?: string
  git?: boolean
  apiHealth?: boolean
  scanButton?: boolean
  licence?: string
  features?: string[]
  junkKeyRejected?: boolean
  /** A real scan, run through the packaged app's own API. */
  scanned?: boolean
  scanError?: string
  /**
   * Files the tree-sitter grammars parsed, versus those that fell back to regular
   * expressions. This is the number that catches a build where the grammars did not survive
   * packaging: the analyzer would quietly degrade and still return a plausible result.
   */
  parsedFiles?: number
  regexFiles?: number
  resolvedImports?: number
}

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const window: any
declare const document: any
declare const fetch: any
declare const setTimeout: any

async function probe(): Promise<SmokeReport> {
  const rs = window.reposcope
  if (!rs) return { bridge: false }

  const info = await rs.info()
  const licence = await rs.licence.status()
  const rejected = await rs.licence.set('not-a-real-key')
  const health = await fetch('/api/health').then((r: any) => r.json())

  const files = [
    { path: 'package.json', size: 40, content: '{"name":"probe","main":"src/index.ts"}' },
    {
      path: 'src/index.ts',
      size: 60,
      content: "import { helper } from './helper'\nconsole.log(helper())",
    },
    { path: 'src/helper.ts', size: 40, content: 'export const helper = () => 1' },
  ]
  const started = await fetch('/api/scan/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'probe', files }),
  }).then((r: any) => r.json())

  let scan = started
  for (let i = 0; i < 60 && !scan.result && !scan.error; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    scan = await fetch('/api/scan/' + started.id).then((r: any) => r.json())
  }
  const diagnostics = scan.result?.diagnostics

  return {
    bridge: rs.desktop === true,
    version: info.version,
    updateMode: info.updateMode,
    git: info.git,
    apiHealth: health.ok === true,
    scanButton: String(document.body.innerText).includes('Scan Project'),
    licence: licence.status.state,
    features: Object.keys(licence.features),
    junkKeyRejected: rejected.status.state === 'invalid' && rejected.saved === false,
    scanned: !!scan.result,
    scanError: scan.error,
    parsedFiles: diagnostics?.parsedFiles,
    regexFiles: diagnostics?.regexFiles,
    resolvedImports: diagnostics?.resolvedInternal,
  }
}

/** The probe, as source the renderer can evaluate. */
export const PROBE_SOURCE = `(${probe.toString()})()`

/** Whether a report means the shell is working. */
export function smokePassed(report: SmokeReport | undefined): boolean {
  return !!(
    report?.bridge &&
    report.apiHealth &&
    report.scanButton &&
    report.scanned &&
    report.junkKeyRejected
  )
}
