import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScanResult, ScanStatus } from '../shared/types'
import demoJson from './data/demo.json'
import { Landing } from './components/Landing'
import { MapView } from './components/MapView'
import { ScanProgress } from './components/ScanProgress'
import { getScan, readFolder, startGitHubScan, startUploadScan, waitForScan } from './lib/api'
import {
  loadLastScan,
  loadSettings,
  saveLastScan,
  saveSettings,
  type Settings,
} from './lib/storage'

const DEMO = demoJson as unknown as ScanResult

type View =
  | { kind: 'landing'; error?: string }
  | { kind: 'scanning'; label: string; status?: ScanStatus; uploadNote?: string }
  | { kind: 'map'; result: ScanResult; shareUrl?: string; readOnly?: boolean }

export default function App() {
  const [view, setView] = useState<View>({ kind: 'landing' })
  const [settings, setSettingsState] = useState<Settings>(loadSettings)
  const [lastScan, setLastScan] = useState<ScanResult | undefined>(loadLastScan)
  const cancelled = useRef(false)

  const setSettings = (s: Settings) => {
    setSettingsState(s)
    saveSettings(s)
  }

  const showResult = useCallback(
    (
      result: ScanResult,
      opts: { shareable?: boolean; readOnly?: boolean; remember?: boolean } = {},
    ) => {
      const shareUrl =
        opts.shareable && result.id
          ? `${location.origin}${location.pathname}?scan=${result.id}`
          : undefined
      setView({ kind: 'map', result, shareUrl, readOnly: opts.readOnly })
      if (opts.remember !== false) {
        saveLastScan(result)
        setLastScan(result)
      }
    },
    [],
  )

  // Shared read-only links: /?scan=<id>
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const id = params.get('scan')
    if (params.get('demo') === '1') {
      showResult(DEMO, { remember: false })
      return
    }
    if (!id) return
    setView({ kind: 'scanning', label: 'shared scan' })
    getScan(id)
      .then((s) => {
        if (s.result) showResult(s.result, { shareable: true, readOnly: true, remember: false })
        else
          setView({
            kind: 'landing',
            error:
              'That shared scan is no longer available. Results live in memory on the server and are cleared on restart.',
          })
      })
      .catch(() =>
        setView({
          kind: 'landing',
          error: 'That shared scan could not be found. It may have expired.',
        }),
      )
  }, [showResult])

  const track = useCallback(
    async (initial: ScanStatus, label: string, uploadNote?: string) => {
      cancelled.current = false
      setView({ kind: 'scanning', label, status: initial, uploadNote })
      if (initial.stage === 'error') return
      try {
        const final = await waitForScan(initial.id, (s) => {
          if (!cancelled.current) setView({ kind: 'scanning', label, status: s, uploadNote })
        })
        if (cancelled.current) return
        if (final.result) {
          // Brief pause so the "done" state is visible before the map appears.
          setTimeout(() => showResult(final.result!, { shareable: true }), 350)
        }
      } catch (err) {
        if (!cancelled.current)
          setView({
            kind: 'landing',
            error:
              err instanceof Error
                ? err.message
                : 'The scan could not be started. Is the API server running?',
          })
      }
    },
    [showResult],
  )

  const scanUrl = useCallback(
    async (url: string) => {
      const label = url.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '')
      setView({ kind: 'scanning', label })
      try {
        const status = await startGitHubScan(url)
        await track(status, label)
      } catch (err) {
        setView({
          kind: 'landing',
          error:
            err instanceof Error
              ? err.message
              : 'Could not start the scan. Is the API server running?',
        })
      }
    },
    [track],
  )

  const scanFolder = useCallback(
    async (list: FileList) => {
      setView({
        kind: 'scanning',
        label: 'local folder',
        status: { id: '', stage: 'reading', progress: 3, message: 'Reading files in your browser' },
      })
      try {
        const { name, files } = await readFolder(list, (p) =>
          setView({
            kind: 'scanning',
            label: 'local folder',
            status: {
              id: '',
              stage: 'reading',
              progress: 3,
              message: `${p.kept} of ${p.scanned} files kept`,
            },
          }),
        )
        const note = `${files.length} files were read in your browser; ignored folders (node_modules, .git, build output…) never left your machine. Secret files are listed by name only.`
        const status = await startUploadScan(name, files)
        await track(status, name, note)
      } catch (err) {
        setView({
          kind: 'landing',
          error: err instanceof Error ? err.message : 'Could not read that folder.',
        })
      }
    },
    [track],
  )

  const cancel = () => {
    cancelled.current = true
    setView({ kind: 'landing' })
  }

  const newScan = () => {
    history.replaceState(null, '', location.pathname)
    setView({ kind: 'landing' })
  }

  switch (view.kind) {
    case 'landing':
      return (
        <Landing
          onScanUrl={scanUrl}
          onScanFolder={scanFolder}
          onDemo={() => showResult(DEMO, { remember: false })}
          demoName={DEMO.repository.fullName}
          lastScan={lastScan}
          onOpenLast={() => lastScan && showResult(lastScan)}
          error={view.error}
        />
      )
    case 'scanning':
      return (
        <ScanProgress
          status={view.status}
          label={view.label}
          uploadNote={view.uploadNote}
          onCancel={cancel}
          onRetry={cancel}
        />
      )
    case 'map':
      return (
        <MapView
          result={view.result}
          settings={settings}
          onSettings={setSettings}
          onNewScan={newScan}
          shareUrl={view.shareUrl}
          readOnly={view.readOnly}
        />
      )
  }
}
