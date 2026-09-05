import { evidenceFrom, type ReviewContext, type Rule } from './context.js'

/**
 * Security rules.
 *
 * Each one looks for a specific defect with a known exploit path, cites the line, and says
 * what to write instead. Nothing here reports "consider security best practices"; a finding
 * a reader cannot act on is noise, and noise is how a scanner gets ignored.
 *
 * These are static heuristics, not a substitute for a real SAST tool or a security review —
 * the UI says so, and every finding carries a confidence.
 */

/**
 * Whether untrusted input can reach a sink depends on there being a request path at all.
 * In an application there usually is one. In a library or a compiler — where `new Function`
 * and `innerHTML` are often the product rather than a mistake — the analyzer cannot tell,
 * so the finding is reported at lower severity and lower confidence rather than asserted.
 */
function reachability(ctx: ReviewContext): {
  severity: 'high' | 'medium'
  confidence: 'likely' | 'possible'
  note: string
} {
  return ctx.isApplication
    ? { severity: 'high', confidence: 'likely', note: '' }
    : {
        severity: 'medium',
        confidence: 'possible',
        note: ' This project looks like a library rather than a deployed application, so whether untrusted input can reach this depends on how callers use it — in a compiler or a renderer, this may be exactly the intended behaviour.',
      }
}

/** A string built by concatenation or interpolation, i.e. not a constant. */
const INTERPOLATED = /\$\{|`[^`]*\$\{|["'][^"']*["']\s*\+|\+\s*["']|%\s*\(|\.format\(|f["']/

function scanLines(
  ctx: ReviewContext,
  test: (line: string, path: string) => boolean,
  options: { skipComments?: boolean } = {},
) {
  const hits: { path: string; line: number }[] = []
  for (const f of ctx.sourceFiles) {
    if (!f.content) continue
    const lines = f.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.length > 400) continue
      if (options.skipComments !== false && /^\s*(\/\/|#|\*|<!--)/.test(line)) continue
      if (test(line, f.path)) hits.push({ path: f.path, line: i + 1 })
    }
  }
  return hits
}

const sqlInjection: Rule = {
  id: 'security/sql-injection',
  category: 'security',
  severity: 'critical',
  confidence: 'likely',
  effort: 'moderate',
  run(ctx) {
    const hits: { path: string; line: number }[] = []
    for (const { file, structure } of ctx.structures) {
      for (const call of structure.calls) {
        // Query APIs across the ecosystems RepoScope parses.
        if (!/\b(query|execute|executemany|raw|rawQuery|exec|Query|Exec|prepare)$/.test(call.name))
          continue
        if (!INTERPOLATED.test(call.args)) continue
        // Parameterised calls pass the values separately: query(sql, [a, b]).
        if (/,\s*\[/.test(call.args) || /,\s*\(/.test(call.args)) continue
        if (!/\b(select|insert|update|delete|from|where|values|join)\b/i.test(call.args)) continue
        hits.push({ path: file.path, line: call.line })
      }
    }
    if (!hits.length) return
    return {
      title: `SQL built by string interpolation in ${hits.length} place${hits.length === 1 ? '' : 's'}`,
      detail:
        'A query assembled from interpolated values lets anything that reaches those values rewrite the statement. One unescaped input is the difference between reading a row and dumping the table.',
      fix: 'Pass values as parameters instead of interpolating them: `db.query("SELECT * FROM users WHERE id = $1", [id])`, `cursor.execute("… = %s", (id,))`. If the variable part is an identifier rather than a value, validate it against an allow-list of column names.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const commandInjection: Rule = {
  id: 'security/command-injection',
  category: 'security',
  severity: 'critical',
  confidence: 'likely',
  effort: 'moderate',
  run(ctx) {
    const hits: { path: string; line: number }[] = []
    for (const { file, structure } of ctx.structures) {
      for (const call of structure.calls) {
        const shellCall =
          /\b(exec|execSync|spawnSync|system|popen|shell_exec|passthru)$/.test(call.name) ||
          /subprocess\.(run|call|check_output|Popen)$/.test(call.name)
        if (!shellCall) continue
        if (!INTERPOLATED.test(call.args)) continue
        // subprocess with an argument list and no shell=True is already safe.
        if (/shell\s*=\s*False/.test(call.args)) continue
        if (/^\(\s*\[/.test(call.args) && !/shell\s*=\s*True/.test(call.args)) continue
        hits.push({ path: file.path, line: call.line })
      }
    }
    if (!hits.length) return
    return {
      title: `Shell command built from interpolated values (${hits.length})`,
      detail:
        'Anything that reaches the interpolated value can append `; rm -rf /` or a backtick sub-shell and run it with the privileges of the process.',
      fix: 'Use the argument-array form so the shell never parses the input: `execFile("git", ["clone", url])` in Node, `subprocess.run(["git", "clone", url])` in Python. Where a shell really is required, validate the input against a strict pattern first.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const dynamicEvaluation: Rule = {
  id: 'security/dynamic-code-execution',
  category: 'security',
  severity: 'high',
  confidence: 'certain',
  effort: 'moderate',
  run(ctx) {
    const hits: { path: string; line: number }[] = []
    for (const { file, structure } of ctx.structures) {
      for (const call of structure.calls) {
        if (/^(eval|Function|execScript)$/.test(call.name) || /^new Function$/.test(call.name))
          hits.push({ path: file.path, line: call.line })
        if (/^(pickle|cPickle)\.loads?$/.test(call.name))
          hits.push({ path: file.path, line: call.line })
        // yaml.load without SafeLoader constructs arbitrary Python objects.
        if (/^yaml\.load$/.test(call.name) && !/SafeLoader|Loader\s*=\s*yaml\.Safe/.test(call.args))
          hits.push({ path: file.path, line: call.line })
      }
    }
    if (!hits.length) return
    const reach = reachability(ctx)
    return {
      severity: reach.severity,
      confidence: reach.confidence,
      title: `Code or data evaluated at runtime (${hits.length})`,
      detail:
        '`eval`, `new Function`, `pickle.loads` and `yaml.load` all turn data into executing code. If the input is ever attacker-influenced this is remote code execution; even when it is not, it defeats bundlers, minifiers and static analysis.' +
        reach.note,
      fix: 'Replace with the safe equivalent: `JSON.parse` for data, a lookup table for dispatch, `yaml.safe_load` for YAML, and a serialisation format such as JSON or msgpack instead of pickle.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const xss: Rule = {
  id: 'security/xss-sink',
  category: 'security',
  severity: 'high',
  confidence: 'likely',
  effort: 'moderate',
  run(ctx) {
    const hits = scanLines(ctx, (line, path) => {
      if (/dangerouslySetInnerHTML/.test(line)) return !/DOMPurify|sanitize/i.test(line)
      if (/\.innerHTML\s*=/.test(line)) return !/=\s*['"`]\s*['"`]/.test(line)
      if (/\bv-html\b/.test(line)) return true
      // Handlebars' unescaped triple-stache, but only where a template actually lives —
      // an f-string with nested braces is not an XSS sink.
      if (/\.(hbs|handlebars|mustache|html)$/.test(path) && /\{\{\{/.test(line)) return true
      return false
    })
    if (!hits.length) return
    const reach = reachability(ctx)
    return {
      severity: reach.severity,
      confidence: reach.confidence,
      title: `Untrusted HTML written into the DOM (${hits.length})`,
      detail:
        'Assigning to `innerHTML`, `dangerouslySetInnerHTML` or `v-html` renders whatever the string contains, including `<script>` and event handlers. Any user-supplied text that reaches it becomes cross-site scripting.' +
        reach.note,
      fix: 'Render text as text (`textContent`, JSX children, `{{ }}`). When HTML really is the payload — rendered Markdown, a rich-text field — sanitise it first with DOMPurify or an equivalent, and keep the allow-list narrow.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const tlsDisabled: Rule = {
  id: 'security/tls-verification-disabled',
  category: 'security',
  severity: 'critical',
  confidence: 'certain',
  effort: 'quick',
  run(ctx) {
    const hits = scanLines(ctx, (line) =>
      /rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|verify\s*=\s*False|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|CURLOPT_SSL_VERIFYPEER\s*,\s*(false|0)|ServerCertificateValidationCallback\s*\+?=\s*.*true/.test(
        line,
      ),
    )
    if (!hits.length) return
    return {
      title: `TLS certificate verification is switched off (${hits.length})`,
      detail:
        'With verification disabled, any machine on the network path can present its own certificate and read or rewrite the traffic. It is usually added to silence a self-signed certificate in development and then ships.',
      fix: 'Remove the flag and trust the right certificate authority instead: point `NODE_EXTRA_CA_CERTS` (or the language equivalent) at your internal CA bundle for development, and leave verification on everywhere.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const weakCrypto: Rule = {
  id: 'security/weak-crypto',
  category: 'security',
  severity: 'high',
  confidence: 'likely',
  effort: 'moderate',
  run(ctx) {
    const hits = scanLines(ctx, (line) => {
      // MD5/SHA1 used where a password or token is involved.
      if (/\b(md5|sha1)\b/i.test(line) && /pass|pwd|secret|token|credential|auth/i.test(line))
        return true
      // Math.random() for anything that must be unguessable.
      if (
        /Math\.random\(\)/.test(line) &&
        /token|secret|password|key|nonce|salt|otp|session|uuid|id\b/i.test(line)
      )
        return true
      if (
        /\brandom\.(random|randint|choice)\(/.test(line) &&
        /token|secret|password|key|otp/i.test(line)
      )
        return true
      return false
    })
    if (!hits.length) return
    return {
      title: `Weak algorithm used for a security value (${hits.length})`,
      detail:
        'MD5 and SHA-1 are fast and broken, which is exactly wrong for password hashing. `Math.random()` is a predictable PRNG — an attacker who sees a few outputs can predict the rest, so tokens minted from it are guessable.',
      fix: 'Hash passwords with argon2id or bcrypt through a maintained library. Generate tokens with `crypto.randomUUID()`, `crypto.randomBytes(32)` or `secrets.token_urlsafe(32)`.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const secretFallback: Rule = {
  id: 'security/secret-default-value',
  category: 'security',
  severity: 'critical',
  confidence: 'certain',
  effort: 'quick',
  run(ctx) {
    const hits = scanLines(ctx, (line) =>
      /(?:SECRET|TOKEN|PASSWORD|API_?KEY|PRIVATE_KEY)[A-Z_]*\s*(?:\)|\])?\s*(?:\|\||\?\?|,\s*)\s*['"][^'"]{3,}['"]/.test(
        line,
      ),
    )
    if (!hits.length) return
    return {
      title: `A secret falls back to a hard-coded default (${hits.length})`,
      detail:
        'A pattern like `process.env.JWT_SECRET || "dev-secret"` means a misconfigured deployment starts successfully with a secret that is public in your repository, and signs real tokens with it. Silent is worse than broken here.',
      fix: 'Fail fast instead: read the variable at startup, and exit with a clear message when it is missing. A one-line assertion in the config module catches this before the first request.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const permissiveCors: Rule = {
  id: 'security/permissive-cors',
  category: 'security',
  severity: 'high',
  confidence: 'likely',
  effort: 'quick',
  run(ctx) {
    if (!ctx.isApplication) return
    const hits = scanLines(ctx, (line) => {
      if (/Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*/.test(line)) return true
      if (/origin\s*:\s*['"]\*['"]/.test(line)) return true
      if (/allow_origins\s*=\s*\[?\s*['"]\*/.test(line)) return true
      if (/cors\(\s*\)/.test(line)) return true // express `cors()` defaults to *
      return false
    })
    if (!hits.length) return
    const credentials = ctx.sourceFiles.some((f) =>
      /credentials\s*:\s*true|allow_credentials\s*=\s*True|withCredentials/.test(f.content ?? ''),
    )
    return {
      severity: credentials ? 'critical' : 'high',
      title: 'CORS is open to every origin',
      detail: credentials
        ? 'The API allows any origin *and* sends credentials, so any site a logged-in user visits can call it with their cookies and read the response.'
        : 'Any website can call this API from a visitor’s browser. That is fine for a public read-only endpoint and dangerous for anything that acts on behalf of a user.',
      fix: 'List the origins you actually serve: `cors({ origin: ["https://app.example.com"] })`. Keep the wildcard only for endpoints that are genuinely public and never read cookies or authorization headers.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const debugEnabled: Rule = {
  id: 'security/debug-mode',
  category: 'security',
  severity: 'high',
  confidence: 'likely',
  effort: 'quick',
  run(ctx) {
    // A framework defining `DEBUG` as a config key is not a deployed app with debug on.
    if (!ctx.isApplication) return
    const hits = scanLines(ctx, (line, path) => {
      if (/(^|\/)(settings|config)[^/]*\.py$/.test(path) && /^\s*DEBUG\s*=\s*True/.test(line))
        return true
      if (/\.run\([^)]*debug\s*=\s*True/.test(line)) return true
      if (/app\.debug\s*=\s*true/i.test(line)) return true
      return false
    })
    if (!hits.length) return
    return {
      title: 'Debug mode is enabled in committed configuration',
      detail:
        'Debug mode renders stack traces, local variables and often an interactive console to whoever triggers an error. On a reachable host that is a full disclosure of the application’s internals.',
      fix: 'Read it from the environment with a safe default: `DEBUG = os.environ.get("DEBUG") == "1"`. Keep it off unless a developer opts in.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const pathTraversal: Rule = {
  id: 'security/path-traversal',
  category: 'security',
  severity: 'high',
  confidence: 'possible',
  effort: 'moderate',
  run(ctx) {
    const hits = scanLines(ctx, (line) => {
      const joins = /(path\.join|os\.path\.join|filepath\.Join|Path\()/.test(line)
      if (!joins) return false
      // A request-derived value flowing straight into a path.
      return /req\.(params|query|body)|request\.(args|form|json|GET|POST)|ctx\.params|c\.Param|params\[/.test(
        line,
      )
    })
    if (!hits.length) return
    return {
      title: `A request value is used to build a filesystem path (${hits.length})`,
      detail:
        'If the value can contain `../`, the caller chooses which file the process reads or writes — commonly `/etc/passwd`, application source, or a deployment key.',
      fix: 'Resolve the path and confirm it is still inside the intended directory before touching it: resolve both, then check the result starts with the base directory. Better still, map an opaque id to a filename you control rather than accepting a path at all.',
      evidence: evidenceFrom(ctx, hits),
      occurrences: hits.length,
    }
  },
}

const missingHelmet: Rule = {
  id: 'security/missing-security-headers',
  category: 'security',
  severity: 'medium',
  confidence: 'likely',
  effort: 'quick',
  run(ctx) {
    if (!ctx.isApplication) return
    const isExpress = ctx.frameworks.has('Express') || ctx.hasDependency('express')
    if (!isExpress) return
    if (ctx.hasDependency('helmet')) return
    const hasManualHeaders = ctx.sourceFiles.some((f) =>
      /Content-Security-Policy|X-Frame-Options|Strict-Transport-Security/i.test(f.content ?? ''),
    )
    if (hasManualHeaders) return
    return {
      title: 'No security response headers are set',
      detail:
        'Express sends no Content-Security-Policy, HSTS, X-Content-Type-Options or frame-ancestors headers by default. Without them the browser cannot help defend the app against injected script, clickjacking or protocol downgrade.',
      fix: 'Add `helmet()` as the first middleware and then tighten its Content-Security-Policy to the origins you actually load from. It is one line and a config block.',
      evidence: [],
    }
  },
}

const missingRateLimit: Rule = {
  id: 'security/no-rate-limiting',
  category: 'security',
  severity: 'medium',
  confidence: 'possible',
  effort: 'moderate',
  run(ctx) {
    if (!ctx.isApplication) return
    const authRoutes = ctx.sourceRoutes.filter((r) =>
      /login|signin|sign-in|auth|token|register|signup|password|otp|verify/i.test(r.path),
    )
    if (!authRoutes.length) return
    const limiters = [
      'express-rate-limit',
      'rate-limiter-flexible',
      'koa-ratelimit',
      '@fastify/rate-limit',
      'slowapi',
      'django-ratelimit',
      'flask-limiter',
      'rack-attack',
      'golang.org/x/time',
      'github.com/ulule/limiter',
    ]
    if (limiters.some((l) => ctx.hasDependency(l))) return
    if (ctx.sourceFiles.some((f) => /rate.?limit|throttl/i.test(f.content ?? ''))) return
    return {
      title: `${authRoutes.length} authentication route${authRoutes.length === 1 ? '' : 's'} with no rate limiting`,
      detail: `Endpoints such as ${authRoutes
        .slice(0, 3)
        .map((r) => r.path)
        .join(
          ', ',
        )} can be called as fast as the network allows, which makes credential stuffing and password spraying cheap and leaves the door open to trivial denial of service.`,
      fix: 'Put a rate limiter in front of the auth routes keyed on IP *and* account — for example `express-rate-limit` with a strict window on login and password reset — and add exponential backoff or lockout after repeated failures.',
      evidence: evidenceFrom(
        ctx,
        authRoutes.slice(0, 5).map((r) => ({ path: r.file })),
      ),
      occurrences: authRoutes.length,
    }
  },
}

const unvalidatedInput: Rule = {
  id: 'security/unvalidated-request-body',
  category: 'security',
  severity: 'medium',
  confidence: 'possible',
  effort: 'moderate',
  run(ctx) {
    if (!ctx.isApplication || !ctx.sourceRoutes.length) return
    const validators = [
      'zod',
      'joi',
      'yup',
      'ajv',
      'class-validator',
      'express-validator',
      'valibot',
      'superstruct',
      'pydantic',
      'marshmallow',
      'cerberus',
      'voluptuous',
      'github.com/go-playground/validator',
      'FluentValidation',
    ]
    if (validators.some((v) => ctx.hasDependency(v))) return
    if (ctx.frameworks.has('FastAPI') || ctx.frameworks.has('NestJS')) return
    const bodyUsers = ctx.sourceFiles.filter((f) =>
      /req\.body|request\.json|request\.form|c\.Bind\(/.test(f.content ?? ''),
    )
    if (!bodyUsers.length) return
    return {
      title: 'Request bodies are read without a validation layer',
      detail:
        'Handlers read `req.body` directly and no validation library is present, so the shape and type of every field is whatever the caller sent. That turns into type errors deep in the stack at best, and mass-assignment or injection at worst.',
      fix: 'Define a schema per endpoint and parse at the boundary — zod, Joi or class-validator in Node, Pydantic models in Python — then hand the typed result to the handler. Reject anything that does not match with a 400 before business logic runs.',
      evidence: evidenceFrom(
        ctx,
        bodyUsers.slice(0, 5).map((f) => ({ path: f.path })),
      ),
      occurrences: bodyUsers.length,
    }
  },
}

export const securityRules: Rule[] = [
  sqlInjection,
  commandInjection,
  dynamicEvaluation,
  xss,
  tlsDisabled,
  weakCrypto,
  secretFallback,
  permissiveCors,
  debugEnabled,
  pathTraversal,
  missingHelmet,
  missingRateLimit,
  unvalidatedInput,
]
