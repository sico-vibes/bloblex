import { useCallback, useEffect, useRef, useState } from 'react'
import { listenForDaemonEvents, rpc } from '../tauri'
import {
  DEFAULT_REMOTE_SECURITY,
  type PairingOffer,
  type PairingOutcome,
  type PairingRequest,
  type RemoteActivityEntry,
  type RemoteDevice,
  type RemoteMethodId,
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
  /** The device that submitted the right code and waits for the owner's decision. */
  request: PairingRequest | null
  /** The last pairing outcome of this session, with the device when one was created. */
  lastOutcome: { outcome: PairingOutcome; device: RemoteDevice | null } | null
  busy: boolean
  error: string | null
}

/** `justPaired` is derived from `lastOutcome`; it exists only for the current Settings page. */
export type RemoteHookState = RemoteState & { justPaired: RemoteDevice | null }

const EMPTY: RemoteState = {
  available: null,
  status: null,
  devices: [],
  security: DEFAULT_REMOTE_SECURITY,
  activity: [],
  offer: null,
  request: null,
  lastOutcome: null,
  busy: false,
  error: null,
}

/** `remote.devices.list` is `{devices}`; a bare array is accepted too, because the shapes are young. */
function devicesFrom(result: { devices?: RemoteDevice[] } | RemoteDevice[] | null | undefined): RemoteDevice[] {
  if (Array.isArray(result)) return result
  return Array.isArray(result?.devices) ? result.devices : []
}

/** `remote.activity.list` is `{entries}`; likewise. */
function activityFrom(result: { entries?: RemoteActivityEntry[] } | RemoteActivityEntry[] | null | undefined): RemoteActivityEntry[] {
  if (Array.isArray(result)) return result
  return Array.isArray(result?.entries) ? result.entries : []
}

/**
 * The host side of Remote mode as the Settings page sees it. Everything goes
 * through `remote.*` RPC; in this build only the browser preview answers, so
 * `available` is false on a real desktop and the page explains that instead.
 */
export function useRemote(enabled = true) {
  const [state, setState] = useState<RemoteState>(EMPTY)
  const alive = useRef(true)
  const reloadTimer = useRef<number | null>(null)
  /** The device named by the last `remote.pairing.completed`, resolved on the next reload. */
  const pairedDeviceId = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [status, devicesResult, security, activityResult] = await Promise.all([
        rpc<RemoteStatus>('remote.status'),
        rpc<{ devices?: RemoteDevice[] } | RemoteDevice[]>('remote.devices.list'),
        rpc<RemoteSecurityOptions>('remote.security.get'),
        rpc<{ entries?: RemoteActivityEntry[] } | RemoteActivityEntry[]>('remote.activity.list'),
      ])
      if (!alive.current) return
      const devices = devicesFrom(devicesResult)
      const activity = activityFrom(activityResult)
      setState((current) => {
        const wanted = pairedDeviceId.current
        return {
          ...current,
          available: true,
          status,
          devices,
          security,
          activity,
          // A request that outlived its code is gone even if no event said so.
          request: current.request && Date.parse(current.request.expiresAt) > Date.now() ? current.request : null,
          lastOutcome: current.lastOutcome && wanted
            ? { ...current.lastOutcome, device: devices.find((device) => device.id === wanted) ?? null }
            : current.lastOutcome,
          // A finished action's message survives the reload; only the next action clears it.
        }
      })
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
      if (event.type === 'remote.pairing.requested') {
        const request = event.payload as PairingRequest | undefined
        // The code is locked to this request, so the live offer is gone with it.
        if (request && typeof request.pairingId === 'string') setState((current) => ({ ...current, offer: null, request }))
      }
      if (event.type === 'remote.pairing.completed') {
        const payload = event.payload as { outcome?: PairingOutcome; deviceId?: string } | undefined
        if (payload?.outcome) {
          pairedDeviceId.current = payload.deviceId ?? null
          setState((current) => ({ ...current, offer: null, request: null, lastOutcome: { outcome: payload.outcome as PairingOutcome, device: null } }))
        }
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

  const hookState: RemoteHookState = { ...state, justPaired: state.lastOutcome?.outcome === 'approved' ? state.lastOutcome.device : null }

  return {
    state: hookState,
    reload: load,
    enable: () => run(async () => { await rpc('remote.enable') }),
    disable: () => run(async () => { await rpc('remote.disable'); setState((current) => ({ ...current, offer: null, request: null })) }),
    beginPairing: () => run(async () => {
      const offer = await rpc<PairingOffer>('remote.pair.begin')
      setState((current) => ({ ...current, offer, request: null, lastOutcome: null }))
    }),
    cancelPairing: () => run(async () => { await rpc('remote.pair.cancel'); setState((current) => ({ ...current, offer: null, request: null })) }),
    confirmPairing: (pairingId: string, tier: RemoteTier) => run(async () => { await rpc('remote.pair.confirm', { pairingId, approve: true, tier }) }),
    rejectPairing: (pairingId: string) => run(async () => { await rpc('remote.pair.confirm', { pairingId, approve: false }) }),
    updateDevice: (deviceId: string, patch: { tier?: RemoteTier; name?: string }) => run(async () => { await rpc('remote.devices.update', { deviceId, ...patch }) }),
    revokeDevice: (deviceId: string) => run(async () => { await rpc('remote.devices.revoke', { deviceId }) }),
    setSecurity: (patch: Partial<RemoteSecurityOptions>) => run(async () => { await rpc('remote.security.set', { ...state.security, ...patch }) }),
    /** Native Remote: which method is active (Remote must be off to switch). */
    setMethod: (method: RemoteMethodId) => run(async () => { await rpc('remote.method.set', { method }) }),
    /** Native Remote: the username and password devices sign in with. */
    setNativeAccount: (username: string, password: string) => run(async () => { await rpc('remote.native.account.set', { username, password }) }),
    setNativePort: (port: number) => run(async () => { await rpc('remote.native.port.set', { port }) }),
    regenerateNativeCert: () => run(async () => { await rpc('remote.native.cert.regenerate') }),
    /** Native Remote: let Bitbots ask the router (UPnP) to forward the port. */
    setNativeUpnp: (enabled: boolean) => run(async () => { await rpc('remote.native.upnp.set', { enabled }) }),
    /** Native Remote: the public address typed by the owner, or null to clear it. */
    setNativeExternalIp: (ip: string | null) => run(async () => { await rpc('remote.native.externalIp.set', { ip }) }),
    /** Native Remote: the elevated firewall prompt; resolves to `added | declined | failed | unsupported`. */
    addFirewallRule: async () => { let result = 'failed'; await run(async () => { result = (await rpc<{ result: string }>('remote.native.firewall.add')).result }); return result },
    removeFirewallRule: async () => { let result = 'failed'; await run(async () => { result = (await rpc<{ result: string }>('remote.native.firewall.remove')).result }); return result },
    /** Preview only: act as the phone submitting the code. */
    simulatePairing: () => run(async () => { await rpc('remote.preview.pair') }),
    dismissPaired: () => setState((current) => ({ ...current, lastOutcome: null })),
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
