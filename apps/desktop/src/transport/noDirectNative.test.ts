// Guards the transport seam: outside `src/transport/` (and the two legacy
// bridge modules), no UI file may import `@tauri-apps/*` directly.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set(['transport', 'preview'])
const SKIP_FILES = new Set(['tauri.ts', 'desktopIntegrations.ts'])

function isSkippedFile(file: string): boolean {
  if (SKIP_FILES.has(file)) return true
  if (file.endsWith('.d.ts')) return true
  return file.includes('.test.') || file.includes('.spec.')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out)
    } else if (entry.isFile() && !isSkippedFile(entry.name)) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

describe('no direct @tauri-apps imports', () => {
  it('keeps @tauri-apps behind the transport seam', () => {
    const offenders = walk(SRC)
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => readFileSync(file, 'utf8').includes('@tauri-apps/'))
      .map((file) => relative(SRC, file).replace(/\\/g, '/'))

    if (offenders.length) console.log('Files importing @tauri-apps directly:', offenders.join(', '))
    expect(offenders).toEqual([])
  })
})
