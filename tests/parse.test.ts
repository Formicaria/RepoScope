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
