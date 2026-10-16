import { useEffect, useMemo, useState } from 'react'
import { Laptop, Globe, Monitor, Smartphone, Tablet, Wifi, X } from 'lucide-react'
import { useRemote } from '../remote/useRemote'
import { REMOTE_TIERS, type DeviceKind, type RemoteActivityEntry, type RemoteDevice, type RemoteTier } from '../remote/remoteContract'
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

/**
 * Settings > Remote. In this build only the browser preview answers the
 * `remote.*` calls, so on a real desktop `available` is false and the page
 * explains what Remote mode will do instead of showing dead controls.
 */
export function RemoteSettings({ onOpenPower }: { onOpenPower?: () => void }) {
  const remote = useRemote(true)
  const { state } = remote
  const noun = useEntityNoun()
  const nouns = useEntityNoun({ plural: true })
  const [now, setNow] = useState(() => Date.now())
  const [consent, setConsent] = useState(false)
  const [revoking, setRevoking] = useState<RemoteDevice | null>(null)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const status = state.status
  const on = !!status?.enabled
  const approvalsOn = state.security.approvalsFromRemote
  const tierOptions = useMemo(() => REMOTE_TIERS.filter((tier) => tier !== 'operator' || approvalsOn).map((tier) => ({ value: tier, label: TIER_LABEL[tier] })), [approvalsOn])

  if (state.available === null) return <p className="settings-loading">Loading Remote…</p>

  const intro = <div className="remote-hero">
    <span className={`remote-hero-art${on ? ' live' : ''}`} aria-hidden="true"><Monitor size={24} /><i /><Smartphone size={20} /></span>
    <div>
      <h3>Use your {nouns} from anywhere</h3>
      <p>Turn this computer into a host. Open Bitbots from a phone, a tablet or another browser and chat with your {nouns} while this computer keeps doing the work.</p>
    </div>
  </div>

  if (state.available === false) {
    return <>
      {intro}
      <SettingsGroup title="Status">
        <SettingsRow label="Not in this build yet" hint="Remote mode is designed and previewed, but this version of Bitbots cannot host devices. Nothing is exposed to your network." />
      </SettingsGroup>
    </>
  }

  return <>
    <p className="remote-preview-note" role="note">Preview. This page is simulated: no relay, no network and no real devices are involved.</p>
    {intro}

    <SettingsGroup title="Remote access">
      <SettingsRow label="Allow remote devices" hint="Devices you pair can reach this computer's bots through an encrypted relay. Turn it off and everyone is disconnected at once.">
        {/* FIX29 UI: Director — `link` is off/starting/online/error now. */}
        <button type="button" role="switch" aria-checked={on} aria-label="Allow remote devices" className={`toggle ${on ? 'on' : ''}`} disabled={state.busy || status?.link === 'starting'}
          onClick={() => { if (on) void remote.disable(); else setConsent(true) }}><i /></button>
      </SettingsRow>
      {on && status && <div className="remote-status" role="status" aria-live="polite">
        <StatusDot status={status.link === 'online' ? 'working' : status.link === 'error' ? 'failed' : 'waiting'} label={status.link} />
        <div>
          <strong>{status.link === 'online' ? `Online as ${status.hostName}` : status.link === 'starting' ? 'Starting…' : 'Not connected'}</strong>
          {/* FIX29 UI: Director — the relay host, latency and "since" fields are gone; the serve URL replaces them. */}
          <small>{status.link === 'online' ? `${status.url ?? 'no address'} · ${status.connectedCount} of ${status.deviceCount} devices connected` : status.error ?? `Waiting for the serve address (Tailscale: ${status.tailscale}).`}</small>
        </div>
      </div>}
      {on && <SettingsRow label="Keep this computer awake" hint="Remote only works while this computer is on and online. Sleep makes it unreachable.">
        <button type="button" className="secondary-button small" onClick={onOpenPower}>Power settings</button>
      </SettingsRow>}
    </SettingsGroup>

    {on && <SettingsGroup title="Add a device">
      {state.justPaired && <div className="remote-paired" role="status">
        <span className="remote-paired-icon" aria-hidden="true"><DeviceIcon kind={state.justPaired.kind} /></span>
        <div><strong>{state.justPaired.name} is connected</strong><small>It can chat with your {nouns}. Change what it may do in the list below.</small></div>
        <button type="button" className="ghost-button small" onClick={remote.dismissPaired}>Done</button>
      </div>}
      {!state.offer && !state.justPaired && <SettingsRow label="Pair a phone, tablet or browser" hint={`Open Bitbots on the device and scan the code, or type it. Each device gets its own key, so you can remove one without affecting the rest.`}>
        <button type="button" className="primary-button small" disabled={state.busy || status?.link !== 'online'} onClick={() => void remote.beginPairing()}>Show pairing code</button>
      </SettingsRow>}
      {state.offer && <div className="remote-pair">
        <QrGlyph value={state.offer.qrPayload} size={148} />
        <div className="remote-pair-copy">
          <small>Pairing code</small>
          <output className="remote-code" aria-label={`Pairing code ${state.offer.code.split('').join(' ')}`}>{state.offer.code}</output>
          {/* FIX29 UI: Director — the offer names the serve URL now, not a relay. */}
          <p>Open <b>{state.offer.url}</b> on the new device, choose Connect, and enter the code. It works once and expires in <b>{countdown(state.offer.expiresAt, now)}</b>.</p>
          <div className="remote-pair-actions">
            <button type="button" className="secondary-button small" disabled={state.busy} onClick={() => void remote.beginPairing()}>New code</button>
            <button type="button" className="ghost-button small" disabled={state.busy} onClick={() => void remote.cancelPairing()}>Cancel</button>
            <button type="button" className="ghost-button small remote-simulate" disabled={state.busy} onClick={() => void remote.simulatePairing()}><Wifi size={13} aria-hidden="true" />Simulate a phone pairing</button>
          </div>
        </div>
      </div>}
    </SettingsGroup>}

    {on && <SettingsGroup title={`Devices (${state.devices.length})`}>
      {state.devices.length === 0 && <p className="settings-empty">No devices yet. Pair one above and it will appear here.</p>}
      {state.devices.map((device) => <div className="remote-device" key={device.id}>
        <span className="remote-device-icon"><DeviceIcon kind={device.kind} /></span>
        <span className="remote-device-copy">
          <strong>{device.name}</strong>
          <small>{device.platform} · {device.online ? <span className="remote-online"><i aria-hidden="true" />Online now</span> : `Last seen ${ago(device.lastSeenAt, now)}`}</small>
        </span>
        <Select ariaLabel={`What ${device.name} may do`} variant="muted" value={device.tier} disabled={state.busy}
          onChange={(value) => { if ((REMOTE_TIERS as readonly string[]).includes(value)) void remote.updateDevice(device.id, { tier: value as RemoteTier }) }}
          options={(device.tier === 'operator' && !approvalsOn ? [...tierOptions, { value: 'operator', label: TIER_LABEL.operator }] : tierOptions)} />
        <button type="button" className="icon-button" aria-label={`Remove ${device.name}`} title="Remove device" onClick={() => setRevoking(device)}><X size={15} aria-hidden="true" /></button>
      </div>)}
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

    {/* FIX29 UI: Director — the Advanced "also listen on this network" row and the
        relay wording are gone with the Tailscale design; the Director rewrites this page. */}
    {state.error && <p className="settings-banner error" role="alert">{state.error}</p>}

    {consent && <ConfirmDialog title="Turn on Remote?" confirmLabel="Turn on" cancelLabel="Not now"
      body={`This computer will connect to a relay so your paired devices can reach it. A message from a paired device can make a ${noun} work on this computer, within the approval mode you have set. You choose which devices are allowed and can turn this off at any time.`}
      onConfirm={() => { setConsent(false); void remote.enable() }} onCancel={() => setConsent(false)} />}
    {revoking && <ConfirmDialog title={`Remove ${revoking.name}?`} confirmLabel="Remove" cancelLabel="Keep" tone="danger"
      body="It is signed out now and has to pair again to come back. Conversations stay on this computer."
      onConfirm={() => { const id = revoking.id; setRevoking(null); void remote.revokeDevice(id) }} onCancel={() => setRevoking(null)} />}
  </>
}
