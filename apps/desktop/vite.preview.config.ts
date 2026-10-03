import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Browser preview with fixture data: `npx vite --config vite.preview.config.ts`,
// then open / (main window), /?companion (companion) or /preview.html (character sheet).
const fixture = (file: string) => fileURLToPath(new URL(`./src/preview/${file}`, import.meta.url))

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: [
      { find: /^\.\.\/tauri$/, replacement: fixture('fixtureBridge.ts') },
      { find: /^\.\.\/desktopIntegrations$/, replacement: fixture('fixtureDesktopIntegrations.ts') },
      { find: /^@tauri-apps\/api\/(event|window)$/, replacement: fixture('fixtureTauriApi.ts') },
    ],
  },
})
