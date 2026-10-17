// FIX29 WP6c §3: `remoteTauri.ts` must export every name `tauri.ts` exports, so
// a component the phone shell imports still links, and a new desktop export
// cannot break the remote build silently.
//
// The check is static (it parses the two sources) rather than an import, because
// importing `tauri.ts` pulls in `@tauri-apps/*` and the whole desktop graph.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const TAURI = fileURLToPath(new URL('../tauri.ts', import.meta.url))
const REMOTE = fileURLToPath(new URL('./remoteTauri.ts', import.meta.url))

const DECLARATION = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g
const TYPE_DECLARATION = /export\s+type\s+([A-Za-z0-9_$]+)\s*=/g
const NAMED_EXPORTS = /export\s+(?:type\s+)?\{([^}]*)\}/g

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

const desktopExports = exportedNames(readFileSync(TAURI, 'utf8'))
const remoteSource = readFileSync(REMOTE, 'utf8')
const remoteExports = new Set(exportedNames(remoteSource))

describe('remoteTauri export parity with tauri.ts', () => {
  it('parsed a plausible export list from tauri.ts', () => {
    expect(desktopExports.length).toBeGreaterThan(60)
    for (const expected of ['rpc', 'fetchSnapshot', 'listenForDaemonEvents', 'inDesktop', 'previewMode', 'setCompanionMonitor', 'BackupStats', 'SpeechModelSummary']) {
      expect(desktopExports).toContain(expected)
    }
  })

  it('exports every name tauri.ts exports', () => {
    const missing = desktopExports.filter((name) => !remoteExports.has(name))
    expect(missing, `remoteTauri.ts is missing: ${missing.join(', ')}`).toEqual([])
  })

  it('imports nothing native', () => {
    const specifiers = [...remoteSource.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
    expect(specifiers.filter((specifier) => specifier.toLowerCase().includes('tauri'))).toEqual([])
  })

  it('reports itself as neither desktop nor preview', async () => {
    const remote = await import('./remoteTauri')
    expect(remote.inDesktop).toBe(false)
    expect(remote.previewMode).toBe(false)
  })

  it('answers the desktop-only calls with an error or an empty value', async () => {
    const remote = await import('./remoteTauri')
    await expect(remote.startDictation('model')).rejects.toThrow('Not available on a remote device.')
    expect(await remote.openProjectFolder()).toBeNull()
    expect(await remote.companionMonitorOptions()).toEqual([])
    expect(await remote.updatesGetState()).toBeNull()
  })
})
