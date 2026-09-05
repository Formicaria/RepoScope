import { evidenceFrom, type Rule } from './context.js'

/**
 * Craft rules: the difference between code that works and code a senior engineer would sign
 * off on.
 *
 * These target the patterns that make a codebase read as machine-generated or rushed —
 * comments that narrate the line below them, catch blocks that log and carry on, `any` used
 * as an escape hatch, scaffolding left in place. Each rule names the file and line, so the
 * finding is checkable rather than a matter of taste.
 */

/** Split an identifier into lowercase words: `getUserName` -> [get, user, name]. */
function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'this',
  'that',
  'and',
  'or',
  'to',
  'of',
  'for',
  'in',
  'on',
  'is',
  'are',
  'we',
  'it',
  'its',
  'be',
  'will',
  'then',
  'with',
  'from',
  'by',
  'as',
  'if',
  'all',
  'new',
  'set',
  'get',
  'now',
  'here',
  'up',
  'out',
])

/** A comment that explains intent rather than restating the code is always worth keeping. */
const EXPLANATORY =
  /\b(because|since|why|note|caveat|beware|workaround|hack|todo|fixme|see |ref |refs |spec|rfc|issue|bug|per |assumes?|invariant|must|cannot|do not|don't|otherwise|instead|historically|legacy|temporar|deliberate|intentional)\b/i

const narratingComments: Rule = {
  id: 'craft/narrating-comments',
  category: 'craft',
  severity: 'medium',
  confidence: 'likely',
  effort: 'quick',
  run(ctx) {
    const hits: { path: string; line: number }[] = []
    let total = 0
    for (const { file, structure } of ctx.structures) {
      const lines = file.content?.split('\n') ?? []
      for (const comment of structure.comments) {
        const text = comment.text.trim()
        if (!text || text.length > 90) continue
        if (EXPLANATORY.test(text)) continue
        if (/^[@\-*=#/]|^\w+:/.test(text)) continue // JSDoc tags, section banners, key: value
        const commentWords = words(text.replace(/[^\w\s]/g, ' ')).filter((w) => !STOP_WORDS.has(w))
        if (commentWords.length < 2 || commentWords.length > 7) continue
        // Compare against the next non-blank line of code.
        let next = ''
        for (let i = comment.line; i < Math.min(comment.line + 2, lines.length); i++) {
          const candidate = lines[i]?.trim()
          if (candidate && !/^(\/\/|#|\*|\/\*)/.test(candidate)) {
            next = candidate
            break
          }
        }
        if (!next) continue
        const codeWords = new Set(words(next.replace(/[^\w\s]/g, ' ')))
        const overlap = commentWords.filter((w) => codeWords.has(w)).length / commentWords.length
        total++
        if (overlap >= 0.6) hits.push({ path: file.path, line: comment.line })
      }
    }
    // A handful is normal. A pattern is a pattern.
    if (hits.length < 5 || hits.length / Math.max(1, total) < 0.08) return
    return {
      title: `${hits.length} comments restate the line beneath them`,
      detail:
        'Comments like `// increment the counter` above `counter++` cost a line to read and go stale the moment the code changes. Dense narration is the clearest signal that code was generated rather than written, and it crowds out the comments that would have been worth reading.',
      fix: 'Delete comments that a reader could get from the identifier. Keep the ones that answer *why* — the constraint, the bug being worked around, the reason for the unobvious choice. If a comment is needed to say what a block does, that block usually wants a name instead.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const swallowedErrors: Rule = {
  id: 'craft/swallowed-errors',
  category: 'reliability',
  severity: 'high',
  confidence: 'certain',
  effort: 'moderate',
  run(ctx) {
    const empty: { path: string; line: number }[] = []
    const logging: { path: string; line: number }[] = []
    for (const { file, structure } of ctx.structures) {
      for (const c of structure.catches) {
        if (c.isEmpty) empty.push({ path: file.path, line: c.line })
        else if (c.swallows) logging.push({ path: file.path, line: c.line })
      }
    }
    const results = []
    if (empty.length) {
      results.push({
        severity: 'high' as const,
        title: `${empty.length} catch block${empty.length === 1 ? '' : 's'} discard the error entirely`,
        detail:
          'An empty catch turns a failure into a silent wrong answer. The operation did not happen, nothing was recorded, and the next symptom will appear somewhere unrelated and be very expensive to trace.',
        fix: 'Decide, per block, which it is: recoverable (handle it and say so in a comment), reportable (log with context and rethrow or return a typed error), or impossible (assert it). An intentionally ignored error should say why in a one-line comment.',
        evidence: evidenceFrom(ctx, empty),
        occurrences: empty.length,
      })
    }
    if (logging.length >= 3) {
      results.push({
        severity: 'medium' as const,
        title: `${logging.length} catch blocks log the error and continue`,
        detail:
          'Logging is not handling. The caller is told the operation succeeded, so it proceeds on data that was never written or fetched — and the log line is only found later, after someone notices the wrong result.',
        fix: 'Let failures propagate unless this frame can genuinely recover. Where recovery is real, return an explicit result (`{ ok: false, error }` or a typed error) so the caller has to deal with it. Reserve catch-and-log for the top-level boundary that turns an error into a response or an exit code.',
        evidence: evidenceFrom(ctx, logging),
        occurrences: logging.length,
      })
    }
    return results
  },
}

const anyEscapeHatch: Rule = {
  id: 'craft/any-escape-hatch',
  category: 'maintainability',
  severity: 'medium',
  confidence: 'certain',
  effort: 'moderate',
  run(ctx) {
    const tsFiles = ctx.structures.filter(({ file }) => /\.(ts|tsx|mts|cts)$/.test(file.path))
    if (tsFiles.length < 5) return
    const hits: { path: string; line: number }[] = []
    let total = 0
    for (const { file, structure } of tsFiles) {
      total += structure.anyAnnotations
      if (structure.anyAnnotations > 0) {
        const lineNo = file.content?.split('\n').findIndex((l) => /\bany\b/.test(l))
        hits.push({
          path: file.path,
          line: lineNo !== undefined && lineNo >= 0 ? lineNo + 1 : (undefined as never),
        })
      }
    }
    const perFile = total / tsFiles.length
    if (total < 10 || perFile < 0.5) return
    return {
      title: `${total} explicit \`any\` annotations across ${hits.length} files`,
      detail:
        '`any` switches off the type checker for everything downstream of it, so the guarantees the rest of the codebase pays for stop at that boundary. A high density usually means the types were never worked out rather than that they are genuinely unknowable.',
      fix: 'Replace the easy ones with the real type. Where the shape truly is unknown — parsed JSON, a third-party payload — use `unknown` and narrow it at the boundary with a type guard or a schema parse. Turn on `noImplicitAny` and fix the resulting list once rather than continuously.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: total,
    }
  },
}

const leftoverScaffolding: Rule = {
  id: 'craft/leftover-scaffolding',
  category: 'craft',
  severity: 'medium',
  confidence: 'certain',
  effort: 'quick',
  run(ctx) {
    const todos: { path: string; line: number }[] = []
    const placeholders: { path: string; line: number }[] = []
    for (const { file, structure } of ctx.structures) {
      for (const c of structure.comments) {
        if (/\b(TODO|FIXME|XXX|HACK)\b/.test(c.text)) todos.push({ path: file.path, line: c.line })
      }
      for (const s of structure.strings) {
        const v = s.value.trim()
        // An identifier-shaped string is a key, not user-facing filler: `placeholder_name`
        // is an i18n key, `placeholder text` is scaffolding.
        const looksLikeKey = /^[a-z0-9_.:-]+$/i.test(v) && !/^(your|my|change)[-_]/i.test(v)
        if (looksLikeKey) continue
        if (
          // `your-api-key` is a placeholder; "reset your password" is a real sentence, so
          // the separator is required rather than optional.
          /\byour[-_](api[-_])?(key|token|secret|password|domain|username|email|id)\b/i.test(v) ||
          /\b(insert[-_ ]here|replace[-_ ]me|change[-_ ]?me|lorem ipsum|coming soon|not implemented yet)\b/i.test(
            v,
          ) ||
          /^(foo ?bar|test ?123|abc ?123|asdf|qwerty|xxx+)$/i.test(v)
        ) {
          placeholders.push({ path: file.path, line: s.line })
        }
      }
    }
    const results = []
    if (todos.length >= 8) {
      results.push({
        severity: 'low' as const,
        title: `${todos.length} TODO and FIXME markers`,
        detail:
          'A backlog kept in comments is invisible to everyone who is not reading that file. Markers accumulate until nobody trusts them, and the genuinely urgent ones are indistinguishable from the aspirational ones.',
        fix: 'Move anything real into the issue tracker with the context that makes it actionable, and delete the rest. If you keep them in code, give each one an owner and a ticket reference so it can be closed.',
        evidence: evidenceFrom(ctx, todos),
        occurrences: todos.length,
      })
    }
    if (placeholders.length) {
      results.push({
        severity: 'medium' as const,
        title: `${placeholders.length} placeholder value${placeholders.length === 1 ? '' : 's'} left in the source`,
        detail:
          'Strings like `your-api-key-here` or `Lorem ipsum` are scaffolding that survived into committed code. At best they reach a user; at worst something reads them as configuration and fails in a way that looks like a bug elsewhere.',
        fix: 'Replace each with the real value, a required environment variable, or content the product actually needs. If a sample value is genuinely wanted, keep it in `.env.example` or a fixture rather than in source.',
        evidence: evidenceFrom(ctx, placeholders),
        occurrences: placeholders.length,
      })
    }
    return results
  },
}

const commentedOutCode: Rule = {
  id: 'craft/commented-out-code',
  category: 'craft',
  severity: 'low',
  confidence: 'likely',
  effort: 'quick',
  run(ctx) {
    const hits: { path: string; line: number }[] = []
    for (const { file, structure } of ctx.structures) {
      for (const c of structure.comments) {
        const t = c.text.trim()
        if (t.length < 8 || t.length > 200) continue
        if (EXPLANATORY.test(t)) continue
        const looksLikeCode =
          /^(const|let|var|function|def|class|import|from|return|await|if|for|while|else|public|private|self\.|this\.)\b/.test(
            t,
          ) ||
          /[;{}]\s*$/.test(t) ||
          /^\w+\s*[=(].*[)\]};]\s*$/.test(t)
        if (looksLikeCode) hits.push({ path: file.path, line: c.line })
      }
    }
    if (hits.length < 6) return
    return {
      title: `${hits.length} lines of commented-out code`,
      detail:
        'Commented-out code is ambiguous: a reader cannot tell whether it is a fallback, a work in progress, or something someone was afraid to delete. It is never updated with the code around it, so it decays into a misleading description of an older design.',
      fix: 'Delete it. Version control already remembers it, and `git log -S` finds it in seconds. If it is needed soon, keep it on a branch rather than in the file.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const debugLogging: Rule = {
  id: 'craft/debug-logging',
  category: 'craft',
  severity: 'low',
  confidence: 'likely',
  effort: 'quick',
  run(ctx) {
    const hits: { path: string; line: number }[] = []
    for (const { file, structure } of ctx.structures) {
      // A CLI legitimately prints; a library or request handler should not.
      if (/(^|\/)(cli|bin|scripts?|commands?)\//.test(file.path)) continue
      for (const call of structure.calls) {
        if (/^console\.(log|debug|info)$/.test(call.name))
          hits.push({ path: file.path, line: call.line })
        if (/^print$/.test(call.name) && /\.py$/.test(file.path))
          hits.push({ path: file.path, line: call.line })
      }
    }
    if (hits.length < 10) return
    return {
      title: `${hits.length} raw \`console.log\` / \`print\` calls in application code`,
      detail:
        'Ad-hoc printing has no level, no structure and no way to switch off, so production logs are either noise or silence. It also leaks whatever was being debugged — often request bodies or tokens — into wherever stdout goes.',
      fix: 'Use one logger with levels and structured fields (pino, winston, or the standard `logging` module) configured once at startup. Delete the calls that were only ever for a debugging session.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const oversizedFunctions: Rule = {
  id: 'craft/oversized-functions',
  category: 'maintainability',
  severity: 'medium',
  confidence: 'certain',
  effort: 'large',
  run(ctx) {
    const long: { path: string; line: number; name: string; lines: number }[] = []
    const nested: { path: string; line: number }[] = []
    for (const { file, structure } of ctx.structures) {
      for (const fn of structure.functions) {
        if (fn.lines > 80)
          long.push({ path: file.path, line: fn.line, name: fn.name, lines: fn.lines })
        if (fn.maxNesting >= 5) nested.push({ path: file.path, line: fn.line })
      }
    }
    const results = []
    if (long.length >= 3) {
      const worst = [...long].sort((a, b) => b.lines - a.lines).slice(0, 5)
      results.push({
        title: `${long.length} functions longer than 80 lines`,
        detail: `The longest is ${worst[0].name} at ${worst[0].lines} lines. A function that long holds more state in the reader's head than they can keep, cannot be unit tested in pieces, and tends to collect responsibilities because there is already somewhere to put them.`,
        fix: 'Extract the coherent middle sections into named functions — the names then document what the original was doing step by step. Aim for a body that fits on one screen and does one thing at one level of abstraction.',
        evidence: evidenceFrom(ctx, worst),
        occurrences: long.length,
      })
    }
    if (nested.length >= 3) {
      results.push({
        severity: 'medium' as const,
        title: `${nested.length} functions nest five or more levels deep`,
        detail:
          'Every level of nesting is a condition the reader has to keep true while reading the rest. Past about four, the code is effectively unreviewable and the edge cases stop being obvious.',
        fix: 'Invert the conditions and return early, extract the inner block into its own function, or replace the nesting with a lookup or a guard clause chain. Handling the failure cases first usually flattens the whole body.',
        evidence: evidenceFrom(ctx, nested),
        occurrences: nested.length,
      })
    }
    return results
  },
}

const longParameterLists: Rule = {
  id: 'craft/long-parameter-lists',
  category: 'maintainability',
  severity: 'low',
  confidence: 'certain',
  effort: 'moderate',
  run(ctx) {
    const hits: { path: string; line: number }[] = []
    for (const { file, structure } of ctx.structures) {
      for (const fn of structure.functions) {
        if (fn.params >= 6) hits.push({ path: file.path, line: fn.line })
      }
    }
    if (hits.length < 3) return
    return {
      title: `${hits.length} functions take six or more parameters`,
      detail:
        'Long positional parameter lists are easy to call incorrectly — two adjacent arguments of the same type will eventually be swapped, and the compiler will not notice. They also signal that the function is doing several jobs.',
      fix: 'Take a single options object with named fields, so call sites read as documentation and new parameters do not change the meaning of existing ones. Where several parameters always travel together, give that group a type of its own.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const duplicatedBlocks: Rule = {
  id: 'craft/duplicated-blocks',
  category: 'maintainability',
  severity: 'medium',
  confidence: 'likely',
  effort: 'moderate',
  run(ctx) {
    const WINDOW = 6
    const seen = new Map<string, { path: string; line: number }[]>()
    for (const f of ctx.sourceFiles) {
      if (!f.content) continue
      const raw = f.content.split('\n')
      const norm = raw.map((l) => l.trim().replace(/\s+/g, ' '))
      for (let i = 0; i + WINDOW <= norm.length; i++) {
        const slice = norm.slice(i, i + WINDOW)
        // Skip windows that are mostly trivial: blanks, braces, imports, comments.
        const substantive = slice.filter(
          (l) => l.length > 12 && !/^(import|from|use|#include|\}|\)|\{|\/\/|#|\*)/.test(l),
        )
        if (substantive.length < WINDOW - 1) continue
        // Repeated prose — docstrings on overloads, licence headers — is not duplicated logic.
        const codeShaped = slice.filter((l) => /[=;{}()[\]]|=>|:\s*$/.test(l)).length
        if (codeShaped < WINDOW - 2) continue
        const key = slice.join('\n')
        const list = seen.get(key) ?? []
        // Only the first window of a run, to avoid reporting the same clone many times.
        if (
          list.length &&
          list[list.length - 1].path === f.path &&
          i - list[list.length - 1].line < WINDOW
        )
          continue
        list.push({ path: f.path, line: i + 1 })
        seen.set(key, list)
      }
    }
    const clones = [...seen.values()].filter((v) => v.length >= 3)
    if (clones.length < 2) return
    const flat = clones.flatMap((c) => c.slice(0, 2))
    return {
      title: `${clones.length} blocks of code repeated three or more times`,
      detail:
        'Identical blocks in several places means a fix has to be found and applied in each one. In practice one gets missed, and the copies drift until nobody can tell which behaviour is intended.',
      fix: 'Extract each repeated block into a named function or a shared module and call it from every site. Where the copies differ slightly, make the difference a parameter rather than keeping variants.',
      evidence: evidenceFrom(ctx, flat),
      occurrences: clones.length,
    }
  },
}

const inconsistentNaming: Rule = {
  id: 'craft/inconsistent-naming',
  category: 'craft',
  severity: 'low',
  confidence: 'likely',
  effort: 'moderate',
  run(ctx) {
    const jsFiles = ctx.structures.filter(({ file }) => /\.(ts|tsx|js|jsx|mjs)$/.test(file.path))
    if (jsFiles.length < 5) return
    let camel = 0
    let snake = 0
    const hits: { path: string; line: number }[] = []
    for (const { file, structure } of jsFiles) {
      for (const fn of structure.functions) {
        if (fn.name === 'anonymous') continue
        if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(fn.name)) {
          snake++
          hits.push({ path: file.path, line: fn.line })
        } else if (/^[a-z][a-zA-Z0-9]*$/.test(fn.name) && /[A-Z]/.test(fn.name)) camel++
      }
    }
    const total = camel + snake
    const minority = Math.min(camel, snake)
    if (total < 15 || minority < 4 || minority / total < 0.1) return
    return {
      title: `Function names mix camelCase and snake_case (${camel} vs ${snake})`,
      detail:
        'Two naming conventions in one JavaScript or TypeScript codebase means every reader has to guess which one a given call site used, and every search has to be run twice. It usually happens when code arrives from different sources without being made to match.',
      fix: 'Pick camelCase — the JavaScript convention — and rename the minority in one mechanical pass. Add a lint rule (`@typescript-eslint/naming-convention`) so the decision holds without anyone policing it.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: snake,
    }
  },
}

const hypeComments: Rule = {
  id: 'craft/decorative-comments',
  category: 'craft',
  severity: 'low',
  confidence: 'likely',
  effort: 'quick',
  run(ctx) {
    const hits: { path: string; line: number }[] = []
    for (const { file, structure } of ctx.structures) {
      for (const c of structure.comments) {
        const emoji = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}]/u.test(c.text)
        const hype =
          /\b(blazing[- ]fast|super[- ]fast|lightning[- ]fast|magic(al)?|awesome|amazing|beautiful|elegant solution|the heart of|powerful|seamless|robust and|state[- ]of[- ]the[- ]art)\b/i.test(
            c.text,
          )
        const banner = /^[=\-*#~_]{10,}$/.test(c.text.trim())
        if (emoji || hype || banner) hits.push({ path: file.path, line: c.line })
      }
    }
    if (hits.length < 5) return
    return {
      title: `${hits.length} decorative or promotional comments`,
      detail:
        'Emoji, ASCII banners and self-congratulation ("blazing fast", "elegant solution") tell the reader nothing about the code and date badly. They read as filler, which makes the surrounding comments easier to skip.',
      fix: 'Remove them. Where a banner is separating sections of a long file, that file usually wants splitting instead — the module boundary does the job the banner was doing.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const hardCodedEnvironment: Rule = {
  id: 'craft/hard-coded-environment',
  category: 'maintainability',
  severity: 'medium',
  confidence: 'likely',
  effort: 'quick',
  run(ctx) {
    const hits: { path: string; line: number }[] = []
    for (const { file, structure } of ctx.structures) {
      if (/(^|\/)(config|settings)[^/]*$/.test(file.path)) continue
      for (const s of structure.strings) {
        if (
          /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\d+\.\d+\.\d+\.\d+)(:\d+)?/.test(s.value)
        )
          hits.push({ path: file.path, line: s.line })
        else if (
          /^https?:\/\/[a-z0-9-]+\.(com|io|dev|net|org|app|co)\b/i.test(s.value) &&
          !/localhost|example\.|schema|xmlns|w3\.org|json-schema|spdx|github\.com\/[\w-]+\/[\w-]+$/i.test(
            s.value,
          )
        )
          hits.push({ path: file.path, line: s.line })
      }
    }
    if (hits.length < 4) return
    return {
      title: `${hits.length} hard-coded URLs and hosts in application code`,
      detail:
        'Addresses embedded in source cannot differ between development, staging and production without editing code, so someone eventually ships a build pointing at the wrong environment — or at their laptop.',
      fix: 'Read them from configuration once at startup, validate that they are present, and pass the resulting typed config down. One module that owns environment access makes the full set of required variables obvious.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const undocumentedPublicApi: Rule = {
  id: 'craft/undocumented-exports',
  category: 'documentation',
  severity: 'low',
  confidence: 'possible',
  effort: 'moderate',
  run(ctx) {
    const candidates = ctx.structures.filter(({ file }) => /\.(ts|tsx|js|jsx|py)$/.test(file.path))
    if (candidates.length < 8) return
    let documented = 0
    let undocumented = 0
    const hits: { path: string; line: number }[] = []
    for (const { file, structure } of candidates) {
      for (const fn of structure.functions) {
        // Only sizeable, named functions — one-line helpers rarely need prose.
        if (fn.name === 'anonymous' || fn.lines < 15) continue
        if (fn.documented) documented++
        else {
          undocumented++
          hits.push({ path: file.path, line: fn.line })
        }
      }
    }
    const total = documented + undocumented
    if (total < 20 || undocumented / total < 0.85) return
    return {
      title: `${undocumented} of ${total} substantial functions have no explanatory comment`,
      detail:
        'Nothing in the codebase records why these exist or what a caller must know before using them, so every reader reconstructs it from the body. That cost is paid again by every new person and every future you.',
      fix: 'Document the ones with a non-obvious contract — what it assumes, what it returns on failure, what it mutates. Leave the self-evident ones alone; a comment on every function is its own kind of noise.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: undocumented,
    }
  },
}

export const craftRules: Rule[] = [
  narratingComments,
  swallowedErrors,
  anyEscapeHatch,
  leftoverScaffolding,
  commentedOutCode,
  debugLogging,
  oversizedFunctions,
  longParameterLists,
  duplicatedBlocks,
  inconsistentNaming,
  hypeComments,
  hardCodedEnvironment,
  undocumentedPublicApi,
]
