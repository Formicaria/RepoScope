import { SCAN_STAGES, type ScanStatus } from '../../shared/types'
import { Button, Wordmark } from './ui'

export interface ScanProgressProps {
  status: ScanStatus | undefined
  label: string
  uploadNote?: string
  onCancel: () => void
  onRetry: () => void
}

export function ScanProgress({ status, label, uploadNote, onCancel, onRetry }: ScanProgressProps) {
  const stageIndex = status ? SCAN_STAGES.findIndex((s) => s.stage === status.stage) : -1
  const done = status?.stage === 'done'
  const failed = status?.stage === 'error'
  const progress = status?.progress ?? 2

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex h-14 items-center px-6">
        <Wordmark />
      </header>
      <main className="fade-in mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 pb-24">
        <div className="text-muted mb-1 text-[12px]">
          {failed ? 'Scan failed' : done ? 'Scan complete' : 'Scanning'}
        </div>
        <h1 className="truncate font-mono text-[18px] font-medium">{label}</h1>

        {!failed && (
          <>
            <div className="bg-surface-2 mt-6 h-1 overflow-hidden rounded-full">
              <div
                className="bg-accent h-full rounded-full transition-[width] duration-500 ease-out"
                style={{ width: `${Math.max(3, progress)}%` }}
              />
            </div>
            <ol className="mt-6 space-y-3">
              {SCAN_STAGES.map((s, i) => {
                const state =
                  done || i < stageIndex ? 'done' : i === stageIndex ? 'active' : 'pending'
                return (
                  <li key={s.stage} className="flex items-center gap-3 text-[13.5px]">
                    <span className="flex h-4 w-4 items-center justify-center">
                      {state === 'done' ? (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 14 14"
                          fill="none"
                          stroke="var(--color-ok)"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        >
                          <path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" />
                        </svg>
                      ) : state === 'active' ? (
                        <span className="pulse-dot bg-accent h-2 w-2 rounded-full" />
                      ) : (
                        <span className="bg-border-strong h-1.5 w-1.5 rounded-full" />
                      )}
                    </span>
                    <span
                      className={
                        state === 'pending'
                          ? 'text-faint'
                          : state === 'active'
                            ? 'text-text'
                            : 'text-muted'
                      }
                    >
                      {s.label}
                    </span>
                    {state === 'active' && status?.message && (
                      <span className="text-faint ml-auto truncate text-[11.5px]">
                        {status.message}
                      </span>
                    )}
                  </li>
                )
              })}
            </ol>
            {uploadNote && <p className="text-faint mt-4 text-[12px]">{uploadNote}</p>}
            <div className="mt-8">
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </>
        )}

        {failed && (
          <div className="mt-6">
            <div
              className="border-danger/30 bg-danger/10 text-text rounded-lg border p-4 text-[13px] leading-relaxed"
              role="alert"
            >
              <div className="text-danger mb-1 font-medium">{errorTitle(status?.error?.code)}</div>
              {status?.error?.message}
            </div>
            <div className="mt-5 flex gap-2">
              <Button variant="primary" onClick={onRetry}>
                Try another repository
              </Button>
              <Button variant="ghost" onClick={onCancel}>
                Back
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function errorTitle(code: string | undefined): string {
  switch (code) {
    case 'private-repo':
      return 'Repository not accessible'
    case 'invalid-repo':
      return 'Invalid repository'
    case 'too-large':
      return 'Repository too large'
    case 'not-found':
      return 'Not found'
    default:
      return 'Something went wrong'
  }
}
