import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function Button({
  variant = 'secondary',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' }) {
  const base =
    'inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50'
  const styles = {
    primary: 'bg-accent text-[#0b0d10] hover:bg-accent-strong',
    secondary:
      'border border-border bg-surface text-text hover:border-border-strong hover:bg-surface-2',
    ghost: 'text-muted hover:bg-surface-2 hover:text-text',
  }[variant]
  return <button className={`${base} ${styles} ${className}`} {...rest} />
}

export function Dialog({
  title,
  onClose,
  children,
  width = 'max-w-md',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: string
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className={`fade-in w-full ${width} border-border bg-surface rounded-xl border p-5 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <button className="text-muted hover:text-text" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Wordmark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const cls = { sm: 'text-[13px]', md: 'text-[15px]', lg: 'text-[28px]' }[size]
  const dot = { sm: 8, md: 9, lg: 14 }[size]
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${cls}`}>
      <svg width={dot * 2} height={dot * 2} viewBox="0 0 24 24" aria-hidden>
        <circle cx="6" cy="12" r="3" fill="var(--color-accent)" />
        <circle cx="18" cy="6" r="3" fill="var(--color-t-service)" />
        <circle cx="18" cy="18" r="3" fill="var(--color-t-database)" />
        <path d="M8.5 11 L15.5 7M8.5 13 L15.5 17" stroke="var(--color-muted)" strokeWidth="1.5" />
      </svg>
      RepoScope
    </span>
  )
}

export function SeverityDot({ severity }: { severity: 'info' | 'warning' | 'critical' }) {
  const color = { info: 'bg-muted', warning: 'bg-warn', critical: 'bg-danger' }[severity]
  return <span className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />
}
