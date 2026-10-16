import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Globe, Laptop, Monitor, Pencil, RefreshCw, Smartphone, Tablet, Wifi, X } from 'lucide-react'
import { useRemote } from '../remote/useRemote'
import { REMOTE_TIERS, type DeviceKind, type RemoteActivityEntry, type RemoteDevice, type RemoteTailscaleState, type RemoteTier } from '../remote/remoteContract'
import { previewMode } from '../tauri'
import { Select } from './Select'
import { ConfirmDialog } from './BlobPage'
import { SettingsGroup, SettingsRow } from './SettingsParts'
import { StatusDot } from './StatusDot'
import { QrGlyph } from './QrGlyph'
import { useEntityNoun } from './vocabulary'
import './remoteSettings.css'

const TIER_LABEL: Record<RemoteTier, string> = { viewer: 'View only', chat: 'Chat', operator: 'Chat and approve' }
const TIER_HINT: Record<RemoteTier, string> = {
  viewer: 'Can read conversations. Cannot send anything.',
  chat: 'Can send messages and stop a turn. Cannot approve actions.',
  operator: 'Can also approve or deny requests. Only offered when approvals from remote are on.',
}

/** What to do when Tailscale is not ready, one plain step list per state. */
export const TAILSCALE_FIX: Record<Exclude<RemoteTailscaleState, 'ready'>, { title: string; steps: string[] }> = {
  not_installed: { title: 'Tailscale is not installed', steps: ['Install Tailscale on this computer from tailscale.com/download.', 'Sign in, then install it on your phone with the same account.'] },
  logged_out: { title: 'Tailscale is signed out', steps: ['Open Tailscale from the system tray and sign in.', 'Use the same account on your phone.'] },
  https_disabled: { title: 'HTTPS is off for your tailnet', steps: ['Open the Tailscale admin console and go to DNS.', 'Turn on MagicDNS and HTTPS Certificates, then check again.'] },
  port_in_use: { title: 'The Remote port is busy', steps: ['Another app is using the port Bitbots listens on.', 'Close that app, or restart Bitbots, then check again.'] },
  funnel_on: { title: 'Tailscale Funnel is on', steps: ['Funnel would publish Bitbots to the whole internet, so Remote will not start.', 'Run "tailscale funnel reset" or turn Funnel off in Tailscale, then check again.'] },
}

function DeviceIcon({ kind }: { kind: DeviceKind }) {
  const Icon = kind === 'phone' ? Smartphone : kind === 'tablet' ? Tablet : kind === 'computer' ? Laptop : Globe
  return <Icon size={17} aria-hidden="true" />
}

function ago(iso: string | null, now: number): string {
  if (!iso) return 'never'
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 90) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86_400)} d ago`
}

function countdown(expiresAt: string, now: number): string {
  const left = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

function ActivityLine({ entry, now }: { entry: RemoteActivityEntry; now: number }) {
  return <li><span>{entry.summary}</span><time dateTime={entry.at}>{ago(entry.at, now)}</time></li>
}

function CopyAddress({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  return <button type="button" className="remote-address" title="Copy the address" onClick={() => { void navigator.clipboard?.writeText(url).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }).catch(() => undefined) }}>
    <span>{url}</span>{copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
  </button>
}

function DeviceRow({ device, now, busy, tierOptions, approvalsOn, onTier, onRename, onRemove }: {
  device: RemoteDevice
  now: number
  busy: boolean
  tierOptions: Array<{ value: string; label: string }>
  approvalsOn: boolean
  onTier: (tier: RemoteTier) => void
  onRename: (name: string) => void
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(device.name)
  const save = () => { const name = draft.trim(); setEditing(false); if (name && name !== device.name) onRename(name) }
  return <div className="remote-device">
    <span className="remote-device-icon"><DeviceIcon kind={device.kind} /></span>
    <span className="remote-device-copy">
      {editing
        ? <input className="remote-rename" aria-label={`Name for ${device.name}`} value={draft} maxLength={60} autoFocus onChange={(event) => setDraft(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === 'Enter') save(); if (event.key === 'Escape') { setDraft(device.name); setEditing(false) } }} />
        : <strong>{device.name}</strong>}
      <small>{device.platform} · {device.online ? <span className="remote-online"><i aria-hidden="true" />Online now</span> : `Last seen ${ago(device.lastSeenAt, now)}`}</small>
    </span>
    {!editing && <button type="button" className="icon-button" aria-label={`Rename ${device.name}`} title="Rename" onClick={() => { setDraft(device.name); setEditing(true) }}><Pencil size={14} aria-hidden="true" /></button>}
    <Select ariaLabel={`What ${device.name} may do`} variant="muted" value={device.tier} disabled={busy}
      onChange={(value) => { if ((REMOTE_TIERS as readonly string[]).includes(value)) onTier(value as RemoteTier) }}
      options={(device.tier === 'operator' && !approvalsOn ? [...tierOptions, { value: 'operator', label: TIER_LABEL.operator }] : tierOptions)} />
    <button type="button" className="icon-button" aria-label={`Remove ${device.name}`} title="Remove device" onClick={onRemove}><X size={15} aria-hidden="true" /></button>
  </div>
}

/**
 * Settings > Remote. The daemon publishes a loopback gateway on the owner's
 * tailnet with `tailscale serve`; this page shows whether Tailscale is ready,
 * turns Remote on and off, pairs devices (the owner approves each one here),
 * and manages devices, safety options and the activity log.
 */
export function RemoteSettings({ onOpenPower }: { onOpenPower?: () => void }) {
  const remote = useRemote(true)
  const { state } = remote
  const noun = useEntityNoun()
  const nouns = useEntityNoun({ plural: true })
  const [now, setNow] = useState(() => Date.now())
  const [consent, setConsent] = useState(false)
  const [revoking, setRevoking] = useState<RemoteDevice | null>(null)
  const [requestTier, setRequestTier] = useState<RemoteTier>('chat')
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => { setRequestTier('chat') }, [state.request?.pairingId])
  const status = state.status
  const on = !!status?.enabled
  const approvalsOn = state.security.approvalsFromRemote
  const tierOptions = useMemo(() => REMOTE_TIERS.filter((tier) => tier !== 'operator' || approvalsOn).map((tier) => ({ value: tier, label: TIER_LABEL[tier] })), [approvalsOn])

  if (state.available === null) return <p className="settings-loading">Loading Remote…</p>

  const intro = <div className="remote-hero">
    <span className={`remote-hero-art${on && status?.link === 'online' ? ' live' : ''}`} aria-hidden="true"><Monitor size={24} /><i /><Smartphone size={20} /></span>
    <div>
      <h3>Use your {nouns} from anywhere</h3>
      <p>Open Bitbots on your phone, a tablet or another computer and chat with your {nouns} while this computer does the work. It travels over your private Tailscale network, so only your own devices can reach it.</p>
    </div>
  </div>

  if (state.available === false) {
    return <>
      {intro}
      <SettingsGroup title="Status">
        <SettingsRow label="Not available in this version" hint="This version of Bitbots cannot host devices yet. Nothing is published to your network." />
      </SettingsGroup>
    </>
  }

  const tailscale = status?.tailscale ?? 'ready'
  const fix = tailscale !== 'ready' ? TAILSCALE_FIX[tailscale] : null
  const request = state.request && Date.parse(state.request.expiresAt) > now ? state.request : null

  return <>
    {previewMode && <p className="remote-preview-note" role="note">Preview. This page is simulated: no Tailscale, no network and no real devices are involved.</p>}
    {intro}

    <SettingsGroup title="Remote access">
      {fix && !on && <div className="remote-fix" role="status">
        <strong>{fix.title}</strong>
        <ol>{fix.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        <button type="button" className="secondary-button small" disabled={state.busy} onClick={() => void remote.reload()}><RefreshCw size={13} aria-hidden="true" />Check again</button>
      </div>}
      <SettingsRow label="Allow remote devices" hint="Paired devices on your Tailscale network can reach this computer's bots. Turn it off and every device is disconnected at once.">
        <button type="button" role="switch" aria-checked={on} aria-label="Allow remote devices" className={`toggle ${on ? 'on' : ''}`} disabled={state.busy || status?.link === 'starting' || (!on && !!fix)}
          onClick={() => { if (on) void remote.disable(); else setConsent(true) }}><i /></button>
      </SettingsRow>
      {on && status && <div className="remote-status" role="status" aria-live="polite">
        <StatusDot status={status.link === 'online' ? 'working' : status.link === 'error' ? 'failed' : 'waiting'} label={status.link} />
        <div>
          <strong>{status.link === 'online' ? `Online as ${status.hostName}` : status.link === 'starting' ? 'Starting…' : 'Not connected'}</strong>
          {status.link === 'online' && status.url
            ? <small>{status.connectedCount} of {status.deviceCount} device{status.deviceCount === 1 ? '' : 's'} connected</small>
            : <small>{status.error ?? (fix ? fix.title : 'Waiting for Tailscale to publish the address.')}</small>}
        </div>
        {status.link === 'online' && status.url && <CopyAddress url={status.url} />}
      </div>}
      {on && <SettingsRow label="Keep this computer awake" hint="Remote only works while this computer is on and online. Sleep makes it unreachable.">
        <button type="button" className="secondary-button small" onClick={onOpenPower}>Power settings</button>
      </SettingsRow>}
    </SettingsGroup>

    {on && <SettingsGroup title="Add a device">
      {state.justPaired && <div className="remote-paired" role="status">
        <span className="remote-paired-icon" aria-hidden="true"><DeviceIcon kind={state.justPaired.kind} /></span>
        <div><strong>{state.justPaired.name} is connected</strong><small>It can {TIER_LABEL[state.justPaired.tier].toLowerCase()} with your {nouns}. Change what it may do in the list below.</small></div>
        <button type="button" className="ghost-button small" onClick={remote.dismissPaired}>Done</button>
      </div>}
      {request && <div className="remote-request" role="alertdialog" aria-labelledby="remote-request-title">
        <span className="remote-paired-icon" aria-hidden="true"><DeviceIcon kind={request.kind} /></span>
        <div className="remote-request-copy">
          <strong id="remote-request-title">{request.name} wants to connect</strong>
          <small>{request.platform}{request.login ? ` · signed in to Tailscale as ${request.login}` : ''} · answer within {countdown(request.expiresAt, now)}</small>
          <div className="remote-request-actions">
            <Select ariaLabel="What this device may do" variant="field" value={requestTier} onChange={(value) => setRequestTier(value as RemoteTier)} options={tierOptions} />
            <button type="button" className="ghost-button small" disabled={state.busy} onClick={() => void remote.rejectPairing(request.pairingId)}>Reject</button>
            <button type="button" className="primary-button small" disabled={state.busy} onClick={() => void remote.confirmPairing(request.pairingId, requestTier)}>Approve</button>
          </div>
        </div>
      </div>}
      {!state.offer && !request && !state.justPaired && <SettingsRow label="Pair a phone, tablet or browser" hint="Show a code here, open the address on the device and type the code. You then approve the device on this computer.">
        <button type="button" className="primary-button small" disabled={state.busy || status?.link !== 'online'} onClick={() => void remote.beginPairing()}>Show pairing code</button>
      </SettingsRow>}
      {state.offer && !request && <div className="remote-pair">
        <QrGlyph value={state.offer.qrPayload} size={148} />
        <div className="remote-pair-copy">
          <small>Pairing code</small>
          <output className="remote-code" aria-label={`Pairing code ${state.offer.code.split('').join(' ')}`}>{state.offer.code}</output>
          <p>Scan the code, or open <b>{state.offer.url}</b> on a device signed in to your Tailscale, and type the code. It works once and expires in <b>{countdown(state.offer.expiresAt, now)}</b>.</p>
          <div className="remote-pair-actions">
            <button type="button" className="secondary-button small" disabled={state.busy} onClick={() => void remote.beginPairing()}>New code</button>
            <button type="button" className="ghost-button small" disabled={state.busy} onClick={() => void remote.cancelPairing()}>Cancel</button>
            {previewMode && <button type="button" className="ghost-button small remote-simulate" disabled={state.busy} onClick={() => void remote.simulatePairing()}><Wifi size={13} aria-hidden="true" />Simulate a phone pairing</button>}
          </div>
        </div>
      </div>}
    </SettingsGroup>}

    {on && <SettingsGroup title={`Devices (${state.devices.length})`}>
      {state.devices.length === 0 && <p className="settings-empty">No devices yet. Pair one above and it will appear here.</p>}
      {state.devices.map((device) => <DeviceRow key={device.id} device={device} now={now} busy={state.busy} tierOptions={tierOptions} approvalsOn={approvalsOn}
        onTier={(tier) => void remote.updateDevice(device.id, { tier })}
        onRename={(name) => void remote.updateDevice(device.id, { name })}
        onRemove={() => setRevoking(device)} />)}
      {state.devices.length > 0 && <p className="remote-tier-hint">{TIER_HINT.chat} {approvalsOn ? TIER_HINT.operator : 'Approving from a device is off; turn it on below to allow it.'}</p>}
    </SettingsGroup>}

    {on && <SettingsGroup title="Safety">
      <SettingsRow label="Approve requests from remote devices" hint={`A message sent from a phone can make a ${noun} run commands on this computer. Leave this off to approve on this computer only.`}>
        <button type="button" role="switch" aria-checked={approvalsOn} aria-label="Approve requests from remote devices" className={`toggle ${approvalsOn ? 'on' : ''}`} disabled={state.busy}
          onClick={() => void remote.setSecurity({ approvalsFromRemote: !approvalsOn })}><i /></button>
      </SettingsRow>
      <SettingsRow label="Remove devices that go quiet" hint="A device that has not connected for this long is signed out and must pair again.">
        <Select ariaLabel="Remove idle devices after" variant="muted" value={String(state.security.idleExpiryDays)} disabled={state.busy}
          onChange={(value) => void remote.setSecurity({ idleExpiryDays: Number(value) as 0 | 7 | 30 | 90 })}
          options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '0', label: 'Never' }]} />
      </SettingsRow>
      <SettingsRow label="Quiet hours" hint={`Between ${state.security.quietHours.from} and ${state.security.quietHours.to} remote devices can read but not send.`}>
        <button type="button" role="switch" aria-checked={state.security.quietHours.enabled} aria-label="Quiet hours" className={`toggle ${state.security.quietHours.enabled ? 'on' : ''}`} disabled={state.busy}
          onClick={() => void remote.setSecurity({ quietHours: { ...state.security.quietHours, enabled: !state.security.quietHours.enabled } })}><i /></button>
      </SettingsRow>
    </SettingsGroup>}

    {on && <SettingsGroup title="Recent activity">
      {state.activity.length === 0
        ? <p className="settings-empty">Nothing yet. Connections, pairings and approvals show up here. Message text never does.</p>
        : <ul className="remote-activity">{state.activity.slice(0, 8).map((entry) => <ActivityLine key={entry.id} entry={entry} now={now} />)}</ul>}
    </SettingsGroup>}

    {state.error && <p className="settings-banner error" role="alert">{state.error}</p>}

    {consent && <ConfirmDialog title="Turn on Remote?" confirmLabel="Turn on" cancelLabel="Not now"
      body={`Bitbots will be published on your private Tailscale network. Only devices signed in to your Tailscale can reach it, and each one must be paired and approved by you here. A message from a paired device can make a ${noun} work on this computer, within the approval mode you have set. You can turn this off at any time.`}
      onConfirm={() => { setConsent(false); void remote.enable() }} onCancel={() => setConsent(false)} />}
    {revoking && <ConfirmDialog title={`Remove ${revoking.name}?`} confirmLabel="Remove" cancelLabel="Keep" tone="danger"
      body="It is signed out now and has to pair again to come back. Conversations stay on this computer."
      onConfirm={() => { const id = revoking.id; setRevoking(null); void remote.revokeDevice(id) }} onCancel={() => setRevoking(null)} />}
  </>
}
