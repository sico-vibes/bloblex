import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './ui/App'
import './ui/theme.css'
import './ui/styles.css'
import './ui/shell.css'
import './ui/blobPage.css'
import './ui/companion.css'
import './ui/settings.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
)
