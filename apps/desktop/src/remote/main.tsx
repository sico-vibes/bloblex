import React from 'react'
import ReactDOM from 'react-dom/client'
import '../ui/theme.css'
import '../ui/styles.css'
import '../ui/accent.css'
import '../ui/polish.css'
import './remote.css'
import { RemoteApp } from './RemoteApp'
import { previewMode } from '../tauri'
import { remoteDevice } from './remoteTauri'
import { registerRemoteServiceWorker } from './serviceWorker'

// The theme handshake used to be an inline script in `remote.html`; the host
// serves a strict `script-src 'self'`, so it lives here (spec §4, CSP note).
try {
  const light = matchMedia('(prefers-color-scheme: light)').matches
  document.documentElement.dataset.theme = light ? 'light' : 'dark'
} catch { /* default dark */ }

registerRemoteServiceWorker()

export { applyUpdate, onUpdateReady, updateIsReady } from './serviceWorker'

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><RemoteApp device={previewMode ? undefined : remoteDevice} /></React.StrictMode>)
