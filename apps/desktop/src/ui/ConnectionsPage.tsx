// Wave 14: the Bitbots MCP. A Claude Code session (or another MCP client) started outside Bitbots can see
// and drive the bots through `bitbots-mcp.exe mcp-server`. The daemon owns the key and the endpoint file; this
// page only turns it on, picks the level and shows the command that connects a client. The key never reaches
// the UI.
import { useEffect, useState } from 'react'
import { Check, Copy, Eye, MessageSquare, ShieldAlert, Wrench } from 'lucide-react'
import { listenForDaemonEvents, rpc } from '../tauri'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
import { SettingsGroup, SettingsRow } from './SettingsParts'
import { clientLabel } from './messageOrigin'
import './blobPage.css'

export type ExternalTier = 'viewer' | 'chat' | 'operator'
export type ExternalStatus = {
  enabled: boolean
  tier: ExternalTier
  endpointPath: string | null
  bridgePath: string | null
  command: string | null
  lastCallAt: string | null
  lastClient: string | null
  /** Whether update_bot and create_bot may set a bot to Full access (owner's switch, off by default). */
  allowFullAccess: boolean
}

const TIERS: Array<{ value: ExternalTier; name: string; sentence: string; Icon: typeof Eye }> = [
  { value: 'viewer', name: 'View', sentence: 'Sees your bots, projects, conversations and how long turns take. Changes nothing.', Icon: Eye },
  { value: 'chat', name: 'Chat', sentence: 'Also messages, steers and stops bots, and starts conversations.', Icon: MessageSquare },
  { value: 'operator', name: 'Operator', sentence: 'Also creates and edits bots, answers approvals and starts work in a new git worktree.', Icon: Wrench },
]

const text = (value: unknown) => typeof value === 'string' && value ? value : null

/** Accepts only a well-formed status from the daemon. */
export function normalizeExternalStatus(raw: unknown): ExternalStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (typeof item.enabled !== 'boolean') return null
  const tier = TIERS.some((choice) => choice.value === item.tier) ? item.tier as ExternalTier : 'chat'
  return { enabled: item.enabled, tier, endpointPath: text(item.endpointPath), bridgePath: text(item.bridgePath), command: text(item.command), lastCallAt: text(item.lastCallAt), lastClient: text(item.lastClient), allowFullAccess: item.enabled && item.allowFullAccess === true }
}

/** "just now", "5 min ago", "3 h ago", or the date. */
export function usedAgo(at: string | null, now = Date.now()): string | null {
  if (!at) return null
  const time = new Date(at).getTime()
  if (Number.isNaN(time)) return null
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`
  return new Date(time).toLocaleDateString()
}

function TierChoices({ value, disabled, onPick }: { value: ExternalTier; disabled?: boolean; onPick: (tier: ExternalTier) => void }) {
  return <div className="approval-choices" role="radiogroup" aria-label="What outside sessions may do">
    {TIERS.map((choice) => <button
      key={choice.value}
      type="button"
      role="radio"
      aria-checked={value === choice.value}
      disabled={disabled}
      className={`approval-choice${value === choice.value ? ' on' : ''}${choice.value === 'operator' ? ' warning' : ''}`}
      onClick={() => onPick(choice.value)}
    >
      <span className="approval-choice-icon" aria-hidden="true"><choice.Icon size={16} /></span>
      <span className="approval-choice-copy">
        <span className="approval-choice-name">{choice.name}</span>
        <span className="approval-choice-sentence">{choice.sentence}</span>
      </span>
    </button>)}
  </div>
}

/** Settings › Connections: the Bitbots MCP switch, its level and the connect command. */
export function ConnectionsPage({ connected }: { connected: boolean }) {
  const [status, setStatus] = useState<ExternalStatus | null>(null)
  const [consent, setConsent] = useState<ExternalTier | null>(null)
  const [fullConsent, setFullConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!connected) return
    let active = true
    let off: (() => void) | null = null
    rpc<unknown>('external.status', {}).then((next) => { if (active) setStatus(normalizeExternalStatus(next)) }).catch(() => { if (active) setProblem('The connection settings could not be read.') })
    void listenForDaemonEvents((event) => {
      if (event.type !== 'external.changed') return
      const next = normalizeExternalStatus(event.payload)
      if (next) setStatus(next)
    }).then((unlisten) => { if (active) off = unlisten; else unlisten() })
    // Keeps "Last used" fresh while the page is open.
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 30_000)
    return () => { active = false; off?.(); window.clearInterval(timer) }
  }, [connected])
  const run = async (method: string, params: Record<string, unknown>, done?: string) => {
    setProblem(null); setNotice(null); setBusy(true)
    try {
      // The write methods answer with the status, either bare or as `{ status }`.
      const result = await rpc<unknown>(method, params)
      const next = normalizeExternalStatus((result as { status?: unknown } | null)?.status ?? result)
      if (next) setStatus(next)
      if (done) setNotice(done)
      return true
    } catch (reason) {
      setProblem(reason instanceof Error && reason.message ? reason.message : 'That could not be changed.')
      return false
    } finally { setBusy(false) }
  }
  const enable = async (tier: ExternalTier) => { if (await run('external.enable', { tier, confirm: true })) setConsent(null) }
  const allowFull = async () => { if (await run('external.setFullAccess', { allow: true, confirm: true }, 'Outside sessions can now give bots Full access.')) setFullConsent(false) }
  const copy = async () => {
    if (!status?.command) return
    try { await navigator.clipboard.writeText(status.command); setCopied(true); window.setTimeout(() => setCopied(false), 1600) } catch { setProblem('The command could not be copied. Select it and copy it yourself.') }
  }
  const on = !!status?.enabled
  const ago = usedAgo(status?.lastCallAt ?? null)
  return <>
    <p className="settings-intro">Let a Claude Code session in a terminal or editor see and work with your bots, through the Bitbots MCP. It uses its own key, never your coding agents’ sign-ins, and only while this is on.</p>
    <SettingsGroup title="Bitbots MCP">
      <SettingsRow label="Let outside sessions use Bitbots" hint="Sessions you connect can do what the level below allows. Turning this off cuts them off at once.">
        <button type="button" className={`toggle ${on ? 'on' : ''}`} role="switch" aria-label="Let outside sessions use Bitbots" aria-checked={on} disabled={!connected || busy || !status} onClick={() => on ? void run('external.disable', {}, 'Off. Connected sessions can no longer reach Bitbots.') : setConsent(status?.tier ?? 'chat')}><i /></button>
      </SettingsRow>
      {on && status && <>
        <SettingsRow stacked label="What they may do">
          <TierChoices value={status.tier} disabled={busy} onPick={(tier) => { if (tier !== status.tier) void run('external.setTier', { tier }) }} />
        </SettingsRow>
        {/* 30 October 2026: an Operator session may edit bots; giving one Full access stays behind this switch. */}
        {status.tier === 'operator' && <SettingsRow label="Let them give bots Full access" hint="A bot on Full access runs commands and edits files without asking you. Turning the MCP off turns this off too.">
          <button type="button" className={`toggle ${status.allowFullAccess ? 'on' : ''}`} role="switch" aria-label="Let outside sessions give bots Full access" aria-checked={status.allowFullAccess} disabled={busy} onClick={() => status.allowFullAccess ? void run('external.setFullAccess', { allow: false }, 'Outside sessions can no longer give bots Full access.') : setFullConsent(true)}><i /></button>
        </SettingsRow>}
        <SettingsRow stacked label="Connect Claude Code" detail={status.command ? 'Run this once in a terminal. Claude Code then lists Bitbots under /mcp.' : 'The connection program is still being prepared. Check again in a moment.'}>
          {status.command && <div className="connect-command">
            <code>{status.command}</code>
            <button type="button" className="ghost-button small" onClick={() => void copy()} aria-label="Copy the connect command">{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Copied' : 'Copy'}</button>
          </div>}
        </SettingsRow>
        <SettingsRow label="Last used" detail={ago ? `${ago}, by ${clientLabel(status.lastClient)}` : 'Not used yet'} />
        <SettingsRow label="Reset access" hint="Makes a new key. A connected session picks it up on its next call; anything holding the old key stops working.">
          <button type="button" className="secondary-button small" disabled={busy} onClick={() => void run('external.rotate', {}, 'Access reset. The old key no longer works.')}>Reset access</button>
        </SettingsRow>
      </>}
    </SettingsGroup>
    {notice && <p className="backup-done settings-row-note" role="status">{notice}</p>}
    {problem && <p className="memory-problem settings-row-note" role="alert">{problem}</p>}
    {consent && <ConnectConsentDialog tier={consent} busy={busy} onPick={setConsent} onCancel={() => setConsent(null)} onConfirm={() => void enable(consent)} />}
    {fullConsent && <FullAccessConsentDialog busy={busy} onCancel={() => setFullConsent(false)} onConfirm={() => void allowFull()} />}
  </>
}

function FullAccessConsentDialog({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const entered = useDialogEntered()
  const { ref, close } = useDialogAccessibility(onCancel, () => !busy)
  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog connect-consent full-access-consent" role="dialog" aria-modal="true" aria-labelledby="full-access-consent-title" tabIndex={-1}>
      <h2 id="full-access-consent-title"><ShieldAlert size={18} aria-hidden="true" />Let outside sessions give bots Full access?</h2>
      <p>A connected session such as Claude Code could then switch any unlocked bot to Full access, and that bot would run commands and edit files without asking you. Lock a bot to keep its settings as they are. Turning the MCP off turns this off too.</p>
      <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" data-dialog-initial-focus="" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="secondary-button danger-button" disabled={busy} onClick={onConfirm}>{busy ? 'Allowing…' : 'Allow Full access'}</button>
      </div>
    </section>
  </div>
}

function ConnectConsentDialog({ tier, busy, onPick, onCancel, onConfirm }: { tier: ExternalTier; busy: boolean; onPick: (tier: ExternalTier) => void; onCancel: () => void; onConfirm: () => void }) {
  const entered = useDialogEntered()
  const { ref, close } = useDialogAccessibility(onCancel, () => !busy)
  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog connect-consent" role="dialog" aria-modal="true" aria-labelledby="connect-consent-title" tabIndex={-1}>
      <h2 id="connect-consent-title">Let outside sessions use Bitbots?</h2>
      <p>Any MCP client you connect on this computer, such as Claude Code, can use your bots at the level you pick. Messages it sends show who sent them. It never gets your coding agents’ sign-ins or Bitbots’ own key, and it cannot reach Bitbots from another device.</p>
      <TierChoices value={tier} disabled={busy} onPick={onPick} />
      <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="primary-button" data-dialog-initial-focus="" disabled={busy} onClick={onConfirm}>{busy ? 'Turning on…' : 'Turn on'}</button>
      </div>
    </section>
  </div>
}
