// Wave 13: the companion watches Claude Code sessions the owner started outside Bitbots (in a terminal or an
// editor). The daemon owns everything: it shows the exact change to Claude Code's settings, backs the file up,
// adds or removes only its own hook entries, and reports each session's folder name, tool and state. Prompts,
// messages and tool inputs are never sent here.
import { useEffect, useState } from 'react'
import { listenForDaemonEvents, rpc } from '../tauri'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
import { SettingsRow } from './SettingsParts'
import { ProviderLogo } from './providerBrand'

export type OutsideSession = { id: string; provider: string; folder: string; state: 'idle' | 'working' | 'waiting' | 'done'; tool: string | null; updatedAt: string }
type OutsideStatus = { enabled: boolean; installed: boolean; settingsPath: string | null; bridgeAvailable: boolean; problem: string | null }
type OutsidePreview = { settingsPath: string; exists: boolean; before: string; after: string }

const STATES = ['idle', 'working', 'waiting', 'done'] as const

/** Accepts only well-formed rows from the daemon. */
export function normalizeOutsideSessions(raw: unknown): OutsideSession[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const value = item as Record<string, unknown>
    if (typeof value.id !== 'string' || !STATES.includes(value.state as OutsideSession['state'])) return []
    return [{ id: value.id, provider: typeof value.provider === 'string' ? value.provider : 'claude', folder: typeof value.folder === 'string' ? value.folder : '', state: value.state as OutsideSession['state'], tool: typeof value.tool === 'string' ? value.tool : null, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '' }]
  })
}

/** What a session is doing, in a few words. */
export function outsideLabel(session: OutsideSession): string {
  if (session.state === 'waiting') return 'Needs you in the terminal'
  if (session.state === 'done') return 'Done'
  if (session.state === 'idle') return 'Idle'
  const tool = (session.tool ?? '').toLowerCase()
  if (tool === 'bash' || tool === 'powershell') return 'Running a command'
  if (['edit', 'write', 'multiedit', 'notebookedit'].includes(tool)) return 'Editing files'
  if (['read', 'grep', 'glob', 'ls'].includes(tool)) return 'Reading files'
  if (tool === 'webfetch' || tool === 'websearch') return 'Searching the web'
  return 'Working'
}

/** The watched sessions, kept current from `outside.sessions.changed`. Empty when watching is off. */
export function useOutsideSessions(connected: boolean): OutsideSession[] {
  const [sessions, setSessions] = useState<OutsideSession[]>([])
  useEffect(() => {
    if (!connected) { setSessions([]); return }
    let active = true
    let off: (() => void) | null = null
    rpc<{ sessions?: unknown }>('outside.sessions', {}).then((result) => { if (active) setSessions(normalizeOutsideSessions(result.sessions)) }).catch(() => undefined)
    void listenForDaemonEvents((event) => {
      if (event.type !== 'outside.sessions.changed') return
      setSessions(normalizeOutsideSessions((event.payload as { sessions?: unknown } | undefined)?.sessions))
    }).then((unlisten) => { if (active) off = unlisten; else unlisten() })
    return () => { active = false; off?.() }
  }, [connected])
  return sessions
}

/** One pill per outside session, for the companion. Nothing when there are none. */
export function OutsideSessionPills({ sessions }: { sessions: readonly OutsideSession[] }) {
  if (!sessions.length) return null
  return <section className="outside-sessions" aria-label="Outside Bitbots">
    <span className="outside-sessions-title">Outside Bitbots</span>
    <ul>{sessions.map((session) => <li key={session.id} className={`outside-pill ${session.state}`} title={`Claude Code in ${session.folder || 'a folder'}`}>
      <ProviderLogo provider={session.provider} size={13} />
      <b>{session.folder || 'Claude Code'}</b>
      <span className="outside-pill-state">{outsideLabel(session)}</span>
    </li>)}</ul>
  </section>
}

/** The opt-in switch in Settings. Turning it on first shows exactly what changes in Claude Code's settings. */
export function OutsideWatchSetting({ connected }: { connected: boolean }) {
  const [status, setStatus] = useState<OutsideStatus | null>(null)
  const [preview, setPreview] = useState<OutsidePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    if (!connected) return
    let active = true
    rpc<OutsideStatus>('outside.status', {}).then((next) => { if (active) setStatus(next) }).catch(() => undefined)
    return () => { active = false }
  }, [connected])
  const failed = (reason: unknown) => setProblem(reason instanceof Error && reason.message ? reason.message : 'Claude Code’s settings could not be changed.')
  const ask = async () => {
    setProblem(null); setNotice(null); setBusy(true)
    try { setPreview(await rpc<OutsidePreview>('outside.preview', {})) } catch (reason) { failed(reason) } finally { setBusy(false) }
  }
  const enable = async () => {
    setBusy(true)
    try {
      const result = await rpc<{ status: OutsideStatus; backupPath: string | null }>('outside.enable', { confirm: true })
      setStatus(result.status); setPreview(null)
      setNotice(result.backupPath ? `On. The original settings were saved to ${result.backupPath}.` : 'On.')
    } catch (reason) { setPreview(null); failed(reason) } finally { setBusy(false) }
  }
  const disable = async () => {
    setProblem(null); setNotice(null); setBusy(true)
    try {
      const result = await rpc<{ status: OutsideStatus; problem: string | null }>('outside.disable', {})
      setStatus(result.status)
      setNotice(result.problem ? `Off. ${result.problem}` : 'Off. Bitbots’ hooks were removed from Claude Code’s settings.')
    } catch (reason) { failed(reason) } finally { setBusy(false) }
  }
  const on = !!status?.enabled
  return <>
    <SettingsRow label="Watch Claude Code outside Bitbots" hint="Shows sessions you start in a terminal or editor in the companion: the folder and what they are doing, never what you typed.">
      <button type="button" className={`toggle ${on ? 'on' : ''}`} role="switch" aria-label="Watch Claude Code outside Bitbots" aria-checked={on} disabled={!connected || busy || !status || (!on && !status.bridgeAvailable)} onClick={() => void (on ? disable() : ask())}><i /></button>
    </SettingsRow>
    {status?.problem && <p className="memory-problem settings-row-note" role="alert">{status.problem}</p>}
    {status && !status.bridgeAvailable && !on && <p className="blob-muted settings-row-note">The hook bridge is not installed beside Bitbots, so this is not available here.</p>}
    {notice && <p className="backup-done settings-row-note" role="status">{notice}</p>}
    {problem && <p className="memory-problem settings-row-note" role="alert">{problem}</p>}
    {preview && <OutsideConsentDialog preview={preview} busy={busy} onCancel={() => setPreview(null)} onConfirm={() => void enable()} />}
  </>
}

function OutsideConsentDialog({ preview, busy, onCancel, onConfirm }: { preview: OutsidePreview; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const entered = useDialogEntered()
  const { ref, close } = useDialogAccessibility(onCancel, () => !busy)
  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog outside-consent" role="dialog" aria-modal="true" aria-labelledby="outside-consent-title" tabIndex={-1}>
      <h2 id="outside-consent-title">Change Claude Code’s settings?</h2>
      <p>Bitbots adds its own hook entries to <code>{preview.settingsPath}</code>, so Claude Code tells the companion when a session you started yourself is working, needs you or is done. {preview.exists ? 'A copy of the current file is saved next to it first. ' : ''}Your other settings and hooks stay, and turning this off removes only Bitbots’ entries.</p>
      <details className="outside-consent-file"><summary>Show the new file</summary><pre>{preview.after}</pre></details>
      <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="primary-button" data-dialog-initial-focus="" disabled={busy} onClick={onConfirm}>{busy ? 'Turning on…' : 'Turn on'}</button>
      </div>
    </section>
  </div>
}
