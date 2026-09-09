import { useEffect, useState } from 'react'
import { Button } from './ui'
import {
  desktop,
  type AppInfo,
  type CheckOutcome,
  type FeatureInfo,
  type LicenceStatus,
  type UpdateMode,
} from '../lib/desktop'

/**
 * The desktop-only part of Settings: updates and licensing.
 *
 * Renders nothing in the browser build, where `window.reposcope` does not exist. Everything
 * here reports state the shell owns rather than keeping its own copy, so what the panel says
 * and what the app will actually do cannot drift apart.
 */
export function DesktopSettings() {
  const bridge = desktop()
  const [info, setInfo] = useState<AppInfo>()
  const [licence, setLicence] = useState<LicenceStatus>()
  const [features, setFeatures] = useState<Record<string, FeatureInfo>>({})
  const [grantedFeatures, setGranted] = useState<string[]>([])
  const [keyInput, setKeyInput] = useState('')
  const [keyMessage, setKeyMessage] = useState<string>()
  const [check, setCheck] = useState<CheckOutcome>()
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (!bridge) return
    void bridge.info().then(setInfo)
    void bridge.licence.status().then((s) => {
      setLicence(s.status)
      setFeatures(s.features)
      setGranted(s.granted)
    })
  }, [bridge])

  if (!bridge) return null

  const setMode = async (mode: UpdateMode) => {
    const applied = await bridge.updates.setMode(mode)
    setInfo((current) => (current ? { ...current, updateMode: applied } : current))
  }

  const activate = async () => {
    setKeyMessage(undefined)
    const result = await bridge.licence.set(keyInput)
    setLicence(result.status)
    setGranted(result.granted ?? [])
    if (result.status.state === 'invalid') setKeyMessage(result.status.reason)
    else if (result.status.state === 'expired') setKeyMessage('That licence has expired.')
    else if (result.status.state === 'licensed') {
      setKeyMessage('Licence accepted.')
      setKeyInput('')
    }
  }

  const runCheck = async () => {
    setChecking(true)
    try {
      setCheck(await bridge.updates.check())
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      <div className="border-border border-t pt-4">
        <div className="text-muted mb-1.5 text-[11px] tracking-wide uppercase">Updates</div>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['off', 'Never check'],
              ['notify', 'Ask me'],
              ['auto', 'Install automatically'],
            ] as const
          ).map(([mode, label]) => (
            <Button
              key={mode}
              variant={info?.updateMode === mode ? 'primary' : 'secondary'}
              onClick={() => void setMode(mode)}
            >
              {label}
            </Button>
          ))}
        </div>
        <p className="text-faint mt-2 text-[11.5px]">
          Downloads are checked against the SHA-256 published with the release and installed at the
          next launch. A release without a published checksum is never installed automatically —
          RepoScope will point you at the release page instead.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Button variant="secondary" onClick={() => void runCheck()} disabled={checking}>
            {checking ? 'Checking…' : 'Check now'}
          </Button>
          <Button variant="secondary" onClick={() => void bridge.updates.openReleases()}>
            Release notes
          </Button>
          {info && <span className="text-faint text-[11.5px]">Version {info.version}</span>}
        </div>
        {check && (
          <p
            className={`mt-2 text-[11.5px] ${check.status === 'error' || check.status === 'unavailable' ? 'text-warn' : 'text-muted'}`}
          >
            {check.message}
          </p>
        )}
      </div>

      <div className="border-border border-t pt-4">
        <div className="text-muted mb-1.5 text-[11px] tracking-wide uppercase">Licence</div>
        {licence?.state === 'licensed' ? (
          <p className="text-text text-[12.5px]">
            Licensed to <span className="font-medium">{licence.payload.holder}</span> —{' '}
            {licence.payload.tier}
            {licence.expiresInDays !== undefined && (
              <span className="text-faint">
                {' '}
                · renews in {licence.expiresInDays} day{licence.expiresInDays === 1 ? '' : 's'}
              </span>
            )}
          </p>
        ) : (
          <>
            <p className="text-muted text-[12.5px]">
              {licence?.state === 'expired'
                ? `The licence for ${licence.payload.holder} has expired. RepoScope keeps working; the extras below are switched off.`
                : 'Running unlicensed. The analyzer, the map, the review, the score and the exports are all free and always will be — a licence adds the extras below.'}
            </p>
            <div className="mt-2 flex gap-2">
              <input
                className="border-border bg-surface-2 text-text placeholder:text-faint min-w-0 flex-1 rounded-md border px-2 py-1.5 font-mono text-[11.5px]"
                placeholder="rsl1.…"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                spellCheck={false}
                aria-label="Licence key"
              />
              <Button variant="primary" onClick={() => void activate()} disabled={!keyInput.trim()}>
                Activate
              </Button>
            </div>
          </>
        )}
        {keyMessage && (
          <p
            className={`mt-2 text-[11.5px] ${licence?.state === 'licensed' ? 'text-ok' : 'text-warn'}`}
          >
            {keyMessage}
          </p>
        )}

        <ul className="mt-3 space-y-1.5">
          {Object.entries(features).map(([id, feature]) => {
            const on = grantedFeatures.includes(id)
            return (
              <li key={id} className="flex gap-2 text-[11.5px]">
                <span className={on ? 'text-ok' : 'text-faint'}>{on ? '✓' : '·'}</span>
                <span className="min-w-0">
                  <span className={on ? 'text-text' : 'text-muted'}>{feature.title}</span>
                  <span className="text-faint block">{feature.blurb}</span>
                </span>
              </li>
            )
          })}
        </ul>
      </div>

      {info && !info.git && (
        <p className="text-warn text-[11.5px]">
          <span className="font-medium">git was not found on this machine.</span> Scanning a GitHub
          URL needs it for a shallow clone. Folder scanning works without it. Install git and
          restart RepoScope to enable URL scanning.
        </p>
      )}
    </>
  )
}
