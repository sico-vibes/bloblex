// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../', import.meta.url))
const ENTRY = readFileSync(join(SRC, 'main.tsx'), 'utf8')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (!/\.(?:[cm]?[jt]sx?)$/.test(entry.name) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) return []
    return [path]
  })
}

describe('look stylesheet loading', () => {
  it('statically imports every selectable look from the entry point', () => {
    for (const path of [
      './ui/themes/frost.css',
      './ui/themes/haze.css',
    ]) expect(ENTRY).toMatch(new RegExp(`import\\s+['"]${path.replaceAll('.', '\\.')}['"]`))
  })

  it('does not dynamically import look stylesheets from application source', () => {
    const dynamicLookImport = /\bimport\s*\(\s*['"][^'"]*(?:ui\/themes\/|(?:\.\.\/|\.\/)?themes\/|bitbots\.css)/
    const offenders = sourceFiles(SRC).filter((path) => dynamicLookImport.test(readFileSync(path, 'utf8')))
    expect(offenders).toEqual([])
  })
})
