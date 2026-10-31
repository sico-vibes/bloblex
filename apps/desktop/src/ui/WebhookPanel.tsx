// Phase 6: start a schedule from a signed request. The secret is shown once, when it's made,
// and only the desktop can turn a webhook on. The daemon checks every request.
import { useState } from 'react'
import { Check, Copy, Webhook } from 'lucide-react'
import { rpc } from '../tauri'
import { ConfirmDialog } from './BlobPage'
import './accounts.css'

export type WebhookState = { enabled: boolean; includeBody: boolean; url?: string | null }
type Reply = { url?: string | null; secret?: string; webhook?: WebhookState }

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : typeof reason === 'string' && reason ? reason : fallback

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return <div className="webhook-line">
    <span>{label}</span>
    <code>{value}</code>
    <button type="button" className="icon-button" aria-label={`Copy the ${label.toLowerCase()}`} title="Copy" onClick={() => { void navigator.clipboard.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }).catch(() => undefined) }}>{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}</button>
  </div>
}

export function WebhookPanel({ automationId, name, webhook, onChanged }: { automationId: string; name: string; webhook?: WebhookState | null; onChanged: () => void }) {
  const [state, setState] = useState<WebhookState>(webhook ?? { enabled: false, includeBody: false })
  const [secret, setSecret] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(webhook?.url ?? null)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<'enable' | 'rotate' | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const call = async (method: string, params: Record<string, unknown>) => {
    setBusy(true); setProblem(null)
    try {
      const reply = await rpc<Reply>(method, { id: automationId, ...params })
      if (reply.webhook) setState(reply.webhook)
      if (reply.secret) setSecret(reply.secret)
      if (reply.url !== undefined) setUrl(reply.url ?? null)
      onChanged()
    } catch (reason) { setProblem(messageOf(reason, 'That could not be done.')) } finally { setBusy(false) }
  }
  return <div className="webhook-panel">
    <button type="button" className="queue-link webhook-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Webhook size={12} aria-hidden="true" />{state.enabled ? 'Webhook on' : 'Start from a webhook'}</button>
    {open && <div className="webhook-body">
      {!state.enabled && <>
        <p>Anything holding a signing secret can start this schedule, within its own limits. Remote must be on, and a Direct address is on the public internet.</p>
        <button type="button" className="secondary-button small" disabled={busy} onClick={() => setConfirm('enable')}>Turn on</button>
      </>}
      {state.enabled && <>
        {url ? <CopyLine label="Address" value={url} /> : <p>Turn Remote on to get an address for this webhook.</p>}
        {secret
          ? <div role="status"><CopyLine label="Secret" value={secret} /><small className="project-settings-note">Copy this now. It won't be shown again. Sign each request with HMAC-SHA-256 over <code>timestamp.body</code>, in <code>X-Bitbots-Timestamp</code> and <code>X-Bitbots-Signature: sha256=…</code>.</small></div>
          : <small className="project-settings-note">The secret was shown when it was made. Rotate it if you've lost it, and senders using the old one stop working.</small>}
        <label className="new-project-check"><input type="checkbox" checked={state.includeBody} disabled={busy} onChange={(event) => void call('automation.webhook.update', { includeBody: event.target.checked })} /><span>Give the bot the request's body, as data. Whoever sends it chooses what it says, so leave this off unless you need it.</span></label>
        <div className="webhook-actions">
          <button type="button" className="secondary-button small" disabled={busy} onClick={() => setConfirm('rotate')}>Rotate the secret</button>
          <button type="button" className="ghost-button small" disabled={busy} onClick={() => { setSecret(null); void call('automation.webhook.disable', {}) }}>Turn off</button>
        </div>
      </>}
      {problem && <p className="new-project-error" role="alert">{problem}</p>}
    </div>}
    {confirm === 'enable' && <ConfirmDialog title={`Let a webhook start ${name}?`} body="You get a secret to give to whatever should start it. Requests without a valid signature look like a missing page, and every run stays inside this schedule's limits, never with Full access." confirmLabel="Turn on" cancelLabel="Not now" onConfirm={() => { setConfirm(null); void call('automation.webhook.enable', { includeBody: false, confirm: true }) }} onCancel={() => setConfirm(null)} />}
    {confirm === 'rotate' && <ConfirmDialog title="Make a new secret?" body="Senders using the old secret stop working at once." confirmLabel="Rotate" cancelLabel="Keep it" tone="warning" onConfirm={() => { setConfirm(null); void call('automation.webhook.rotate', { confirm: true }) }} onCancel={() => setConfirm(null)} />}
  </div>
}
