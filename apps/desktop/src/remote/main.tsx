import React from 'react'
import ReactDOM from 'react-dom/client'
import '../ui/theme.css'
import '../ui/styles.css'
import '../ui/accent.css'
import '../ui/polish.css'
import './remote.css'
import { RemoteApp } from './RemoteApp'

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  // The worker is a stub (network only); registration proves the PWA wiring.
  navigator.serviceWorker.register('/remote-sw.js').catch(() => undefined)
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><RemoteApp /></React.StrictMode>)
