// Phase 6: what the bot ran in this conversation, read-only, beside the owner's own terminals.
import { useEffect, useMemo, useRef } from 'react'
import type { Session } from '../types'
import { activityTitle } from './ActivityDetails'
import { buildConversationItems } from './conversation'

type Row = { id: string; command: string; output: string; running: boolean; failed: boolean }

const text = (value: unknown) => typeof value === 'string' ? value : ''

/** The conversation's commands, oldest first. Anything else the bot did stays out. */
export function botCommands(session: Session | null | undefined): Row[] {
  if (!session) return []
  return buildConversationItems(session).flatMap((item): Row[] => {
    if (item.kind !== 'activity' || item.activityKind === 'turn') return []
    const activity = (item.activity ?? {}) as Record<string, unknown>
    const detail = (activity.detail && typeof activity.detail === 'object' ? activity.detail : {}) as Record<string, unknown>
    const input = (activity.input && typeof activity.input === 'object' ? activity.input : {}) as Record<string, unknown>
    const command = text(detail.command) || text(input.command)
    if (!command) return []
    const state = String(activity.state ?? '').toLowerCase()
    return [{ id: item.id, command, output: text(detail.output) || text(activity.output), running: ['running', 'working', 'started'].includes(state), failed: ['failed', 'error'].includes(state) }]
  })
}

export function BotCommands({ session, botName }: { session: Session | null | undefined; botName: string }) {
  const rows = useMemo(() => botCommands(session), [session])
  const box = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)
  useEffect(() => { const node = box.current; if (node && pinned.current) node.scrollTop = node.scrollHeight }, [rows])
  if (!rows.length) return <div className="terminal-empty">{botName} hasn't run a command in this conversation yet.</div>
  return <div ref={box} className="bot-commands" tabIndex={0} aria-label={`Commands ${botName} ran, read only`} onScroll={(event) => { const node = event.currentTarget; pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48 }}>
    {rows.map((row) => <article key={row.id} className={`bot-command${row.failed ? ' failed' : ''}`}>
      <code><span aria-hidden="true">$ </span>{row.command}</code>
      {row.output && <pre>{row.output}</pre>}
      {row.running && <small role="status">Running…</small>}
      {row.failed && <small>It failed.</small>}
    </article>)}
  </div>
}

export { activityTitle }
