// The remote client's one way of talking to a host: the gateway's HTTP routes
// (`/api/rpc`, `/api/me`, `/api/pair`, `/api/logout`) and the events socket
// (`/api/events`). Same-origin only: the device cookie is `HttpOnly`, so this
// module never sees it and always asks the browser to attach it
// (`credentials: 'same-origin'`).
//
// Spec: docs/remote/PROTOCOL.md §3, §4.3-4.4, §6 and §11; FIX29 WP6c.
//
// Everything is injectable (`fetch`, the socket factory, storage, timers, a
// clock and a random source) so the module is pure enough to test without a
// host, a browser or a network.

import type { DaemonEvent, JsonRecord } from '../types'
import type { RemoteTier } from './remoteContract'

/** What the events socket is doing right now. */
export type RemoteConnectionStatus = 'connecting' | 'online' | 'reconnecting' | 'offline' | 'signed_out'

/**
 * The gateway codes this client keeps distinct (PROTOCOL §3), plus `network`
 * for a request that never reached the gateway. Any other daemon code is
 * carried through unchanged.
 */
export type RemoteErrorCode =
  | 'unauthorized'
  | 'device_revoked'
  | 'forbidden_remote'
  | 'tier_required'
  | 'approvals_disabled'
  | 'quiet_hours'
  | 'invalid_params'
  | 'payload_too_large'
  | 'rate_limited'
  | 'network'

export type RemotePairState = 'pending' | 'approved' | 'rejected' | 'expired'
export type RemoteDeviceKind = 'phone' | 'tablet' | 'browser' | 'computer'

/** `GET /api/me` (PROTOCOL §4.4). */
export interface RemoteMe {
  protocolVersion: number
  device: { id: string; name: string; tier: RemoteTier }
  host: { name: string }
  approvalsFromRemote: boolean
  quietHoursActive: boolean
}

export interface RemotePairInput {
  code: string
  name: string
  kind: RemoteDeviceKind
  platform: string
}

/** A refused call: `ok:false` in the envelope, or an HTTP/transport failure. */
export class RemoteCallError extends Error {
  readonly code: RemoteErrorCode | string
  readonly status: number
  constructor(code: string, message: string, status = 0) {
    super(message)
    this.name = 'RemoteCallError'
    this.code = code
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Injectable shapes. Plain interfaces keep the fakes in tests obvious.

export interface RemoteResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export interface RemoteFetchInit {
  method: string
  credentials: 'same-origin'
  headers?: Record<string, string>
  body?: string
}

export type RemoteFetch = (input: string, init: RemoteFetchInit) => Promise<RemoteResponse>

export interface RemoteSocket {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

export type RemoteSocketFactory = (url: string) => RemoteSocket

export interface RemoteStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface RemoteVisibility {
  hidden: boolean
  addEventListener(type: string, handler: () => void): void
  removeEventListener(type: string, handler: () => void): void
}

export interface RemoteTransportOptions {
  fetch?: RemoteFetch
  /** Builds the events socket. Defaults to the browser `WebSocket`. */
  socket?: RemoteSocketFactory
  /** Defaults to `localStorage` when it exists. */
  storage?: RemoteStorage | null
  /** Defaults to `document`; used for the hidden-page pause. */
  visibility?: RemoteVisibility | null
  /** Where the socket is opened. Defaults to `location`. */
  location?: { protocol: string; host: string } | null
  /** Defaults to `navigator.onLine` (true when there is no navigator). */
  online?: () => boolean
  setTimer?: (handler: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  now?: () => number
  random?: () => number
  /** Called on `replay.gap` / `replayAvailable:false`; refetch `app.snapshot` and `setCursor`. */
  onResync?: () => void
}

export interface RemoteTransport {
  rpc<T>(method: string, params?: JsonRecord): Promise<T>
  me(): Promise<RemoteMe>
  pair(input: RemotePairInput): Promise<{ state: RemotePairState }>
  pairStatus(): Promise<RemotePairState>
  logout(): Promise<void>
  /** Opens (or reuses) the events socket. Returns an unsubscribe function. */
  events(handler: (event: DaemonEvent) => void, status: (status: RemoteConnectionStatus) => void): () => void
  /** Applies a fresh snapshot sequence after a resync. */
  setCursor(sequence: number): void
  getCursor(): number
  connectionStatus(): RemoteConnectionStatus
  signedOut(): boolean
  dispose(): void
}

export const CURSOR_STORAGE_KEY = 'bitbots.remote.cursor'
export const PROTOCOL_VERSION = 1

/** Backoff base and cap for the events socket, and the healthy period. */
export const BACKOFF_BASE_MS = 1_000
export const BACKOFF_CAP_MS = 30_000
export const HEALTHY_PERIOD_MS = 30_000

/**
 * Backoff with jitter: doubles from 1 s per attempt and never rises above 30 s.
 * `random` is injected so the shape is testable; it adds up to 250 ms.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const safeAttempt = Math.max(0, Math.floor(attempt))
  const grown = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** safeAttempt)
  const jitter = Math.floor(Math.min(1, Math.max(0, random())) * 250)
  return Math.min(BACKOFF_CAP_MS, grown + jitter)
}

/** HTTP status → gateway code when the body carries no envelope. */
export function codeForStatus(status: number): RemoteErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden_remote'
  if (status === 413) return 'payload_too_large'
  if (status === 429) return 'rate_limited'
  return 'network'
}

const DEFAULT_MESSAGES: Partial<Record<RemoteErrorCode, string>> = {
  unauthorized: 'This device is not signed in to the host.',
  device_revoked: 'This device was removed. Pair it again to continue.',
  forbidden_remote: 'That is not available to a remote device.',
  tier_required: 'This device needs a higher permission level for that.',
  approvals_disabled: 'Approvals from remote devices are switched off on the host.',
  quiet_hours: 'Quiet hours are on: the host is read-only right now.',
  invalid_params: 'The host refused the request parameters.',
  payload_too_large: 'That request was too large for the host.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  network: 'Could not reach your computer.',
}

function defaultMessage(code: string): string {
  return DEFAULT_MESSAGES[code as RemoteErrorCode] ?? 'The host refused the call.'
}

function messageOf(reason: unknown): string {
  if (reason && typeof reason === 'object' && 'message' in reason) {
    const message = (reason as { message: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return 'Could not reach your computer.'
}

function isAuthCode(code: string): boolean {
  return code === 'unauthorized' || code === 'device_revoked'
}

function defaultFetch(input: string, init: RemoteFetchInit): Promise<RemoteResponse> {
  return fetch(input, init) as unknown as Promise<RemoteResponse>
}

function defaultSocket(url: string): RemoteSocket {
  return new WebSocket(url) as unknown as RemoteSocket
}

function defaultLocation(): { protocol: string; host: string } | null {
  return typeof location === 'undefined' ? null : { protocol: location.protocol, host: location.host }
}

function defaultVisibility(): RemoteVisibility | null {
  return typeof document === 'undefined' ? null : (document as unknown as RemoteVisibility)
}

function defaultStorage(): RemoteStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Anything other than the four pairing states is treated as still pending. */
function normalizePairState(value: unknown): RemotePairState {
  const state = typeof value === 'string' ? value : (value as { state?: unknown } | null)?.state
  return state === 'approved' || state === 'rejected' || state === 'expired' ? state : 'pending'
}

export function createRemoteTransport(options: RemoteTransportOptions = {}): RemoteTransport {
  const doFetch = options.fetch ?? defaultFetch
  const makeSocket = options.socket ?? defaultSocket
  const storage = options.storage === undefined ? defaultStorage() : options.storage
  const visibility = options.visibility === undefined ? defaultVisibility() : options.visibility
  const host = options.location === undefined ? defaultLocation() : options.location
  const isOnline = options.online ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false)
  const setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? Math.random

  let serial = 0
  let cursor = readCursor()
  let disposed = false
  let isSignedOut = false
  let connection: RemoteConnectionStatus = 'connecting'

  function readCursor(): number {
    try {
      const raw = storage?.getItem(CURSOR_STORAGE_KEY) ?? null
      const parsed = raw === null ? 0 : Number.parseInt(raw, 10)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    } catch {
      return 0
    }
  }

  function writeCursor(): void {
    try {
      storage?.setItem(CURSOR_STORAGE_KEY, String(cursor))
    } catch {
      // Private mode or a full quota: the cursor stays in memory only.
    }
  }

  function nextId(): string {
    serial += 1
    return `req_${serial.toString(36)}`
  }

  function enterSignedOut(): void {
    if (isSignedOut) return
    isSignedOut = true
    cursor = 0
    writeCursor()
    if (statusListener) {
      connection = 'signed_out'
      statusListener('signed_out')
    }
    stopSocket()
  }

  async function readEnvelope(response: RemoteResponse): Promise<unknown> {
    let data: unknown = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    if (data && typeof data === 'object' && 'ok' in data) {
      const envelope = data as { ok: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }
      if (envelope.ok === true) return envelope.result
      const code = typeof envelope.error?.code === 'string' ? envelope.error.code : codeForStatus(response.status)
      const message = typeof envelope.error?.message === 'string' && envelope.error.message ? envelope.error.message : defaultMessage(code)
      throw new RemoteCallError(code, message, response.status)
    }
    if (!response.ok) {
      const code = codeForStatus(response.status)
      throw new RemoteCallError(code, defaultMessage(code), response.status)
    }
    return data
  }

  async function send(path: string, method: string, body?: JsonRecord): Promise<unknown> {
    if (isSignedOut && path !== '/api/pair' && path !== '/api/logout') {
      throw new RemoteCallError('device_revoked', defaultMessage('device_revoked'), 401)
    }
    let response: RemoteResponse
    try {
      response = await doFetch(path, {
        method,
        credentials: 'same-origin',
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
    } catch (reason) {
      throw new RemoteCallError('network', messageOf(reason), 0)
    }
    try {
      return await readEnvelope(response)
    } catch (reason) {
      // `/api/pair` runs without the device cookie, so a failure there is never
      // a sign-out; every other 401 means the device's cookie is no longer good.
      if (reason instanceof RemoteCallError && isAuthCode(reason.code) && path !== '/api/pair') enterSignedOut()
      throw reason
    }
  }

  // --- events socket -------------------------------------------------------

  let socket: RemoteSocket | null = null
  let statusListener: ((status: RemoteConnectionStatus) => void) | null = null
  let eventHandler: ((event: DaemonEvent) => void) | null = null
  let attempt = 0
  let reconnectTimer: unknown = null
  let healthyTimer: unknown = null
  let openedAt = 0
  let paused = false
  let unsubscribed = true

  function setStatus(next: RemoteConnectionStatus): void {
    connection = next
    statusListener?.(next)
  }

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimer(reconnectTimer)
      reconnectTimer = null
    }
  }

  function clearHealthy(): void {
    if (healthyTimer !== null) {
      clearTimer(healthyTimer)
      healthyTimer = null
    }
  }

  function socketUrl(): string {
    const scheme = host?.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${scheme}//${host?.host ?? ''}/api/events`
  }

  function openSocket(): void {
    if (disposed || isSignedOut || paused || socket) return
    setStatus(connection === 'online' ? 'online' : attempt === 0 ? 'connecting' : 'reconnecting')
    let next: RemoteSocket
    try {
      next = makeSocket(socketUrl())
    } catch {
      scheduleReconnect()
      return
    }
    socket = next
    next.onopen = () => {
      if (socket !== next) return
      openedAt = now()
      setStatus('online')
      clearHealthy()
      healthyTimer = setTimer(() => {
        healthyTimer = null
        if (now() - openedAt >= HEALTHY_PERIOD_MS - 1) attempt = 0
      }, HEALTHY_PERIOD_MS)
      try {
        next.send(JSON.stringify({ v: PROTOCOL_VERSION, afterSequence: cursor }))
      } catch {
        // The socket will close and the reconnect path takes over.
      }
    }
    next.onmessage = (event) => handleMessage(event.data)
    next.onclose = () => {
      if (socket === next) socket = null
      clearHealthy()
      scheduleReconnect()
    }
    next.onerror = () => {
      // `close` always follows; the reconnect path lives there.
    }
  }

  function stopSocket(): void {
    clearReconnect()
    clearHealthy()
    const current = socket
    socket = null
    if (current) {
      current.onopen = null
      current.onmessage = null
      current.onclose = null
      current.onerror = null
      try {
        current.close()
      } catch {
        // Nothing useful to do when a closed socket refuses to close.
      }
    }
  }

  function scheduleReconnect(): void {
    if (disposed || isSignedOut || paused || unsubscribed) return
    if (visibility?.hidden) {
      setStatus('offline')
      return
    }
    if (!isOnline()) {
      setStatus('offline')
      return
    }
    setStatus('reconnecting')
    const delay = backoffDelay(attempt, random)
    attempt += 1
    clearReconnect()
    reconnectTimer = setTimer(() => {
      reconnectTimer = null
      openSocket()
    }, delay)
  }

  function handleMessage(raw: unknown): void {
    let data: unknown
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw))
    } catch {
      return
    }
    if (!data || typeof data !== 'object') return
    const message = data as Record<string, unknown>
    if (message.replayAvailable === false) {
      options.onResync?.()
      return
    }
    const sequence = typeof message.sequence === 'number' ? message.sequence : null
    if (sequence !== null) {
      if (sequence <= cursor) return // The daemon may replay sequences we already applied.
      cursor = sequence
      writeCursor()
    }
    if (typeof message.type === 'string') eventHandler?.(message as DaemonEvent)
    if (message.type === 'replay.gap') options.onResync?.()
  }

  function onVisibilityChange(): void {
    if (disposed || isSignedOut) return
    if (visibility?.hidden) {
      paused = true
      stopSocket()
      setStatus('offline')
      return
    }
    paused = false
    clearReconnect()
    openSocket()
  }

  function onOnline(): void {
    if (disposed || isSignedOut) return
    paused = false
    clearReconnect()
    openSocket()
  }

  return {
    async rpc<T>(method: string, params: JsonRecord = {}): Promise<T> {
      const envelope: JsonRecord = { v: PROTOCOL_VERSION, id: nextId(), method, params }
      return (await send('/api/rpc', 'POST', envelope)) as T
    },

    async me(): Promise<RemoteMe> {
      return (await send('/api/me', 'GET')) as RemoteMe
    },

    async pair(input: RemotePairInput): Promise<{ state: RemotePairState }> {
      const result = await send('/api/pair', 'POST', {
        code: input.code,
        name: input.name,
        kind: input.kind,
        platform: input.platform,
      })
      return { state: normalizePairState(result) }
    },

    async pairStatus(): Promise<RemotePairState> {
      return normalizePairState(await send('/api/pair', 'GET'))
    },

    async logout(): Promise<void> {
      try {
        await send('/api/logout', 'POST')
      } catch (reason) {
        // Signing out locally must not depend on the host answering.
        if (!(reason instanceof RemoteCallError)) throw reason
      }
      enterSignedOut()
    },

    events(handler, status) {
      eventHandler = handler
      statusListener = status
      unsubscribed = false
      visibility?.addEventListener('visibilitychange', onVisibilityChange)
      if (typeof globalThis.addEventListener === 'function') globalThis.addEventListener('online', onOnline)
      if (isSignedOut) {
        setStatus('signed_out')
        return () => undefined
      }
      paused = visibility?.hidden === true
      if (paused) setStatus('offline')
      else openSocket()
      return () => {
        unsubscribed = true
        eventHandler = null
        statusListener = null
        visibility?.removeEventListener('visibilitychange', onVisibilityChange)
        if (typeof globalThis.removeEventListener === 'function') globalThis.removeEventListener('online', onOnline)
        stopSocket()
      }
    },

    setCursor(sequence: number): void {
      cursor = Number.isFinite(sequence) && sequence > 0 ? Math.floor(sequence) : 0
      writeCursor()
    },

    getCursor(): number {
      return cursor
    },

    connectionStatus(): RemoteConnectionStatus {
      return isSignedOut ? 'signed_out' : connection
    },

    signedOut(): boolean {
      return isSignedOut
    },

    dispose(): void {
      disposed = true
      unsubscribed = true
      eventHandler = null
      statusListener = null
      visibility?.removeEventListener('visibilitychange', onVisibilityChange)
      if (typeof globalThis.removeEventListener === 'function') globalThis.removeEventListener('online', onOnline)
      stopSocket()
    },
  }
}
