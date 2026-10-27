// The remote PWA build: `npx vite build --config vite.remote.config.ts`
// (or `npm run build:remote`). Input `remote.html`, output `dist-remote/`, which
// the desktop installer ships as the Tauri resource `remote-web/` and the daemon
// serves from `BITBOTS_REMOTE_WEB_DIR` (FIX29 WP6b).
//
// Two things this config must guarantee:
//   1. nothing from `@tauri-apps` (or a `__TAURI` global) reaches the bundle —
//      the UI's `../tauri` seam is aliased to the remote transport, and every
//      native module is aliased to a stub;
//   2. the service worker at `/remote-sw.js` carries a build-time precache list
//      and a version hash of that list.
//
// The main `npm run build` and `vite.preview.config.ts` are untouched.

import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite'
import react from '@vitejs/plugin-react'

const remote = (file: string) => fileURLToPath(new URL(`./src/remote/${file}`, import.meta.url))

const REMOTE_SW_FILE = 'remote-sw.js'

function versionOf(files: string[]): string {
  return createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 16)
}

/** Every file in the public dir, as the URLs it is copied to. */
function listPublicFiles(dir: string): string[] {
  const files: string[] = []
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(current, entry.name), relative)
      else files.push(`/${relative}`)
    }
  }
  try {
    walk(dir, '')
  } catch {
    // No public dir: nothing to add.
  }
  return files
}

/**
 * Replaces the service worker's two build-time literals with the precache list
 * and a hash of that list. The list is every emitted file plus `/remote.html`,
 * the manifest and the icons — the last three arrive through `publicDir`, which
 * rollup never sees, so they are read from disk here. Fails the build if a
 * placeholder survives.
 */
function remoteServiceWorkerManifest(): Plugin {
  let publicDir = ''
  return {
    name: 'bitbots:remote-sw-manifest',
    apply: 'build',
    enforce: 'post',
    configResolved(config: ResolvedConfig) {
      publicDir = config.publicDir
    },
    generateBundle(_options, bundle) {
      const chunk = bundle[REMOTE_SW_FILE]
      if (!chunk || chunk.type !== 'chunk') return
      if (chunk.imports.length > 0 || chunk.dynamicImports.length > 0) {
        this.error('remote service worker: the worker is registered as a classic script, so its chunk must not import anything')
      }
      const precache = [...Object.keys(bundle).filter((name) => !name.endsWith('.map')), ...listPublicFiles(publicDir)]
        .map((name) => (name.startsWith('/') ? name : `/${name}`))
        .concat('/remote.html')
        .filter((name, index, all) => all.indexOf(name) === index && name !== `/${REMOTE_SW_FILE}`)
        .sort()
      const version = versionOf(precache)
      chunk.code = chunk.code
        .replace(/["']__SW_PRECACHE__["']/, JSON.stringify(precache))
        .replace(/["']__SW_VERSION__["']/, JSON.stringify(version))
      if (chunk.code.includes('__SW_PRECACHE__') || chunk.code.includes('__SW_VERSION__')) {
        this.error('remote service worker: the precache/version placeholders were not replaced')
      }
    },
  }
}

/** Fails the build when any native Tauri marker survives into the output. */
function forbidNativeMarkers(): Plugin {
  const FORBIDDEN = ['@tauri-apps', '__TAURI', '__TAURI_INTERNALS__']
  return {
    name: 'bitbots:remote-forbid-native',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const [name, output] of Object.entries(bundle)) {
        if (name.endsWith('.map')) continue
        const code = output.type === 'chunk' ? output.code : output.source
        const text = typeof code === 'string' ? code : new TextDecoder().decode(code)
        for (const marker of FORBIDDEN) {
          if (text.includes(marker)) this.error(`remote build: "${marker}" reached ${name}; the remote bundle must not carry native Tauri code`)
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), remoteServiceWorkerManifest(), forbidNativeMarkers()],
  clearScreen: false,
  base: '/',
  publicDir: 'remote-public',
  build: {
    outDir: 'dist-remote',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        remote: fileURLToPath(new URL('./remote.html', import.meta.url)),
        [REMOTE_SW_FILE]: remote('sw/remoteSw.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === REMOTE_SW_FILE ? REMOTE_SW_FILE : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  resolve: {
    alias: [
      { find: /^\.\.\/tauri$/, replacement: remote('remoteTauri.ts') },
      { find: /^\.\.\/desktopIntegrations$/, replacement: remote('remoteDesktopIntegrations.ts') },
      { find: /^\.\/PdfViewer$/, replacement: remote('remotePdfViewer.tsx') },
      { find: /^@tauri-apps\/api\/(event|window|core|webviewWindow)$/, replacement: remote('remoteTauriAppsStub.ts') },
      { find: /^@tauri-apps\/plugin-.*$/, replacement: remote('remoteTauriAppsStub.ts') },
    ],
  },
})
