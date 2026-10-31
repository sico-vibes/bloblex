// Phase 4: another machine's bots in the sidebar, under that machine's name.
import { useEffect, useRef } from 'react'
import { Laptop } from 'lucide-react'
import type { Agent } from '../types'
import { showMainWindow } from '../tauri'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { agentColorHex } from './agentColor'
import { machineStateWord, type Machine, type MachineBot } from './machines'
import { useEntityNoun } from './vocabulary'
import './machines.css'

/** The look and colour a bot row needs, from what another machine sent. */
const asAgent = (bot: MachineBot) => bot as unknown as Agent

export function MachineBadge({ name }: { name: string }) {
  return <span className="machine-badge" title={`Running on ${name}`}><Laptop size={10} aria-hidden="true" />{name}</span>
}

export function MachineBotRow({ machine, bot, selected, onOpen }: { machine: Machine; bot: MachineBot; selected: boolean; onOpen: () => void }) {
  const offline = machine.state !== 'online'
  return <button type="button" className="machine-bot-row" aria-current={selected ? 'true' : undefined} aria-label={`${bot.name} on ${machine.name}${bot.busy ? ', working' : ''}, read only`} onClick={onOpen}>
    <BlobCanvas decorative color={agentColorHex(bot.color ?? 'mint')} size={20} mini mood={offline ? 'offline' : bot.busy ? 'tool_activity' : 'idle'} look={agentLook(asAgent(bot))} label={bot.name} />
    <span className="machine-bot-copy">
      <strong>{bot.name}</strong>
      <small>{offline ? machineStateWord(machine) : bot.busy ? 'Working' : bot.conversations ? `${bot.conversations} conversation${bot.conversations === 1 ? '' : 's'}` : bot.role || 'Ready'}</small>
    </span>
  </button>
}

export function MachineGroups({ machines, selected, onOpen }: { machines: readonly Machine[]; selected: { machineId: string; botId: string } | null; onOpen: (machine: Machine, bot: MachineBot) => void }) {
  const nouns = useEntityNoun({ plural: true })
  return <>{machines.map((machine) => <section key={machine.id} className="team-group machine-group" aria-label={`${machine.name}, another machine`}>
    <div className="team-group-head static">
      <i className={`machine-group-state ${machine.state}`} title={machineStateWord(machine)} aria-hidden="true" />
      <span className="team-group-title"><span>{machine.name}</span></span>
    </div>
    {machine.state === 'revoked' && <p className="machine-group-note">{machine.name} removed this link. Pair again in Settings, Machines.</p>}
    {machine.state !== 'revoked' && !machine.bots.length && <p className="machine-group-note">{machine.state === 'online' ? `No ${nouns} there yet.` : `${machine.name} can't be reached.`}</p>}
    {machine.state !== 'revoked' && machine.bots.length > 0 && <div className="team-group-rows">
      {machine.bots.map((bot) => <MachineBotRow key={bot.id} machine={machine} bot={bot} selected={selected?.machineId === machine.id && selected.botId === bot.id} onOpen={() => onOpen(machine, bot)} />)}
    </div>}
  </section>)}</>
}

const CHANNEL = 'bitbots-open-machine-bot'

/** The companion opens another machine's bot in the full app, the way it opens Changes. */
export async function openMachineBotInMainWindow(machineId: string, botId: string): Promise<void> {
  await showMainWindow()
  const channel = new BroadcastChannel(CHANNEL)
  channel.postMessage({ machineId, botId })
  channel.close()
}

export function useOpenMachineBotRequests(enabled: boolean, onOpen: (machineId: string, botId: string) => void): void {
  const handler = useRef(onOpen)
  handler.current = onOpen
  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = (event: MessageEvent<{ machineId?: unknown; botId?: unknown }>) => {
      if (typeof event.data?.machineId === 'string' && typeof event.data.botId === 'string') handler.current(event.data.machineId, event.data.botId)
    }
    return () => channel.close()
  }, [enabled])
}
