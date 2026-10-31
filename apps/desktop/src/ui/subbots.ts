// Phase 8: a bot's sub-bots, as the daemon reports them. The ledger owns each one's status: this
// never invents one, and every sub-bot stays visible until its conversation is gone.
import { useCallback, useEffect, useState } from 'react'
import { listenForDaemonEvents, rpc } from '../tauri'

export type SubbotStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type Subbot = {
  agentId: string
  parentAgentId: string
  originSessionId: string | null
  name: string
  role: string | null
  provider: string | null
  model: string | null
  thinking: string | null
  sessionId: string | null
  delegationId: string | null
  status: SubbotStatus
  doingNow: string | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

const STATUSES: readonly SubbotStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']
const text = (value: unknown) => typeof value === 'string' && value ? value : null

/** Whatever the daemon sent, as complete rows. A row with no bot is left out, and an unknown status isn't guessed at. */
export function normalizeSubbots(raw: unknown): Subbot[] {
  const rows = raw && typeof raw === 'object' ? (raw as { subbots?: unknown }).subbots : null
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row): Subbot[] => {
    const item = row && typeof row === 'object' ? row as Record<string, unknown> : null
    const agentId = text(item?.agentId)
    if (!item || !agentId || !STATUSES.includes(item.status as SubbotStatus)) return []
    return [{
      agentId,
      parentAgentId: text(item.parentAgentId) ?? '',
      originSessionId: text(item.originSessionId),
      name: text(item.name) ?? 'Sub-bot',
      role: text(item.role),
      provider: text(item.provider),
      model: text(item.model),
      thinking: text(item.thinking),
      sessionId: text(item.sessionId),
      delegationId: text(item.delegationId),
      status: item.status as SubbotStatus,
      doingNow: text(item.doingNow),
      startedAt: text(item.startedAt),
      finishedAt: text(item.finishedAt),
      error: text(item.error),
    }]
  })
}

export const isActiveSubbot = (subbot: Pick<Subbot, 'status'>) => subbot.status === 'queued' || subbot.status === 'running'

export const SUBBOT_WORD: Record<SubbotStatus, string> = { queued: 'Waiting for a slot', running: 'Working', completed: 'Done', failed: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted' }

/** The line under a sub-bot: what it's doing now, or where it ended up. */
export function subbotLine(subbot: Subbot): string {
  if (subbot.status === 'running' && subbot.doingNow) return subbot.doingNow
  if (subbot.status === 'failed' && subbot.error) return subbot.error
  return SUBBOT_WORD[subbot.status]
}

/** "2/3 working", counting what's running against everything still in this fleet's run. Null with none, or none active. */
export function fleetCount(subbots: readonly Subbot[]): string | null {
  const active = subbots.filter(isActiveSubbot)
  if (!active.length) return null
  const running = active.filter((item) => item.status === 'running').length
  return `${running}/${subbots.length} working`
}

/** Live first, in the order they started, so a fleet never reshuffles while it works. */
export function orderFleet(subbots: readonly Subbot[]): Subbot[] {
  return [...subbots.filter(isActiveSubbot), ...subbots.filter((item) => !isActiveSubbot(item))]
}

/** One conversation's fleet, or all of a bot's. */
export function useSubbots(scope: { sessionId?: string | null; agentId?: string | null }, active = true): { subbots: Subbot[]; reload: () => void } {
  const [subbots, setSubbots] = useState<Subbot[]>([])
  const sessionId = scope.sessionId ?? null
  const agentId = scope.agentId ?? null
  const reload = useCallback(() => {
    if (!sessionId && !agentId) { setSubbots([]); return }
    void rpc('subbot.list', sessionId ? { sessionId } : { agentId }).then((reply) => setSubbots(normalizeSubbots(reply))).catch(() => undefined)
  }, [sessionId, agentId])
  useEffect(() => {
    if (!active) return
    reload()
    let live = true
    let stop: (() => void) | null = null
    void listenForDaemonEvents((event) => {
      if (event.type !== 'subbot.changed') return
      const payload = (event.payload ?? {}) as { parentAgentId?: unknown; sessionId?: unknown }
      if (payload.sessionId === sessionId || payload.parentAgentId === agentId || (!payload.sessionId && !payload.parentAgentId)) reload()
    }).then((unlisten) => { if (live) stop = unlisten; else unlisten() }).catch(() => undefined)
    return () => { live = false; stop?.() }
  }, [active, reload, sessionId, agentId])
  return { subbots, reload }
}
