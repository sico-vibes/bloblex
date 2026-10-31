// Phase 5: Settings > Secrets, and the secure form when a bot asks for one. Values go to the Windows
// Credential Manager or a one-use file through the daemon. There is no way to read one back here.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { KeyRound, Trash2 } from 'lucide-react'
import { listenForDaemonEvents, rpc } from '../tauri'
import { ConfirmDialog } from './BlobPage'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
import { SettingsGroup } from './SettingsParts'
import { useEntityNoun } from './vocabulary'
import './accounts.css'

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : typeof reason === 'string' && reason ? reason : fallback

export type SecretRow = { name: string; updatedAt: string | null; usedBy: string[] }
export type SecretRequest = { id: string; sessionId: string; name: string; reason: string; botName: string; expiresAt: string | null }

/** Why this name can't be used, or null. The daemon checks again. */
export function secretNameProblem(name: string): string | null {
  if (!name) return 'Give it a name.'
  if (name.length > 64) return 'A name is at most 64 characters.'
  return /^[A-Za-z0-9_.-]+$/.test(name) ? null : 'Use letters, numbers, dots, dashes and underscores.'
}

export function SecretsPage() {
  const noun = useEntityNoun()
  const nouns = useEntityNoun({ plural: true })
  const [secrets, setSecrets] = useState<SecretRow[]>([])
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [removing, setRemoving] = useState<SecretRow | null>(null)
  const load = useCallback(() => { void rpc<{ secrets?: SecretRow[] }>('secret.list', {}).then((reply) => setSecrets(reply?.secrets ?? [])).catch(() => undefined) }, [])
  useEffect(load, [load])
  const nameProblem = name ? secretNameProblem(name) : null
  const replacing = secrets.some((item) => item.name === name)
  const save = async () => {
    setBusy(true); setProblem(null)
    try { await rpc('secret.set', { name, value, confirm: true }); setName(''); setValue(''); load() } catch (reason) { setProblem(messageOf(reason, 'That secret could not be saved.')) } finally { setBusy(false) }
  }
  return <>
    <p className="settings-intro">Keep environment values in the Windows Credential Manager instead of plain text. A {noun} gets one by name in its settings. This protects the value on disk. A coding agent can still read its own environment, so only give a secret to {nouns} you trust with it.</p>
    <SettingsGroup title="Secrets">
      {!secrets.length && <p className="settings-empty">No secrets yet.</p>}
      {secrets.map((secret) => <div key={secret.name} className="secret-row">
        <KeyRound size={14} aria-hidden="true" />
        <span className="account-row-copy"><strong>{secret.name}</strong><small>{secret.usedBy.length ? `Used by ${secret.usedBy.join(', ')}` : 'Not in use'}</small></span>
        <button type="button" className="icon-button" aria-label={`Delete ${secret.name}`} title="Delete" onClick={() => setRemoving(secret)}><Trash2 size={14} aria-hidden="true" /></button>
      </div>)}
      <form className="secret-form" autoComplete="off" onSubmit={(event) => { event.preventDefault(); if (name && value && !nameProblem) void save() }}>
        <input className="text-input" value={name} maxLength={64} spellCheck={false} placeholder="GITHUB_TOKEN" aria-label="Secret name" aria-invalid={!!nameProblem} onChange={(event) => setName(event.target.value)} />
        <input className="text-input" type="password" value={value} autoComplete="new-password" placeholder="Value" aria-label="Secret value" onChange={(event) => setValue(event.target.value)} />
        <button type="submit" className="secondary-button small" disabled={busy || !name || !value || !!nameProblem}>{replacing ? 'Replace' : 'Save'}</button>
      </form>
      {(nameProblem || problem) && <p className="new-project-error" role="alert">{nameProblem ?? problem}</p>}
    </SettingsGroup>
    {removing && <ConfirmDialog title={`Delete ${removing.name}?`} body="It's removed from the Windows Credential Manager, and it can't be read back." confirmLabel="Delete" cancelLabel="Keep it" tone="warning"
      onConfirm={() => { const target = removing; setRemoving(null); setProblem(null); void rpc('secret.delete', { name: target.name, confirm: true }).then(load).catch((reason) => setProblem(messageOf(reason, 'That secret could not be deleted.'))) }}
      onCancel={() => setRemoving(null)} />}
  </>
}

function SecretRequestDialog({ request, onDone }: { request: SecretRequest; onDone: () => void }) {
  const entered = useDialogEntered()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const { ref } = useDialogAccessibility(() => undefined, () => false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  const send = async (method: 'secret.request.answer' | 'secret.request.decline') => {
    setBusy(true); setProblem(null)
    try {
      await rpc(method, method === 'secret.request.answer' ? { id: request.id, value } : { id: request.id })
      setValue('')
      onDone()
    } catch (reason) { setProblem(messageOf(reason, 'That could not be done.')); setBusy(false) }
  }
  return createPortal(<div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <form ref={ref as unknown as React.RefObject<HTMLFormElement>} className="blob-dialog secret-request" role="dialog" aria-modal="true" aria-labelledby="secret-request-title" tabIndex={-1} autoComplete="off" onSubmit={(event) => { event.preventDefault(); if (value) void send('secret.request.answer') }}>
      <h2 id="secret-request-title">{request.botName} is asking for {request.name}</h2>
      <p className="secret-reason">{request.reason}</p>
      <label className="new-project-field"><span>{request.name}</span>
        <input ref={input} className="text-input" type="password" value={value} autoComplete="new-password" onChange={(event) => setValue(event.target.value)} />
        <small className="project-settings-note">For this turn only. It goes to a private file that's deleted when the turn ends, and it isn't saved in the conversation. {request.botName} can read it, so what happens to it after that is up to the bot.</small>
      </label>
      {problem && <p className="new-project-error" role="alert">{problem}</p>}
      <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void send('secret.request.decline')}>Decline</button>
        <button type="submit" className="primary-button" disabled={busy || !value}>Give it for this turn</button>
      </div>
    </form>
  </div>, document.body)
}

/** Mounted in the full app and the companion. Shows the oldest waiting request. */
export function SecretRequests({ active = true }: { active?: boolean }) {
  const [requests, setRequests] = useState<SecretRequest[]>([])
  const load = useCallback(() => { void rpc<{ requests?: SecretRequest[] }>('secret.request.list', {}).then((reply) => setRequests(reply?.requests ?? [])).catch(() => undefined) }, [])
  useEffect(() => {
    if (!active) return
    load()
    let live = true
    let stop: (() => void) | null = null
    void listenForDaemonEvents((event) => { if (event.type === 'secret.request.changed') load() }).then((unlisten) => { if (live) stop = unlisten; else unlisten() }).catch(() => undefined)
    return () => { live = false; stop?.() }
  }, [active, load])
  const first = requests[0]
  return first ? <SecretRequestDialog key={first.id} request={first} onDone={load} /> : null
}
