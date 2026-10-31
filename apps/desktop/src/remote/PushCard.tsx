// Phase 6: this phone's notifications. They say only "Rae needs you", and they travel through the
// phone maker's push service, which is why the owner turns them on at the computer first.
import { useEffect, useState } from 'react'
import { Bell, BellOff } from 'lucide-react'
import { rpc } from '../tauri'

type PushState = 'loading' | 'unsupported' | 'off-at-computer' | 'blocked' | 'off' | 'on'

/** A base64url VAPID key as the bytes `pushManager.subscribe` wants. */
export function keyBytes(base64url: string): Uint8Array {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const encoded = (key: ArrayBuffer | null) => key ? btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : ''
const supported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof Notification !== 'undefined' && typeof PushManager !== 'undefined'

export function PushCard() {
  const [state, setState] = useState<PushState>('loading')
  const [publicKey, setPublicKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void (async () => {
      if (!supported()) { if (live) setState('unsupported'); return }
      const reply = await rpc<{ publicKey?: string; enabled?: boolean }>('push.key', {}).catch(() => null)
      if (!live) return
      if (!reply?.enabled || !reply.publicKey) { setState('off-at-computer'); return }
      setPublicKey(reply.publicKey)
      const registration = await navigator.serviceWorker.ready
      const existing = await registration.pushManager.getSubscription()
      if (!live) return
      setState(Notification.permission === 'denied' ? 'blocked' : existing ? 'on' : 'off')
    })()
    return () => { live = false }
  }, [])
  const turnOn = async () => {
    setBusy(true); setProblem(null)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') { setState(permission === 'denied' ? 'blocked' : 'off'); return }
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource })
      await rpc('push.subscribe', { endpoint: subscription.endpoint, p256dh: encoded(subscription.getKey('p256dh')), auth: encoded(subscription.getKey('auth')) })
      setState('on')
    } catch { setProblem('Notifications could not be turned on here.') } finally { setBusy(false) }
  }
  const turnOff = async () => {
    setBusy(true); setProblem(null)
    try {
      const registration = await navigator.serviceWorker.ready
      await (await registration.pushManager.getSubscription())?.unsubscribe()
      await rpc('push.unsubscribe', {})
      setState('off')
    } catch { setProblem('Notifications could not be turned off here.') } finally { setBusy(false) }
  }
  if (state === 'loading') return null
  const copy: Record<Exclude<PushState, 'loading'>, string> = {
    unsupported: 'This browser can\'t show notifications. On iPhone, add Bitbots to your Home Screen first.',
    'off-at-computer': 'Turn them on first at the computer, in Settings › Remote.',
    blocked: 'Notifications are blocked for this site. Allow them in your browser\'s settings.',
    off: 'Get a notice when a bot needs you. It says only the bot\'s name, never what it\'s doing.',
    on: 'On. A notice says only the bot\'s name, never what it\'s doing.',
  }
  return <div className="rm-card">
    <span className="rm-card-icon">{state === 'on' ? <Bell size={18} aria-hidden="true" /> : <BellOff size={18} aria-hidden="true" />}</span>
    <div>
      <strong>Notifications</strong>
      <small>{copy[state]}</small>
      {problem && <small role="alert">{problem}</small>}
      {state === 'off' && <button type="button" className="rm-text-button" disabled={busy} onClick={() => void turnOn()}>Turn on</button>}
      {state === 'on' && <button type="button" className="rm-text-button" disabled={busy} onClick={() => void turnOff()}>Turn off</button>}
    </div>
  </div>
}
