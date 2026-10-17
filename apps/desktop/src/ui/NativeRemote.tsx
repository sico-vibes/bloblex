// Native Remote (no Tailscale): pick the method, set the sign-in, and see the
// addresses and certificate fingerprint a device will use. The daemon owns the
// listener, the certificate and the password hash; this page only asks.
import { useState } from 'react'
import { Check, Copy, Globe, KeyRound, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react'
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
      {native.lastReachedAt && <small className="remote-native-reached">Reached{native.lastReachedFrom ? ` from ${native.lastReachedFrom}` : ''} at {new Date(native.lastReachedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>}
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
