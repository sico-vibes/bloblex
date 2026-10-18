import { useEffect, useState } from 'react'
import { rpc } from '../tauri'
import { daemonCodeOf } from './agentForm'

export type BusySendMode = 'steer' | 'queue'
export const BUSY_SEND_SETTING = 'composer.busySendMode'
export const busySendMode = (value: unknown): BusySendMode => value === 'queue' ? 'queue' : 'steer'

/** Resend only a definitive refusal; an ambiguous provider failure may have delivered it. */
export async function sendWithDelivery(method: string, params: Record<string, unknown>): Promise<{ queued: boolean; fallback: boolean }> {
  try {
    const result = await rpc<{ queued?: boolean }>(method, params)
    const fallback = method === 'session.steer' && result?.queued === true
    return { queued: method === 'session.queue.add' || fallback, fallback }
  } catch (reason) {
    if (method !== 'session.steer' || !['unsupported', 'conflict'].includes(daemonCodeOf(reason) ?? '')) throw reason
    await rpc('session.queue.add', params)
    return { queued: true, fallback: true }
  }
}

/** Only a live turn can be steered, so probe the provider's capability then. */
const STEER_PROBE_STATES = ['working', 'starting', 'waiting_permission']
export function steerRuntimeId(state: string | undefined, runtimeId: string | undefined): string | undefined {
  return STEER_PROBE_STATES.includes(state ?? '') ? runtimeId : undefined
}

/** Capability replies belong to a runtime and are invalid as soon as it changes. */
export function useSteerAvailable(runtimeId: string | undefined, connected: boolean, revision: unknown) {
  const [capability, setCapability] = useState<{ runtimeId: string; available: boolean } | null>(null)
  useEffect(() => {
    setCapability(null)
    if (!runtimeId || !connected) return
    let active = true
    void rpc<{ settings?: { steer?: { supported?: boolean; enabled?: boolean } } }>('runtime.capabilities', { runtimeId }).then(caps => {
      if (active) setCapability({ runtimeId, available: caps.settings?.steer?.supported === true && caps.settings.steer.enabled === true })
    }).catch(() => undefined)
    return () => { active = false }
  }, [runtimeId, connected, revision])
  return connected && capability?.runtimeId === runtimeId && capability?.available === true
}

export function busyDelivery(mode: BusySendMode, opposite: boolean, state: string | undefined, supported: boolean, hasContext = false): { mode: BusySendMode; reason: string | null } {
  const wanted = opposite ? mode === 'steer' ? 'queue' : 'steer' : mode
  if (wanted === 'queue') return { mode: 'queue', reason: null }
  if (!supported) return { mode: 'queue', reason: 'Steering is unavailable for this coding agent. Your message waits for the turn to end.' }
  if (state !== 'working') return { mode: 'queue', reason: 'Steering waits until the bot is working. Your message is queued.' }
  if (hasContext) return { mode: 'queue', reason: 'Messages with attachments, commands or references are queued to keep their context.' }
  return { mode: 'steer', reason: null }
}
