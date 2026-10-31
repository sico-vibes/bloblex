// Phase 4: other machines, as the daemon reports them. The window never talks to another
// machine: the daemon holds the link and its token, and this only reads what it's told.
import { useEffect, useState } from 'react'
import type { Agent, Project } from '../types'
import { listenForDaemonEvents, rpc } from '../tauri'

export type MachineState = 'online' | 'offline' | 'revoked'
export type MachineTier = 'viewer' | 'chat' | 'operator'

export type MachineBot = {
  id: string
  name: string
  color?: string | null
  outfit?: Agent['outfit']
  look?: Agent['look']
  role?: string | null
  provider?: string | null
  model?: string | null
  busy: boolean
  activeSessionId: string | null
  conversations: number
}

export type Machine = {
  id: string
  name: string
  url: string
  auth: 'code' | 'password'
  fingerprint: string | null
  tier: MachineTier
  pairedAt: string | null
  lastSeenAt: string | null
  state: MachineState
  detail: string | null
  version: string | null
  bots: MachineBot[]
}

export type MachineProbe = { origin: string; reachable: boolean; isBitbots: boolean; auth: 'code' | 'password'; fingerprint: string | null; trusted: boolean }
export type PairJobState = 'pending' | 'approved' | 'rejected' | 'expired' | 'failed' | 'cancelled'
export type PairJob = { id: string; url: string; state: PairJobState; detail: string | null; machine: Machine | null }

export type TakeOverStep = { id: string; status: 'done' | 'failed' | 'skipped'; detail: string | null }
export type TakeOverJob = { id: string; state: 'running' | 'done' | 'failed'; steps: TakeOverStep[]; sessionId: string | null; detail: string | null }
export type TakeOverPreview = {
  ready: boolean
  reason: string | null
  title: string
  bot: { id: string; name: string; provider: string | null; model: string | null; agentId: string | null; willCreate: boolean }
  repo: { identity: string | null; url: string | null; branch: string | null; isWorktree: boolean; hasRemote: boolean }
  uncommitted: number
  commitsAhead: number
  project: Pick<Project, 'id' | 'name'> | null
  needsProject: boolean
  runtimeReady: boolean
}

const text = (value: unknown) => typeof value === 'string' && value ? value : null

function normalizeBot(raw: unknown): MachineBot | null {
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  const id = text(item?.id)
  if (!item || !id) return null
  return {
    id,
    name: text(item.name) ?? 'Bot',
    color: text(item.color),
    outfit: item.outfit as Agent['outfit'],
    look: item.look as Agent['look'],
    role: text(item.role),
    provider: text(item.provider),
    model: text(item.model),
    busy: item.busy === true,
    activeSessionId: text(item.activeSessionId),
    conversations: typeof item.conversations === 'number' ? item.conversations : 0,
  }
}

/** Whatever the daemon sent, as complete rows. A row without an id is left out. */
export function normalizeMachines(raw: unknown): Machine[] {
  const rows = raw && typeof raw === 'object' ? (raw as { machines?: unknown }).machines : null
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row): Machine[] => {
    const item = row && typeof row === 'object' ? row as Record<string, unknown> : null
    const id = text(item?.id)
    if (!item || !id) return []
    return [{
      id,
      name: text(item.name) ?? 'Another machine',
      url: text(item.url) ?? '',
      auth: item.auth === 'password' ? 'password' : 'code',
      fingerprint: text(item.fingerprint),
      tier: item.tier === 'viewer' || item.tier === 'operator' ? item.tier : 'chat',
      pairedAt: text(item.pairedAt),
      lastSeenAt: text(item.lastSeenAt),
      state: item.state === 'online' || item.state === 'revoked' ? item.state : 'offline',
      detail: text(item.detail),
      version: text(item.version),
      bots: Array.isArray(item.bots) ? item.bots.flatMap((bot) => normalizeBot(bot) ?? []) : [],
    }]
  })
}

/** Why this address can't be used, or null. The daemon checks again. */
export function machineUrlProblem(raw: string): string | null {
  const url = raw.trim()
  if (!url) return 'Paste the other machine\'s address.'
  if (!/^https:\/\//i.test(url)) return 'The address must start with https://.'
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) return 'Put no name or password in the address.'
    if (parsed.search || parsed.hash) return 'Use the address on its own.'
  } catch { return 'That doesn\'t look like an address.' }
  return null
}

/** Whether this link may press Take over. Reading needs less. */
export const canTakeOver = (machine: Machine) => machine.state === 'online' && machine.tier === 'operator'

export const machineStateWord = (machine: Machine) => machine.state === 'online' ? 'Online' : machine.state === 'revoked' ? 'Needs pairing again' : 'Can\'t be reached'

/** The bot of another machine that's working, with the machine's name, for a badge. */
export function machineBusyBots(machines: readonly Machine[]): Array<{ machine: Machine; bot: MachineBot }> {
  return machines.flatMap((machine) => machine.state === 'revoked' ? [] : machine.bots.filter((bot) => bot.busy).map((bot) => ({ machine, bot })))
}

/** The other machines, kept current. The daemon's own loop refreshes them. */
export function useMachines(active = true): { machines: Machine[]; selfId: string | null; loaded: boolean; reload: () => Promise<void> } {
  const [machines, setMachines] = useState<Machine[]>([])
  const [selfId, setSelfId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const reload = async () => {
    const reply = await rpc('machine.list', {}).catch(() => null)
    if (reply) setMachines(normalizeMachines(reply))
    setLoaded(true)
  }
  useEffect(() => {
    if (!active) return
    void reload()
    void rpc<{ id?: string }>('machine.self', {}).then((reply) => setSelfId(reply?.id ?? null)).catch(() => undefined)
    let unlisten: (() => void) | null = null
    let live = true
    void listenForDaemonEvents((event) => { if (event.type === 'machine.changed') void reload() }).then((stop) => { if (live) unlisten = stop; else stop() }).catch(() => undefined)
    return () => { live = false; unlisten?.() }
  }, [active])
  return { machines, selfId, loaded, reload }
}
