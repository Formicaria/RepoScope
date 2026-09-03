import { useState } from 'react'
import type { ScanResult } from '../../shared/types'
import { downloadText, toJson, toMarkdown } from '../lib/export'
import type { Settings } from '../lib/storage'
import { Button, Dialog } from './ui'

export function ExportDialog({
  result,
  shareUrl,
  onClose,
}: {
  result: ScanResult
  shareUrl?: string
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const base = result.repository.name.replace(/[^\w.-]+/g, '-')
  const copy = async () => {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <Dialog title="Export" onClose={onClose}>
      <div className="space-y-3 text-[13px]">
        <Row
          title="JSON analysis"
          detail="Full data model: nodes, edges, modules, dependencies, warnings and score."
        >
          <Button
            onClick={() =>
              downloadText(`${base}-reposcope.json`, toJson(result), 'application/json')
            }
          >
            Download
          </Button>
        </Row>
        <Row
          title="Markdown report"
          detail="Readable architecture report with a Mermaid diagram of the connections."
        >
          <Button
            onClick={() =>
              downloadText(`${base}-architecture.md`, toMarkdown(result), 'text/markdown')
            }
          >
            Download
          </Button>
        </Row>
        <Row
          title="Shareable link"
          detail={
            shareUrl
              ? 'Read-only view of this scan. Works while this server is running (results are kept in memory).'
              : 'Not available for scans restored from this browser — rescan to get a link.'
          }
        >
          <Button onClick={copy} disabled={!shareUrl}>
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </Row>
      </div>
    </Dialog>
  )
}

function Row({
  title,
  detail,
  children,
}: {
  title: string
  detail: string
  children: React.ReactNode
}) {
  return (
    <div className="border-border flex items-center gap-4 rounded-lg border p-3">
      <div className="flex-1">
        <div className="font-medium">{title}</div>
        <div className="text-muted text-[12px]">{detail}</div>
      </div>
      {children}
    </div>
  )
}

export function SettingsDialog({
  settings,
  onChange,
  onClose,
}: {
  settings: Settings
  onChange: (s: Settings) => void
  onClose: () => void
}) {
  const toggle = (key: keyof Settings) => onChange({ ...settings, [key]: !settings[key] })
  return (
    <Dialog title="Settings" onClose={onClose}>
      <div className="space-y-4 text-[13px]">
        <div>
          <div className="text-muted mb-1.5 text-[11px] tracking-wide uppercase">
            Layout direction
          </div>
          <div className="flex gap-2">
            {(['LR', 'TB'] as const).map((d) => (
              <Button
                key={d}
                variant={settings.direction === d ? 'primary' : 'secondary'}
                onClick={() => onChange({ ...settings, direction: d })}
              >
                {d === 'LR' ? 'Left to right' : 'Top to bottom'}
              </Button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-muted mb-1.5 text-[11px] tracking-wide uppercase">
            Show on the map
          </div>
          <div className="space-y-2">
            <Check
              label="Test modules"
              checked={settings.showTests}
              onChange={() => toggle('showTests')}
            />
            <Check
              label="Configuration & tooling"
              checked={settings.showConfig}
              onChange={() => toggle('showConfig')}
            />
            <Check
              label="Documentation & examples"
              checked={settings.showDocs}
              onChange={() => toggle('showDocs')}
            />
          </div>
        </div>
        <p className="text-faint text-[11.5px]">Settings are stored in this browser only.</p>
      </div>
    </Dialog>
  )
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-3.5 w-3.5 accent-[var(--color-accent)]"
      />
      {label}
    </label>
  )
}
