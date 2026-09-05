import { describe, expect, it } from 'vitest'
import { parseFile, parsingAvailable } from '../server/analyzer/parse.js'
import { matchAlias } from '../server/analyzer/imports.js'
import type { RepoFile } from '../shared/types.js'

const file = (path: string, content: string): RepoFile => ({
  path,
  size: content.length,
  content,
})

/**
 * These assert the behaviour that regular expressions cannot deliver. If the WebAssembly
 * grammars are unavailable the analyzer falls back to regexes on purpose, so the suite
 * skips rather than fails — `parsingAvailable()` reports which path ran.
 */
describe('syntax-tree import extraction', () => {
  it('reads multi-line, aliased and type-only imports', async () => {
    const parsed = await parseFile(
      file(
        'src/a.ts',
        `import React from 'react'
import type { Config } from './config'
import {
  alpha,
  beta as gamma,
} from '../shared/values'
export * from './re-exported'
const legacy = require('./legacy')
const lazy = await import('./lazy')
`,
      ),
    )
    if (!parsed) {
      expect(parsingAvailable()).toBe(false)
      return
    }
    const bySpec = Object.fromEntries(parsed.imports.map((i) => [i.specifier, i]))
    expect(Object.keys(bySpec).sort()).toEqual([
      '../shared/values',
      './config',
      './lazy',
      './legacy',
      './re-exported',
      'react',
    ])
    // The multi-line list is one statement with both names — a line-oriented regex misses it.
    expect(bySpec['../shared/values'].symbols.sort()).toEqual(['alpha', 'beta'])
    expect(bySpec['./config'].typeOnly).toBe(true)
    expect(bySpec['react'].typeOnly).toBe(false)
    expect(bySpec['./re-exported'].kind).toBe('reexport')
    expect(bySpec['./legacy'].kind).toBe('require')
    expect(bySpec['./lazy'].kind).toBe('dynamic')
  })

  it('ignores imports inside comments, strings and template literals', async () => {
    const parsed = await parseFile(
      file(
        'src/b.ts',
        `// import { fake } from './commented-out'
/* import real from "./block-comment" */
const sample = \`import { x } from './inside-a-template'\`
const generated = 'require("./inside-a-string")'
import { actual } from './real'
`,
      ),
    )
    if (!parsed) return
    expect(parsed.imports.map((i) => i.specifier)).toEqual(['./real'])
  })

  it('resolves the shape of Python imports, including relative ones', async () => {
    const parsed = await parseFile(
      file(
        'app/main.py',
        `import os
import app.core.config
from . import siblings
from .models import User, Post
from ..deep import thing as aliased
from typing import (
    Any,
    Optional,
)
`,
      ),
    )
    if (!parsed) return
    const specs = parsed.imports.map((i) => i.specifier)
    expect(specs).toContain('os')
    expect(specs).toContain('app.core.config')
    expect(specs).toContain('.')
    expect(specs).toContain('.models')
    expect(specs).toContain('..deep')
    const dot = parsed.imports.find((i) => i.specifier === '.')!
    // `from . import siblings` names a module; without the symbol it cannot be resolved.
    expect(dot.symbols).toEqual(['siblings'])
    expect(parsed.imports.find((i) => i.specifier === '.models')!.symbols).toEqual(['User', 'Post'])
    expect(parsed.imports.find((i) => i.specifier === 'typing')!.symbols).toEqual([
      'Any',
      'Optional',
    ])
  })

  it('reads the declared package of JVM files, which makes internal imports resolvable', async () => {
    const parsed = await parseFile(
      file(
        'src/main/java/com/acme/api/UserController.java',
        `package com.acme.api;

import com.acme.domain.UserService;
import java.util.List;

public class UserController {}
`,
      ),
    )
    if (!parsed) return
    expect(parsed.packageName).toBe('com.acme.api')
    expect(parsed.imports.map((i) => i.specifier)).toContain('com.acme.domain.UserService')
  })

  it('reads Go import blocks and C# namespaces', async () => {
    const go = await parseFile(
      file(
        'cmd/server/main.go',
        `package main

import (
	"fmt"
	svc "github.com/acme/app/internal/service"
)
`,
      ),
    )
    if (go)
      expect(go.imports.map((i) => i.specifier).sort()).toEqual([
        'fmt',
        'github.com/acme/app/internal/service',
      ])

    const cs = await parseFile(
      file('src/Api/Controller.cs', `namespace Acme.Api;\n\nusing Acme.Domain;\n`),
    )
    if (cs) {
      expect(cs.packageName).toBe('Acme.Api')
      expect(cs.imports.map((i) => i.specifier)).toContain('Acme.Domain')
    }
  })

  it('leaves files it has no grammar for to the regex fallback', async () => {
    expect(await parseFile(file('a.txt', 'hello'))).toBeUndefined()
    expect(await parseFile(file('a.ts', ''))).toBeUndefined()
  })
})

describe('alias patterns', () => {
  it('matches tsconfig-style patterns, including a wildcard in the middle of the target', () => {
    expect(matchAlias('@vue/*', '@vue/shared')).toBe('shared')
    expect(matchAlias('@/*', '@/components/Button')).toBe('components/Button')
    expect(matchAlias('$lib', '$lib')).toBe('')
    expect(matchAlias('@app/*', '@other/thing')).toBeUndefined()
    expect(matchAlias('exact', 'exact')).toBe('')
    expect(matchAlias('exact', 'exactly')).toBeUndefined()
    // A pattern with a suffix, as used by "components/*.vue" style mappings.
    expect(matchAlias('parts/*.vue', 'parts/Button.vue')).toBe('Button')
  })
})

/**
 * A grammar whose node names RepoScope does not know extracts nothing, and the review then
 * reports a clean result for that language — worse than declining to support it. This matrix
 * asserts that every language the parser claims actually yields the facts the rules read.
 */
describe('structural extraction across languages', () => {
  const SAMPLES: { path: string; source: string; expectCatch: boolean }[] = [
    {
      path: 'a.ts',
      source:
        'export function go(a: string, b: string) {\n  try {\n    db.query("x")\n  } catch (e) {}\n}',
      expectCatch: true,
    },
    {
      path: 'a.tsx',
      source:
        'export function Go() {\n  try {\n    db.query("x")\n  } catch (e) {}\n  return <div />\n}',
      expectCatch: true,
    },
    {
      path: 'a.py',
      source:
        'def go(a, b):\n    """Doc."""\n    try:\n        db.execute("x")\n    except Exception:\n        pass',
      expectCatch: true,
    },
    {
      path: 'a.go',
      source: 'package m\n\nfunc Go(a string) {\n\tdb.Query("x")\n}',
      expectCatch: false,
    },
    { path: 'a.rs', source: 'pub fn go(a: &str) {\n    db.query("x");\n}', expectCatch: false },
    {
      path: 'a.cs',
      source:
        'class C {\n  public void Go(int a) {\n    try { db.Query("x"); } catch (Exception e) {}\n  }\n}',
      expectCatch: true,
    },
    {
      path: 'a.java',
      source:
        'class C {\n  public void go(int a) {\n    try { db.query("x"); } catch (Exception e) {}\n  }\n}',
      expectCatch: true,
    },
    {
      path: 'a.kt',
      source: 'fun go(a: Int) {\n  try { db.query("x") } catch (e: Exception) {}\n}',
      expectCatch: true,
    },
    { path: 'a.rb', source: 'def go(a)\n  db.query("x")\nrescue => e\nend', expectCatch: true },
    {
      path: 'a.php',
      source: '<?php\nfunction go($a) {\n  try { $db->query("x"); } catch (Exception $e) {}\n}',
      expectCatch: true,
    },
  ]

  for (const sample of SAMPLES) {
    it(`extracts functions and call sites from ${sample.path}`, async () => {
      const parsed = await parseFile(file(sample.path, sample.source), { structure: true })
      if (!parsed) {
        expect(parsingAvailable()).toBe(false)
        return
      }
      const s = parsed.structure
      expect(s).toBeDefined()
      // Without these, the oversized-function and injection rules do nothing for this language.
      expect(s!.functions.length, 'functions').toBeGreaterThan(0)
      expect(s!.functions[0].name).toMatch(/^[Gg]o$/)
      expect(s!.calls.length, 'call sites').toBeGreaterThan(0)
      expect(s!.calls.some((c) => /query|execute/i.test(c.name))).toBe(true)
      if (sample.expectCatch) expect(s!.catches.length, 'catch blocks').toBeGreaterThan(0)
    })
  }

  it('measures function size, parameters and nesting', async () => {
    const parsed = await parseFile(
      file(
        'deep.ts',
        'export function go(a: number, b: number, c: number) {\n' +
          '  if (a) {\n    if (b) {\n      for (const x of []) {\n        while (c) {\n          work()\n        }\n      }\n    }\n  }\n}',
      ),
      { structure: true },
    )
    if (!parsed?.structure) return
    const fn = parsed.structure.functions[0]
    expect(fn.params).toBe(3)
    expect(fn.lines).toBe(11)
    expect(fn.maxNesting).toBeGreaterThanOrEqual(4)
  })

  it('tells an empty catch from one that rethrows', async () => {
    const parsed = await parseFile(
      file(
        'c.ts',
        'function a() { try { x() } catch (e) {} }\n' +
          'function b() { try { x() } catch (e) { console.error(e) } }\n' +
          'function c() { try { x() } catch (e) { logger.warn(e); throw e } }',
      ),
      { structure: true },
    )
    if (!parsed?.structure) return
    const [empty, logs, rethrows] = parsed.structure.catches
    expect(empty.isEmpty).toBe(true)
    expect(logs.isEmpty).toBe(false)
    expect(logs.swallows).toBe(true)
    expect(rethrows.swallows).toBe(false)
  })
})
