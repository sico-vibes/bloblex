import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './ui/App'
import { DictationBubble } from './ui/DictationBubble'
import './ui/theme.css'
import './ui/styles.css'
import './ui/approval.css'
import './ui/accent.css'
import './ui/shell.css'
import './ui/density.css'
import './ui/skeleton.css'
import './ui/composer.css'
import './ui/usage.css'
import './ui/team.css'
import './ui/blobPage.css'
import './ui/companion.css'
import './ui/settings.css'
import './ui/polish.css'

const dictation = new URLSearchParams(window.location.search).has('dictation')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{dictation ? <DictationBubble /> : <App />}</React.StrictMode>,
)
