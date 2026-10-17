// "Sign in again" / "Install" for a coding agent: opens a terminal running the
// agent's own sign-in or install command (a fixed table in the native shell;
// nothing typed here reaches the command), then lets the user say they are done
// so the app checks again.
import { useState } from 'react'
import { Download, LogIn, RefreshCw } from 'lucide-react'
import { rpc, runtimeTerminal } from '../tauri'
import { providerBrand } from './providerBrand'
import './signInHelp.css'

export type SignInProvider = 'claude' | 'codex' | 'opencode'

export function signInProvider(provider: string | null | undefined): SignInProvider | null {
  const key = String(provider ?? '').toLowerCase()
  return key === 'claude' || key === 'codex' || key === 'opencode' ? key : null
}

/** A runtime whose sign-in failed during a turn, or that discovery found signed out. */
export function needsSignIn(runtime: { authState?: string } | null | undefined): boolean {
  const state = String(runtime?.authState ?? '').toLowerCase()
  return state === 'sign_in_failed' || state === 'unauthenticated' || state === 'signed_out'
}

const messageOf = (reason: unknown) => reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'The terminal could not be opened.'

export function SignInHelp({ provider, runtimeId, mode = 'login', compact = false, onChecked }: {
  provider: string | null | undefined
  /** The runtime to clear and check again once the user has signed in. */
  runtimeId?: string | null
  mode?: 'login' | 'install'
  compact?: boolean
  onChecked?: () => void
}) {
  const key = signInProvider(provider)
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  if (!key) return null
  const name = providerBrand(key).name
  const open = async () => {
    setBusy(true)
    setProblem(null)
    try { await runtimeTerminal(key, mode); setOpened(true) } catch (reason) { setProblem(messageOf(reason)) } finally { setBusy(false) }
  }
  const check = async () => {
    setBusy(true)
    setProblem(null)
    try {
      if (runtimeId) await rpc('runtime.auth.clear', { runtimeId })
      else await rpc('runtime.refresh')
      onChecked?.()
    } catch (reason) { setProblem(messageOf(reason)) } finally { setBusy(false) }
  }
  return <div className={`sign-in-help${compact ? ' compact' : ''}`}>
    <div className="sign-in-help-actions">
      <button type="button" className={opened ? 'secondary-button small' : 'primary-button small'} disabled={busy} onClick={() => void open()}>
        {mode === 'install' ? <Download size={13} aria-hidden="true" /> : <LogIn size={13} aria-hidden="true" />}
        {mode === 'install' ? `Install ${name}` : opened ? 'Open the terminal again' : `Sign in to ${name}`}
      </button>
      {opened && <button type="button" className="primary-button small" disabled={busy} onClick={() => void check()}><RefreshCw size={13} aria-hidden="true" />{mode === 'install' ? 'Done — check again' : 'I’ve signed in — check again'}</button>}
    </div>
    {!compact && !opened && <small className="sign-in-help-note">{mode === 'install'
      ? `Opens a terminal that installs ${name}, then starts its sign-in.`
      : key === 'claude' ? 'Opens a terminal with Claude Code. Type /login there and follow the browser.' : `Opens a terminal running ${name}’s sign-in. Follow the browser, then come back.`}</small>}
    {problem && <small className="sign-in-help-problem" role="alert">{problem}</small>}
  </div>
}
