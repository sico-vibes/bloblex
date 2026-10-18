// FIX37 G6: the browser preview aliases every `../tauri` import to
// `src/preview/fixtureBridge.ts` (see `vite.preview.config.ts`). If the desktop
// bridge grows an export a component imports and the fixture bridge does not,
// the preview page fails at module load with "does not provide an export named".
//
// This check is static (it parses the sources) rather than an import, because
// importing `fixtureBridge.ts` runs the whole fixture graph and needs a DOM.
//
// It must fail while a `../tauri` import has no fixture stand-in: before FIX37
// G6 the missing names were `BackupInclude`, `BackupStats`,
// `listenForUpdateState` and `updatesPhase`.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE_BRIDGE = fileURLToPath(new URL('./fixtureBridge.ts', import.meta.url))

/** Specifiers the preview config can alias back to the fixture bridge. */
const TAURI_SPECIFIERS = new Set(['../tauri', './tauri', '../../tauri'])

const DECLARATION = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g
const TYPE_DECLARATION = /export\s+type\s+([A-Za-z0-9_$]+)\s*=/g
const NAMED_EXPORTS = /export\s+(?:type\s+)?\{([^}]*)\}/g
const IMPORT_STATEMENT = /import\s+(?:type\s+)?(?:[A-Za-z0-9_$]+\s*,?\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g

/** Every name a module exports: values, types and re-exports. */
export function exportedNames(source: string): string[] {
  const names = new Set<string>()
  for (const match of source.matchAll(DECLARATION)) names.add(match[1])
  for (const match of source.matchAll(TYPE_DECLARATION)) names.add(match[1])
  for (const match of source.matchAll(NAMED_EXPORTS)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  return [...names].sort()
}

function isSkipped(name: string): boolean {
  return name.endsWith('.d.ts') || name.includes('.test.') || name.includes('.spec.')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name), out)
    else if (entry.isFile() && !isSkipped(entry.name)) out.push(join(dir, entry.name))
  }
  return out
}

/** Names imported from the aliased `tauri` specifier, source file by file. */
function tauriImports(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of walk(SRC)) {
    if (!/\.(ts|tsx)$/.test(file)) continue
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(IMPORT_STATEMENT)) {
      if (!TAURI_SPECIFIERS.has(match[2])) continue
      const names = match[1]
        .split(',')
        .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
        .filter(Boolean)
      if (!names.length) continue
      const key = relative(SRC, file).replace(/\\/g, '/')
      found.set(key, [...(found.get(key) ?? []), ...names])
    }
  }
  return found
}

const fixtureExports = new Set(exportedNames(readFileSync(FIXTURE_BRIDGE, 'utf8')))
const imports = tauriImports()

describe('fixtureBridge parity with the aliased ../tauri imports', () => {
  it('found tauri imports to check', () => {
    expect(imports.size).toBeGreaterThan(20)
    const all = new Set([...imports.values()].flat())
    for (const expected of ['rpc', 'previewMode', 'listenForDaemonEvents', 'updatesPhase']) {
      expect(all).toContain(expected)
    }
  })

  it('exports every name imported from ../tauri', () => {
    const missing: string[] = []
    for (const [file, names] of imports) {
      for (const name of names) {
        if (!fixtureExports.has(name)) missing.push(`${file}: ${name}`)
      }
    }
    expect(missing, `fixtureBridge.ts is missing stand-ins for:\n${missing.join('\n')}`).toEqual([])
  })
})
