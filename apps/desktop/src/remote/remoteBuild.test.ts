// FIX29 WP6c §1 and §5: the shipped `dist-remote` artifact. This runs the real
// build (`npm run build:remote`) and inspects its output, so a change that
// silently drops the worker, the manifest, the icons or the PWA's "no native
// code" promise fails here as well as in the build itself.

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const DESKTOP_DIR = fileURLToPath(new URL('../../', import.meta.url))
const DIST = join(DESKTOP_DIR, 'dist-remote')
const BUILD_TIMEOUT = 300_000

function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else files.push(full)
  }
  return files
}

/** PNG IHDR width/height, read straight from the bytes. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file)
  const signature = bytes.subarray(0, 8).toString('latin1')
  expect(signature, `${file} is not a PNG`).toBe('\x89PNG\r\n\x1a\n')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

beforeAll(() => {
  execSync('npm run build:remote', { cwd: DESKTOP_DIR, stdio: 'pipe' })
  expect(existsSync(DIST)).toBe(true)
}, BUILD_TIMEOUT)

describe('remote build output', () => {
  it('emits the shell, the worker, the manifest and the icons', () => {
    for (const file of ['remote.html', 'remote-sw.js', 'remote.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png', 'icons/apple-touch-icon-180.png']) {
      expect(existsSync(join(DIST, file)), `missing dist-remote/${file}`).toBe(true)
    }
  })

  it('emits hashed asset names', () => {
    const assets = readdirSync(join(DIST, 'assets'))
    expect(assets.some((name) => /-[A-Za-z0-9_]{5,}\.js$/.test(name))).toBe(true)
    expect(assets.some((name) => /-[A-Za-z0-9_]{5,}\.css$/.test(name))).toBe(true)
  })

  it('has no @tauri-apps code and no __TAURI marker anywhere', () => {
    const offenders: string[] = []
    for (const file of walk(DIST)) {
      if (!/\.(js|html|webmanifest|json)$/.test(file)) continue
      const text = readFileSync(file, 'utf8')
      for (const marker of ['@tauri-apps', '__TAURI']) {
        if (text.includes(marker)) offenders.push(`${relative(DIST, file)} contains ${marker}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('injects a precache list and a version hash into the worker', () => {
    const worker = readFileSync(join(DIST, 'remote-sw.js'), 'utf8')
    expect(worker).not.toContain('__SW_PRECACHE__')
    expect(worker).not.toContain('__SW_VERSION__')
    expect(worker).toContain('/remote.html')
    expect(worker).toContain('/remote.webmanifest')
    expect(worker).toContain('/icons/icon-192.png')
    expect(worker).toContain('bitbots-remote-')
    const precache = /\[(?:"\/[^"]*",?)+\]/.exec(worker)?.[0] ?? ''
    expect(precache.length).toBeGreaterThan(0)
    expect(precache.split(',').length).toBeGreaterThan(10)
    expect(worker).not.toMatch(/\bimport\s*[({"']/)
  })

  it('ships the PWA icons at the sizes the manifest declares', () => {
    expect(pngSize(join(DIST, 'icons/icon-192.png'))).toEqual({ width: 192, height: 192 })
    expect(pngSize(join(DIST, 'icons/icon-512.png'))).toEqual({ width: 512, height: 512 })
    expect(pngSize(join(DIST, 'icons/icon-512-maskable.png'))).toEqual({ width: 512, height: 512 })
    expect(pngSize(join(DIST, 'icons/apple-touch-icon-180.png'))).toEqual({ width: 180, height: 180 })
    const manifest = JSON.parse(readFileSync(join(DIST, 'remote.webmanifest'), 'utf8')) as { icons: Array<{ src: string; sizes: string; purpose: string }> }
    for (const icon of manifest.icons) {
      expect(existsSync(join(DIST, icon.src.replace(/^\//, ''))), `manifest icon missing: ${icon.src}`).toBe(true)
    }
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true)
  })

  it('has no inline script in remote.html', () => {
    const html = readFileSync(join(DIST, 'remote.html'), 'utf8')
    expect(html).toContain('/remote.webmanifest')
    expect(html).toContain('/icons/apple-touch-icon-180.png')
    expect(/<script(?![^>]*\bsrc=)/i.test(html)).toBe(false)
  })

  it('is small enough to precache on a phone', () => {
    const total = walk(DIST).reduce((sum, file) => sum + statSync(file).size, 0)
    // The shell today is comfortably under 1 MB; a jump means something got
    // dragged into the phone bundle that should not be there.
    expect(total).toBeLessThan(1_500_000)
  })
})
