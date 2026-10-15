import { useCallback, useEffect, useRef, useState } from 'react'
import { listenForDaemonEvents, rpc } from '../tauri'
import {
  DEFAULT_REMOTE_SECURITY,
  type PairingOffer,
  type RemoteActivityEntry,
  type RemoteDevice,
  type RemoteSecurityOptions,
  type RemoteStatus,
  type RemoteTier,
} from './remoteContract'

export interface RemoteAvailability {
  /** null while loading; false when this build has no remote support. */
  available: boolean | null
  status: RemoteStatus | null
}

export interface RemoteState {
  /** null while loading; false when this build has no remote support. */
  available: boolean | null
  status: RemoteStatus | null
  devices: RemoteDevice[]
  security: RemoteSecurityOptions
  activity: RemoteActivityEntry[]
  offer: PairingOffer | null
  /** The device that just finished pairing, for a short confirmation. */
  justPaired: RemoteDevice | null
  busy: boolean
  error: string | null
}

const EMPTY: RemoteState = { available: null, status: null, devices: [], security: DEFAULT_REMOTE_SECURITY, activity: [], offer: null, justPaired: null, busy: false, error: null }

/**
 * The host side of Remote mode as the Settings page sees it. Everything goes
 * through `remote.*` RPC; in this build only the browser preview answers, so
 * `available` is false on a real desktop and the page explains that instead.
 */
export function useRemote(enabled = true) {
  const [state, setState] = useState<RemoteState>(EMPTY)
  const alive = useRef(true)
  const reloadTimer = useRef<number | null>(null)

  const load = useCallback(async () => {
    try {
      const [status, devices, security, activity] = await Promise.all([
        rpc<RemoteStatus>('remote.status'),
        rpc<RemoteDevice[]>('remote.devices.list'),
        rpc<RemoteSecurityOptions>('remote.security.get'),
        rpc<RemoteActivityEntry[]>('remote.activity.list'),
      ])
      if (!alive.current) return
      setState((current) => ({ ...current, available: true, status, devices, security, activity, error: null }))
    } catch {
      if (alive.current) setState((current) => ({ ...current, available: false }))
    }
  }, [])

  useEffect(() => {
    alive.current = true
    if (!enabled) return
    void load()
    let unlisten: (() => void) | null = null
    void listenForDaemonEvents((event) => {
      if (!event.type.startsWith('remote.')) return
      if (event.type === 'remote.pairing.completed') {
        const device = (event.payload as { device?: RemoteDevice } | undefined)?.device ?? null
        setState((current) => ({ ...current, offer: null, justPaired: device }))
      }
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
      reloadTimer.current = window.setTimeout(() => { reloadTimer.current = null; void load() }, 40)
    }).then((stop) => { unlisten = stop }).catch(() => undefined)
    return () => {
      alive.current = false
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
      unlisten?.()
    }
  }, [enabled, load])

  const run = useCallback(async (action: () => Promise<void>) => {
    setState((current) => ({ ...current, busy: true, error: null }))
    try { await action() } catch (reason) {
      const message = reason && typeof reason === 'object' && 'message' in reason ? String((reason as { message: unknown }).message) : 'That did not work. Try again.'
      if (alive.current) setState((current) => ({ ...current, error: message }))
    } finally {
      if (alive.current) setState((current) => ({ ...current, busy: false }))
    }
    await load()
  }, [load])

  return {
    state,
    reload: load,
    enable: () => run(async () => { await rpc('remote.enable') }),
    disable: () => run(async () => { await rpc('remote.disable'); setState((current) => ({ ...current, offer: null })) }),
    beginPairing: () => run(async () => {
      const offer = await rpc<PairingOffer>('remote.pair.begin')
      setState((current) => ({ ...current, offer, justPaired: null }))
    }),
    cancelPairing: () => run(async () => { await rpc('remote.pair.cancel'); setState((current) => ({ ...current, offer: null })) }),
    updateDevice: (deviceId: string, patch: { tier?: RemoteTier; name?: string }) => run(async () => { await rpc('remote.devices.update', { deviceId, ...patch }) }),
    revokeDevice: (deviceId: string) => run(async () => { await rpc('remote.devices.revoke', { deviceId }) }),
    setSecurity: (patch: Partial<RemoteSecurityOptions>) => run(async () => { await rpc('remote.security.set', { ...state.security, ...patch }) }),
    setDirect: (enabledDirect: boolean) => run(async () => { await rpc('remote.direct.set', { enabled: enabledDirect }) }),
    /** Preview only: act as the phone finishing pairing. */
    simulatePairing: () => run(async () => { await rpc('remote.preview.pair') }),
    dismissPaired: () => setState((current) => ({ ...current, justPaired: null })),
  }
}

/**
 * The cheap slice of Remote state a sidebar chip or a menu row needs: whether
 * this build answers `remote.*` at all, and the current `remote.status`
 * reading. Unlike `useRemote` it never fetches devices, security or activity,
 * and it re-reads the status whenever any `remote.*` event arrives.
 */
export function useRemoteStatus(enabled = true): RemoteAvailability {
  const [state, setState] = useState<RemoteAvailability>({ available: null, status: null })
  const alive = useRef(true)
  const reloadTimer = useRef<number | null>(null)

  useEffect(() => {
    alive.current = true
    if (!enabled) return
    const load = async () => {
      try {
        const status = await rpc<RemoteStatus>('remote.status')
        if (!alive.current) return
        if (status && typeof status === 'object') setState({ available: true, status })
        else setState({ available: false, status: null })
      } catch {
        if (alive.current) setState({ available: false, status: null })
      }
    }
    void load()
    let unlisten: (() => void) | null = null
    try {
      void listenForDaemonEvents((event) => {
        if (!event.type.startsWith('remote.')) return
        if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
        reloadTimer.current = window.setTimeout(() => { reloadTimer.current = null; void load() }, 40)
      }).then((stop) => { unlisten = stop }).catch(() => undefined)
    } catch { /* This build has no daemon event stream. */ }
    return () => {
      alive.current = false
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
      unlisten?.()
    }
  }, [enabled])

  return state
}
