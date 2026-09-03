/** Tiny posix path helpers that work identically on every platform. */

export function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

export function extname(p: string): string {
  const name = basename(p)
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i)
}

export function stripExt(p: string): string {
  const ext = extname(p)
  return ext ? p.slice(0, -ext.length) : p
}

/** Resolve "../x" style specifiers against a directory, normalising "." and "..". */
export function joinNormalize(dir: string, spec: string): string {
  const parts = dir ? dir.split('/') : []
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
