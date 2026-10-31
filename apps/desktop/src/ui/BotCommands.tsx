// Phase 6: what the bot ran in this conversation, read-only, beside the owner's own terminals.
import { useEffect, useMemo, useRef } from 'react'
import type { Session } from '../types'
import { detailOf, stateOf } from './ActivityDetails'
import { activityCategory, activityInput, buildConversationItems } from './conversation'
import { maskSecrets } from './liveOutput'

type Row = { id: string; command: string; output: string; running: boolean; failed: boolean }

const text = (value: unknown) => typeof value === 'string' ? value : ''

/** The conversation's commands, oldest first, with possible keys and passwords hidden as in the step view. */
export function botCommands(session: Session | null | undefined): Row[] {
  if (!session) return []
  return buildConversationItems(session).flatMap((item): Row[] => {
    if (item.kind !== 'activity' || activityCategory(item) !== 'command') return []
    const detail = detailOf(item)
    const command = text(detail.command) || text(activityInput(item).command)
    if (!command) return []
    const state = stateOf(item)
    return [{ id: item.id, command: maskSecrets(command).text, output: maskSecrets(text(detail.output)).text, running: state === 'running', failed: state === 'failed' }]
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

