// FIX29 WP6c §5: the remote transport's envelope, error mapping, pairing calls
// and event-socket behaviour (cursor, dedupe, backoff, resync, sign-out, pause).

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BACKOFF_CAP_MS,
  CURSOR_STORAGE_KEY,
  RemoteCallError,
  backoffDelay,
  codeForStatus,
  createRemoteTransport,
  type RemoteFetch,
  type RemoteFetchInit,
  type RemoteResponse,
  type RemoteSocket,
  type RemoteTransportOptions,
} from './remoteTransport'

class FakeStorage {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null { return this.map.get(key) ?? null }
  setItem(key: string, value: string): void { this.map.set(key, value) }
}

function jsonResponse(body: unknown, status = 200): RemoteResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

class FakeSocket implements RemoteSocket {
  readonly sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(data) }
  close(): void { this.closed = true }
  open(): void { this.onopen?.() }
  message(data: unknown): void { this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }) }
  fail(): void { this.onclose?.() }
}

function socketHarness() {
  const sockets: FakeSocket[] = []
  const factory = (url: string): RemoteSocket => { const socket = new FakeSocket(url); sockets.push(socket); return socket }
  return { sockets, factory }
}

function fakeVisibility(initiallyHidden: boolean) {
  const handlers = new Map<string, Set<() => void>>()
  return {
    hidden: initiallyHidden,
    addEventListener(type: string, handler: () => void) {
      const set = handlers.get(type) ?? new Set<() => void>()
      set.add(handler)
      handlers.set(type, set)
    },
    removeEventListener(type: string, handler: () => void) { handlers.get(type)?.delete(handler) },
    fire(type: string) { for (const handler of [...(handlers.get(type) ?? [])]) handler() },
  }
}

interface Harness {
  transport: ReturnType<typeof createRemoteTransport>
  calls: Array<{ url: string; init: RemoteFetchInit }>
  storage: FakeStorage
  sockets: FakeSocket[]
}

function harness(
  respond: (url: string, init: RemoteFetchInit) => RemoteResponse | Promise<RemoteResponse>,
  extra: Partial<RemoteTransportOptions> = {},
): Harness {
  const calls: Array<{ url: string; init: RemoteFetchInit }> = []
  const storage = extra.storage === undefined ? new FakeStorage() : (extra.storage as FakeStorage)
  const { sockets, factory } = socketHarness()
  const fetchImpl: RemoteFetch = async (url, init) => { calls.push({ url, init }); return respond(url, init) }
  const transport = createRemoteTransport({
    fetch: fetchImpl,
    socket: factory,
    storage,
    location: { protocol: 'https:', host: 'work-pc.example-tailnet.ts.net' },
    random: () => 0,
    ...extra,
  })
  return { transport, calls, storage, sockets }
}

const okResult = (result: unknown) => jsonResponse({ v: 1, id: 'req', ok: true, result })
const errResult = (code: string, status = 400) => jsonResponse({ v: 1, id: 'req', ok: false, error: { code, message: `denied: ${code}` } }, status)

afterEach(() => { vi.useRealTimers() })

describe('remoteTransport rpc', () => {
  it('sends a v1 daemon envelope with a same-origin credential', async () => {
    const { transport, calls } = harness(() => okResult({ sessions: [] }))
    const result = await transport.rpc('session.list', { includeArchived: true })

    expect(result).toEqual({ sessions: [] })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/rpc')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.credentials).toBe('same-origin')
    expect(calls[0].init.headers?.['content-type']).toBe('application/json')
    const envelope = JSON.parse(calls[0].init.body ?? '{}') as Record<string, unknown>
    expect(envelope.v).toBe(1)
    expect(envelope.method).toBe('session.list')
    expect(envelope.params).toEqual({ includeArchived: true })
    expect(typeof envelope.id).toBe('string')
    expect((envelope.id as string).length).toBeGreaterThan(0)
  })

  it('defaults params to an empty object and gives each call its own id', async () => {
    const { transport, calls } = harness(() => okResult(null))
    await transport.rpc('daemon.health')
    await transport.rpc('daemon.health')
    const first = JSON.parse(calls[0].init.body ?? '{}') as Record<string, unknown>
    const second = JSON.parse(calls[1].init.body ?? '{}') as Record<string, unknown>
    expect(first.params).toEqual({})
    expect(first.id).not.toBe(second.id)
  })

  it('keeps every gateway error code distinct', async () => {
    const codes = ['unauthorized', 'device_revoked', 'forbidden_remote', 'tier_required', 'approvals_disabled', 'quiet_hours', 'invalid_params', 'payload_too_large', 'rate_limited']
    for (const code of codes) {
      const { transport } = harness(() => errResult(code, code === 'unauthorized' ? 401 : 400))
      await expect(transport.rpc('session.list')).rejects.toMatchObject({ code, message: `denied: ${code}` })
    }
  })

  it('maps a bare HTTP failure by status', async () => {
    const { transport } = harness(() => jsonResponse(null, 429))
    await expect(transport.rpc('session.list')).rejects.toMatchObject({ code: 'rate_limited', status: 429 })
  })

  it('reports an unreachable host as a network error', async () => {
    const { transport } = harness(() => { throw new Error('offline') })
    const failure = await transport.rpc('session.list').catch((reason: unknown) => reason)
    expect(failure).toBeInstanceOf(RemoteCallError)
    expect(failure).toMatchObject({ code: 'network', status: 0 })
  })

  it('derives a code from an HTTP status when no envelope came back', () => {
    expect(codeForStatus(401)).toBe('unauthorized')
    expect(codeForStatus(403)).toBe('forbidden_remote')
    expect(codeForStatus(413)).toBe('payload_too_large')
    expect(codeForStatus(429)).toBe('rate_limited')
    expect(codeForStatus(500)).toBe('network')
  })
})

describe('remoteTransport pairing and session', () => {
  it('posts the pairing request and reports the state', async () => {
    const { transport, calls } = harness(() => jsonResponse({ state: 'pending' }, 202))
    const paired = await transport.pair({ code: 'K7QM-4XPD', name: 'Pixel 8', kind: 'phone', platform: 'Android, Chrome' })
    expect(paired).toEqual({ state: 'pending' })
    expect(calls[0].url).toBe('/api/pair')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(calls[0].init.body ?? '{}')).toEqual({ code: 'K7QM-4XPD', name: 'Pixel 8', kind: 'phone', platform: 'Android, Chrome' })
  })

  it('polls pairing with a GET and normalizes the answer', async () => {
    const { transport, calls } = harness(() => jsonResponse({ state: 'approved' }))
    expect(await transport.pairStatus()).toBe('approved')
    expect(calls[0].url).toBe('/api/pair')
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.credentials).toBe('same-origin')
  })

  it('accepts a bare state string and treats anything odd as pending', async () => {
    const bare = harness(() => jsonResponse('expired'))
    expect(await bare.transport.pairStatus()).toBe('expired')
    const odd = harness(() => jsonResponse({ state: 'whatever' }))
    expect(await odd.transport.pairStatus()).toBe('pending')
  })

  it('reads /api/me', async () => {
    const me = { protocolVersion: 1, device: { id: 'd1', name: 'Pixel 8', tier: 'chat' }, host: { name: 'Work PC' }, approvalsFromRemote: false, quietHoursActive: true }
    const { transport, calls } = harness(() => jsonResponse(me))
    expect(await transport.me()).toEqual(me)
    expect(calls[0].url).toBe('/api/me')
    expect(calls[0].init.method).toBe('GET')
  })

  it('signs out, clears the cursor and refuses later calls', async () => {
    const storage = new FakeStorage()
    storage.setItem(CURSOR_STORAGE_KEY, '900')
    const { transport, calls } = harness(() => okResult({ signedOut: true }), { storage })
    await transport.logout()
    expect(calls[0].url).toBe('/api/logout')
    expect(calls[0].init.method).toBe('POST')
    expect(transport.signedOut()).toBe(true)
    expect(transport.connectionStatus()).toBe('signed_out')
    expect(transport.getCursor()).toBe(0)
    await expect(transport.rpc('session.list')).rejects.toMatchObject({ code: 'device_revoked' })
  })

  it('does not treat a failed pairing request as a sign-out', async () => {
    const { transport } = harness(() => errResult('pairing_invalid', 401))
    await expect(transport.pair({ code: 'WRNG-0000', name: 'Pixel', kind: 'phone', platform: 'Android' })).rejects.toMatchObject({ code: 'pairing_invalid' })
    expect(transport.signedOut()).toBe(false)
  })
})

describe('remoteTransport events', () => {
  it('opens /api/events and sends the stored cursor first', () => {
    const storage = new FakeStorage()
    storage.setItem(CURSOR_STORAGE_KEY, '42')
    const { transport, sockets } = harness(() => okResult(null), { storage })
    const statuses: string[] = []
    transport.events(() => undefined, (status) => statuses.push(status))

    expect(sockets).toHaveLength(1)
    expect(sockets[0].url).toBe('wss://work-pc.example-tailnet.ts.net/api/events')
    sockets[0].open()
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ v: 1, afterSequence: 42 })
    expect(statuses).toEqual(['connecting', 'online'])
  })

  it('ignores duplicate sequences and persists the highest one', () => {
    const storage = new FakeStorage()
    const { transport, sockets } = harness(() => okResult(null), { storage })
    const events: Array<Record<string, unknown>> = []
    transport.events((event) => events.push(event as Record<string, unknown>), () => undefined)
    sockets[0].open()

    sockets[0].message({ v: 1, sequence: 5, type: 'session.changed' })
    sockets[0].message({ v: 1, sequence: 5, type: 'session.changed' })
    sockets[0].message({ v: 1, sequence: 6, type: 'message.completed' })
    sockets[0].message({ v: 1, sequence: 4, type: 'agent.changed' })

    expect(events.map((event) => event.sequence)).toEqual([5, 6])
    expect(storage.getItem(CURSOR_STORAGE_KEY)).toBe('6')
    expect(transport.getCursor()).toBe(6)
  })

  it('keeps malformed frames away from the handler', () => {
    const { transport, sockets } = harness(() => okResult(null))
    const handler = vi.fn()
    transport.events(handler, () => undefined)
    sockets[0].open()
    sockets[0].message('not json')
    sockets[0].message({ v: 1, noType: true })
    expect(handler).not.toHaveBeenCalled()
  })

  it('applies a snapshot cursor after a resync', () => {
    const { transport } = harness(() => okResult(null))
    transport.setCursor(1234)
    expect(transport.getCursor()).toBe(1234)
    transport.setCursor(Number.NaN)
    expect(transport.getCursor()).toBe(0)
  })

  it('grows the backoff from 1 s and caps it at 30 s', () => {
    expect(backoffDelay(0, () => 0)).toBe(1000)
    expect(backoffDelay(1, () => 0)).toBe(2000)
    expect(backoffDelay(4, () => 0)).toBe(16000)
    expect(backoffDelay(5, () => 0)).toBe(BACKOFF_CAP_MS)
    expect(backoffDelay(20, () => 1)).toBe(BACKOFF_CAP_MS)
  })

  it('schedules the first reconnect at one second and waits longer after that', () => {
    vi.useFakeTimers()
    const { transport, sockets } = harness(() => okResult(null))
    const statuses: string[] = []
    transport.events(() => undefined, (status) => statuses.push(status))

    sockets[0].open()
    sockets[0].fail()
    expect(statuses.at(-1)).toBe('reconnecting')

    vi.advanceTimersByTime(999)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)

    sockets[1].fail()
    vi.advanceTimersByTime(1999)
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(3)
  })

  it('resets the backoff after the socket has been healthy for 30 s', () => {
    vi.useFakeTimers()
    const { transport, sockets } = harness(() => okResult(null))
    transport.events(() => undefined, () => undefined)

    sockets[0].open()
    sockets[0].fail()
    vi.advanceTimersByTime(1000)
    expect(sockets).toHaveLength(2)

    sockets[1].open()
    vi.advanceTimersByTime(30_000)
    sockets[1].fail()

    // A healthy socket resets the attempt, so the next wait is 1 s again.
    vi.advanceTimersByTime(999)
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(3)
  })

  it('calls onResync for a replay gap and for replayAvailable:false', () => {
    const onResync = vi.fn()
    const { transport, sockets } = harness(() => okResult(null), { onResync })
    transport.events(() => undefined, () => undefined)
    sockets[0].open()

    sockets[0].message({ v: 1, sequence: 7, type: 'messages.completed' })
    sockets[0].message({ v: 1, type: 'replay.gap' })
    expect(onResync).toHaveBeenCalledTimes(1)

    sockets[0].message({ v: 1, replayAvailable: false, earliestSequence: 3 })
    expect(onResync).toHaveBeenCalledTimes(2)
  })

  it('goes to signed_out on an unauthorized call and stops reconnecting', async () => {
    vi.useFakeTimers()
    const { transport, sockets } = harness(() => errResult('unauthorized', 401))
    const statuses: string[] = []
    transport.events(() => undefined, (status) => statuses.push(status))
    sockets[0].open()

    await expect(transport.rpc('app.snapshot')).rejects.toMatchObject({ code: 'unauthorized' })
    expect(statuses.at(-1)).toBe('signed_out')
    expect(sockets[0].closed).toBe(true)

    vi.advanceTimersByTime(120_000)
    expect(sockets).toHaveLength(1)
  })

  it('pauses on a hidden page and reconnects when it becomes visible', () => {
    vi.useFakeTimers()
    const visibility = fakeVisibility(true)
    const { transport, sockets } = harness(() => okResult(null), { visibility })
    const statuses: string[] = []
    transport.events(() => undefined, (status) => statuses.push(status))

    expect(sockets).toHaveLength(0)
    expect(statuses.at(-1)).toBe('offline')

    visibility.hidden = false
    visibility.fire('visibilitychange')
    expect(sockets).toHaveLength(1)

    visibility.hidden = true
    visibility.fire('visibilitychange')
    expect(sockets[0].closed).toBe(true)
    vi.advanceTimersByTime(120_000)
    expect(sockets).toHaveLength(1)
  })

  it('stops the socket when the last listener unsubscribes', () => {
    const { transport, sockets } = harness(() => okResult(null))
    const stop = transport.events(() => undefined, () => undefined)
    sockets[0].open()
    stop()
    expect(sockets[0].closed).toBe(true)
  })
})

describe('backoff shape', () => {
  it('never returns less than the base or more than the cap', () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      expect(backoffDelay(attempt, () => 0)).toBeGreaterThanOrEqual(1000)
      expect(backoffDelay(attempt, () => 1)).toBeLessThanOrEqual(BACKOFF_CAP_MS)
    }
  })

  it('is non-decreasing with the attempt count', () => {
    let previous = 0
    for (let attempt = 0; attempt < 8; attempt++) {
      const delay = backoffDelay(attempt, () => 0)
      expect(delay).toBeGreaterThanOrEqual(previous)
      previous = delay
    }
  })
})
