import { useRef, useState, type FormEvent } from 'react'
import type { ScanResult } from '../../shared/types'
import { Button, Wordmark } from './ui'
import { SettingsDialog } from './Dialogs'
import { loadSettings, saveSettings, type Settings } from '../lib/storage'

export interface LandingProps {
  onScanUrl: (url: string) => void
  onScanFolder: (files: FileList) => void
  onDemo: () => void
  demoName: string
  lastScan?: ScanResult
  onOpenLast: () => void
  error?: string
}

export function Landing({
  onScanUrl,
  onScanFolder,
  onDemo,
  demoName,
  lastScan,
  onOpenLast,
  error,
}: LandingProps) {
  const [url, setUrl] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  /**
   * Settings has to be reachable before the first scan. It used to live only in the map
   * header, which meant a freshly installed desktop app had nowhere to enter a licence key
   * or change how updates behave until you had scanned something first.
   */
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const changeSettings = (next: Settings) => {
    setSettings(next)
    saveSettings(next)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (url.trim()) onScanUrl(url.trim())
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="app-drag flex h-14 items-center justify-between px-6">
        <Wordmark />
        <div className="no-drag flex items-center gap-3">
          <a
            className="text-muted hover:text-text hidden text-[12.5px] sm:inline"
            href="https://github.com"
            target="_blank"
            rel="noreferrer"
          >
            Works with public GitHub repositories
          </a>
          <Button variant="ghost" onClick={() => setShowSettings(true)} aria-label="Settings">
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            >
              <circle cx="8" cy="8" r="2.2" />
              <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
            </svg>
            <span className="hidden sm:inline">Settings</span>
          </Button>
        </div>
      </header>
      {showSettings && (
        <SettingsDialog
          settings={settings}
          onChange={changeSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
      <main className="fade-in mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 pb-24">
        <h1 className="text-[34px] leading-[1.15] font-semibold tracking-tight text-balance sm:text-[40px]">
          Paste a repository. See how the software is put together.
        </h1>
        <p className="text-muted mt-4 max-w-xl text-[15px] leading-relaxed">
          RepoScope reads a codebase and draws an interactive architecture map: entry points,
          services, APIs, storage, integrations and the connections between them — with warnings
          where things look fragile.
        </p>

        <form onSubmit={submit} className="mt-8 flex flex-col gap-2 sm:flex-row">
          <input
            className="border-border bg-surface text-text placeholder:text-faint focus:border-accent h-11 flex-1 rounded-lg border px-4 font-mono text-[13.5px] focus:outline-none"
            placeholder="https://github.com/owner/repository"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
            spellCheck={false}
            aria-label="GitHub repository URL"
          />
          <Button
            variant="primary"
            type="submit"
            className="h-11 px-5 text-[13.5px]"
            disabled={!url.trim()}
          >
            Scan Project
          </Button>
        </form>
        {error && (
          <div
            className="border-danger/30 bg-danger/10 text-danger mt-3 rounded-lg border px-3 py-2 text-[12.5px]"
            role="alert"
          >
            {error}
          </div>
        )}

        <div className="text-muted mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px]">
          <button className="hover:text-text" onClick={() => fileInput.current?.click()}>
            or upload a project folder
          </button>
          <span className="text-faint">·</span>
          <button className="hover:text-text" onClick={onDemo}>
            try the demo <span className="text-accent font-mono">{demoName}</span>
          </button>
          {lastScan && (
            <>
              <span className="text-faint">·</span>
              <button className="hover:text-text" onClick={onOpenLast}>
                reopen <span className="font-mono">{lastScan.repository.fullName}</span>
              </button>
            </>
          )}
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            // @ts-expect-error non-standard attribute understood by Chromium/WebKit/Firefox
            webkitdirectory=""
            directory=""
            multiple
            onChange={(e) => {
              if (e.target.files?.length) onScanFolder(e.target.files)
              e.target.value = ''
            }}
          />
        </div>

        <ol className="text-muted mt-14 grid grid-cols-1 gap-6 text-[13px] sm:grid-cols-3">
          <Step n={1} title="Paste">
            A public GitHub URL, or pick a folder on your machine. Nothing to install.
          </Step>
          <Step n={2} title="Scan">
            Languages, frameworks, entry points, routes, storage, integrations and imports are
            detected deterministically.
          </Step>
          <Step n={3} title="Understand">
            Explore an architecture map, drill into modules, read the findings and export a report.
          </Step>
        </ol>
      </main>
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="border-border text-faint flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px]">
        {n}
      </span>
      <div>
        <div className="text-text mb-1 font-medium">{title}</div>
        <p className="leading-relaxed">{children}</p>
      </div>
    </li>
  )
}
