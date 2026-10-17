// Native Remote (no Tailscale): pick the method, set the sign-in, and see the
// addresses and certificate fingerprint a device will use. The daemon owns the
// listener, the certificate and the password hash; this page only asks.
import { useState } from 'react'
import { AlertTriangle, Check, CircleDashed, Copy, Globe, KeyRound, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react'
import type { RemoteMethodId, RemoteNativeStatus } from '../remote/remoteContract'
import { HelpTip, SettingsGroup, SettingsRow } from './SettingsParts'
import { QrGlyph } from './QrGlyph'

export const MIN_PASSWORD = 12

/** Why a username/password pair cannot be saved yet, or null. */
export function accountProblem(username: string, password: string, confirm: string): string | null {
  const name = username.trim()
  if (!name) return 'Choose a username.'
  if (name.length > 64) return 'Keep the username under 64 characters.'
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters for the password.`
  if (password === name) return 'The password can’t be the username.'
  if (password !== confirm) return 'The two passwords don’t match.'
  return null
}

function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return <button type="button" className="remote-address" title={`Copy ${label}`} aria-label={`Copy ${label}`} onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }).catch(() => undefined) }}>
    <span>{text}</span>{copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
  </button>
}

export function RemoteMethodSwitch({ method, locked, onChange }: { method: RemoteMethodId; locked: boolean; onChange: (method: RemoteMethodId) => void }) {
  const options: Array<{ id: RemoteMethodId; title: string; detail: string; Icon: typeof Globe }> = [
    { id: 'tailscale', title: 'Tailscale', detail: 'Private network between your own devices. Needs the free Tailscale app on each.', Icon: Smartphone },
    { id: 'native', title: 'Direct', detail: 'Only Bitbots. Devices sign in with your password over this computer’s own address.', Icon: Globe },
  ]
  return <div className="remote-method" role="radiogroup" aria-label="How devices connect">
    {options.map(({ id, title, detail, Icon }) => <button key={id} type="button" role="radio" aria-checked={method === id} className={`remote-method-option${method === id ? ' on' : ''}`} disabled={locked && method !== id} onClick={() => { if (method !== id) onChange(id) }}>
      <span className="remote-method-icon" aria-hidden="true"><Icon size={16} /></span>
      <span className="remote-method-copy"><strong>{title}</strong><small>{detail}</small></span>
    </button>)}
    {locked && <p className="remote-method-note">Turn Remote off to switch how devices connect.</p>}
  </div>
}

export function NativeAccountGroup({ native, busy, onSave }: { native: RemoteNativeStatus | undefined; busy: boolean; onSave: (username: string, password: string) => Promise<void> | void }) {
  const [editing, setEditing] = useState(!native?.accountSet)
  const [username, setUsername] = useState(native?.username ?? '')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [tried, setTried] = useState(false)
  const problem = accountProblem(username, password, confirm)
  const save = async () => {
    setTried(true)
    if (problem) return
    await onSave(username.trim(), password)
    setPassword(''); setConfirm(''); setTried(false); setEditing(false)
  }
  return <SettingsGroup title="Sign-in">
    {!editing && native?.accountSet
      ? <SettingsRow label={<span className="remote-account"><KeyRound size={14} aria-hidden="true" />{native.username}</span>} hint="Devices sign in with this username and password, then you approve each new device here.">
        <button type="button" className="secondary-button small" onClick={() => { setUsername(native.username ?? ''); setEditing(true) }}>Change password</button>
      </SettingsRow>
      : <form className="remote-account-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <p className="remote-account-intro">Devices sign in with these. Bitbots keeps only a scrambled copy of the password; it can’t show it back to you.</p>
        <label className="settings-field"><span>Username</span><input className="text-input" autoComplete="username" value={username} maxLength={64} onChange={(event) => setUsername(event.target.value)} /></label>
        <label className="settings-field"><span>Password <small>{MIN_PASSWORD}+ characters</small></span><input className="text-input" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label className="settings-field"><span>Password again</span><input className="text-input" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
        {tried && problem && <p className="memory-problem" role="alert">{problem}</p>}
        <div className="settings-form-actions">
          {native?.accountSet && <button type="button" className="ghost-button small" onClick={() => setEditing(false)}>Cancel</button>}
          <button className="primary-button small" disabled={busy}>Save sign-in</button>
        </div>
      </form>}
  </SettingsGroup>
}

/** Where a device opens Bitbots, and the certificate it should see. */
export function NativeAddresses({ native, busy, onRegenerate }: { native: RemoteNativeStatus; busy: boolean; onRegenerate: () => void }) {
  const first = native.urls[0]
  return <div className="remote-native-addresses">
    {first && <QrGlyph value={first} size={132} />}
    <div className="remote-native-copy">
      <strong>Open this on the device</strong>
      {native.urls.length === 0 && <small>No address yet. Check the connection steps below.</small>}
      <div className="remote-native-urls">{native.urls.map((url) => <CopyText key={url} text={url} label={url} />)}</div>
      {native.fingerprint && <div className="remote-native-fingerprint">
        <span><ShieldCheck size={13} aria-hidden="true" />Certificate <HelpTip align="start" text="The browser will warn that the certificate isn't trusted, because Bitbots made it itself. Check that the fingerprint in the browser's certificate details matches this one, then continue. You only do this once per device." /></span>
        <code>{native.fingerprint}</code>
        <button type="button" className="ghost-button small" disabled={busy} onClick={onRegenerate}><RefreshCw size={12} aria-hidden="true" />New certificate</button>
      </div>}
    </div>
  </div>
}

export function NativePortRow({ port, busy, onSave }: { port: number; busy: boolean; onSave: (port: number) => void }) {
  const [value, setValue] = useState(String(port))
  const parsed = Number(value)
  const valid = Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535
  return <SettingsRow label="Port" hint="The port devices connect to on this computer. Your router has to forward it here when you are away from home.">
    <input className="text-input remote-port-input" inputMode="numeric" aria-label="Port" value={value} onChange={(event) => setValue(event.target.value.replace(/\D/g, '').slice(0, 5))} onBlur={() => { if (valid && parsed !== port) onSave(parsed) }} disabled={busy} />
  </SettingsRow>
}

export type StepTone = 'ok' | 'warn' | 'todo'
export interface ConnectStep { id: 'router' | 'firewall' | 'address' | 'test'; tone: StepTone; title: string; detail: string }

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The address a device away from home would use: the one naming the public IP, else the first. */
export function outsideUrl(native: RemoteNativeStatus): string | null {
  const ip = native.externalIp ?? null
  return (ip ? native.urls.find((url) => url.includes(ip)) : undefined) ?? native.urls[0] ?? null
}

/**
 * The checklist for reaching this computer from outside its network, in the
 * order someone fixes it: the router, the firewall, the public address, then a
 * test from a phone on mobile data. Pure, so each wording is tested.
 */
export function connectSteps(native: RemoteNativeStatus, on: boolean): ConnectStep[] {
  const port = native.port
  const forward = `Forward TCP port ${port} to this computer in your router’s settings.`
  const upnp = native.upnp ?? { consent: false, state: 'off' as const }
  const router: ConnectStep = !upnp.consent
    ? { id: 'router', tone: 'todo', title: 'Router forwarding', detail: `${forward} Or let Bitbots ask the router for you.` }
    : upnp.state === 'mapped'
      ? { id: 'router', tone: 'ok', title: `Your router forwards port ${port}`, detail: 'Bitbots asked the router, and removes the forward when Remote turns off.' }
      : upnp.state === 'no_gateway'
        ? { id: 'router', tone: 'warn', title: 'No router answered', detail: `Automatic forwarding (UPnP) may be off on your router. ${forward}` }
        : upnp.state === 'failed'
          ? { id: 'router', tone: 'warn', title: 'The router said no', detail: `${upnp.error ? `It answered “${upnp.error}”. ` : ''}${forward}` }
          : { id: 'router', tone: 'todo', title: 'Router forwarding', detail: on ? 'Asking the router…' : `Bitbots asks your router to forward port ${port} when Remote turns on.` }
  const steps: ConnectStep[] = [router]
  const firewall = native.firewall ?? 'unknown'
  if (firewall === 'allowed') steps.push({ id: 'firewall', tone: 'ok', title: 'Windows Firewall lets it in', detail: `An inbound rule allows TCP port ${port}.` })
  else if (firewall === 'missing') steps.push({ id: 'firewall', tone: 'warn', title: 'Windows Firewall blocks it', detail: `Other devices can’t get in until Windows allows port ${port}. Windows asks you to confirm.` })
  else if (firewall === 'unknown') steps.push({ id: 'firewall', tone: 'todo', title: 'Windows Firewall not checked', detail: `Bitbots couldn’t read the firewall. Allow port ${port} if devices can’t connect.` })
  const ip = native.externalIp ?? null
  if (ip && native.cgnat && native.cgnatReason === 'carrier_nat') steps.push({ id: 'address', tone: 'warn', title: 'Your provider shares your address', detail: `${ip} is shared by your internet provider (carrier-grade NAT), so devices away from this network can’t reach this computer. Use Tailscale instead, or ask your provider for a public IP address.` })
  else if (ip && native.cgnat) steps.push({ id: 'address', tone: 'warn', title: 'That address is private', detail: `${ip} only works on this network. Enter the public address shown on your router’s status page.` })
  else if (ip) steps.push({ id: 'address', tone: 'ok', title: `Public address ${ip}`, detail: native.externalIpSource === 'manual' ? 'Entered by you. If your provider changes it, update it here.' : 'From your router. Bitbots checks it every 10 minutes.' })
  else steps.push({ id: 'address', tone: 'todo', title: 'Public address unknown', detail: 'Let Bitbots ask your router, or enter the public address shown on your router’s status page.' })
  if (on) {
    const url = outsideUrl(native)
    const howTo = url ? `On your phone, turn off Wi-Fi and open ${url}/api/ping.` : 'Once there is an address, open it on your phone with Wi-Fi off.'
    const from = native.lastReachedFrom
    if (native.lastReachedAt && from && from !== 'this network') steps.push({ id: 'test', tone: 'ok', title: `Reached from ${from}`, detail: `A device outside this network got through at ${clock(native.lastReachedAt)}.` })
    else if (native.lastReachedAt) steps.push({ id: 'test', tone: 'todo', title: 'Reached from this network only', detail: `At ${clock(native.lastReachedAt)}. That proves Bitbots answers, not that the internet can reach it. ${howTo}` })
    else steps.push({ id: 'test', tone: 'todo', title: 'Test from outside', detail: `${howTo} When it gets through, it shows here.` })
  }
  return steps
}

const TONE_ICON = { ok: Check, warn: AlertTriangle, todo: CircleDashed } as const

/** Is a typed public address plausible enough to send? The daemon has the final say. */
export function looksLikeAddress(text: string): boolean {
  const value = text.trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return value.split('.').every((part) => Number(part) <= 255)
  return /^[0-9a-f:]+$/i.test(value) && value.includes(':')
}

export function NativeConnectivityGroup({ native, on, busy, onConsent, onAddFirewall, onRemoveFirewall, onExternalIp }: {
  native: RemoteNativeStatus
  on: boolean
  busy: boolean
  onConsent: (enabled: boolean) => void
  onAddFirewall: () => Promise<string>
  onRemoveFirewall: () => Promise<string>
  onExternalIp: (ip: string | null) => void
}) {
  const [firewallNote, setFirewallNote] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const steps = connectSteps(native, on)
  const consent = native.upnp?.consent ?? false
  const firewall = native.firewall ?? 'unknown'
  const firewallAction = async (add: boolean) => {
    setFirewallNote(null)
    const result = await (add ? onAddFirewall() : onRemoveFirewall())
    if (result === 'declined') setFirewallNote('Windows asked for permission and it wasn’t given. Nothing changed.')
    else if (result === 'failed') setFirewallNote(add ? 'Windows didn’t add the rule. Try again, or allow the port in Windows Security.' : 'Windows didn’t remove the rule.')
  }
  const saveAddress = () => { if (!looksLikeAddress(address)) return; onExternalIp(address.trim()); setEditing(false); setAddress('') }
  const extra = (step: ConnectStep) => {
    if (step.id === 'router') return <button type="button" role="switch" aria-checked={consent} aria-label="Ask my router to forward the port" className={`toggle ${consent ? 'on' : ''}`} disabled={busy} onClick={() => onConsent(!consent)}><i /></button>
    if (step.id === 'firewall' && firewall !== 'allowed') return <button type="button" className="secondary-button small" disabled={busy} onClick={() => void firewallAction(true)}>Allow in firewall</button>
    if (step.id === 'firewall') return <button type="button" className="ghost-button small" disabled={busy} onClick={() => void firewallAction(false)}>Remove rule</button>
    if (step.id === 'address' && !editing) return <button type="button" className="ghost-button small" disabled={busy} onClick={() => { setAddress(native.externalIpSource === 'manual' ? native.externalIp ?? '' : ''); setEditing(true) }}>{native.externalIp ? 'Change' : 'Enter it'}</button>
    return null
  }
  return <SettingsGroup title="Reaching this computer from away">
    <ol className="remote-steps">
      {steps.map((step) => {
        const Icon = TONE_ICON[step.tone]
        return <li key={step.id} className={`remote-step ${step.tone}`}>
          <span className="remote-step-icon" aria-hidden="true"><Icon size={13} /></span>
          <span className="remote-step-copy">
            <strong>{step.title}</strong>
            <small>{step.detail}</small>
            {step.id === 'router' && consent && <small className="remote-step-aside">Uses UPnP, on this network only.</small>}
            {step.id === 'firewall' && firewallNote && <small className="remote-step-problem" role="alert">{firewallNote}</small>}
            {step.id === 'address' && editing && <form className="remote-step-form" onSubmit={(event) => { event.preventDefault(); saveAddress() }}>
              <input className="text-input" aria-label="Public address" placeholder="203.0.113.7" inputMode="decimal" autoFocus onFocus={(event) => event.target.select()} value={address} onChange={(event) => setAddress(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setEditing(false) }} />
              <button className="primary-button small" disabled={busy || !looksLikeAddress(address)}>Save</button>
              {native.externalIpSource === 'manual' && <button type="button" className="ghost-button small" disabled={busy} onClick={() => { onExternalIp(null); setEditing(false) }}>Clear</button>}
              <button type="button" className="ghost-button small" onClick={() => setEditing(false)}>Cancel</button>
            </form>}
          </span>
          <span className="remote-step-action">{extra(step)}</span>
        </li>
      })}
    </ol>
  </SettingsGroup>
}
