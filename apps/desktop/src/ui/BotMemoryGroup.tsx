// The Memory group on the bot page (FIX22 B9): this bot's own notes, read-only,
// and a one-line activity summary from the conversations already loaded. The
// notes come from the daemon's existing `memory.list` (see MemoryPage.tsx); the
// page itself never writes. The rail entry for this group is added by the
// Director in BotPageChrome.tsx: use `MEMORY_SECTION_ID`.

import { useEffect, useState } from 'react'
import type { MemoryRecord, Session } from '../types'
import { isMemoryRecord } from '../types'
import { rpc } from '../tauri'
import { Skeleton } from './Skeleton'
import { useEntityNoun } from './vocabulary'

/** The section id this group renders and the rail entry the Director adds. */
export const MEMORY_SECTION_ID = 'memory'

export interface BotActivity {
  count: number
  lastActiveAt: number | null
}

/** Conversations this bot owns, and the newest activity across them. */
export function botActivity(agentId: string, sessions: readonly Session[] | undefined, _now = Date.now()): BotActivity {
  const owned = (sessions ?? []).filter((session) => session.agentId === agentId)
  let lastActiveAt: number | null = null
  for (const session of owned) {
    const time = Date.parse(session.updatedAt ?? session.createdAt ?? '')
    if (Number.isFinite(time) && (lastActiveAt === null || time > lastActiveAt)) lastActiveAt = time
  }
  return { count: owned.length, lastActiveAt }
}

/** A plain phrase for the last-active column. */
export function lastActiveText(lastActiveAt: number | null, now: number): string {
  if (lastActiveAt === null) return 'no activity yet'
  const delta = Math.max(0, now - lastActiveAt)
  const minute = 60_000
  const hour = 3_600_000
  const day = 86_400_000
  if (delta < minute) return 'just now'
  if (delta < hour) { const minutes = Math.floor(delta / minute); return `${minutes} minute${minutes === 1 ? '' : 's'} ago` }
  if (delta < day) { const hours = Math.floor(delta / hour); return `${hours} hour${hours === 1 ? '' : 's'} ago` }
  const days = Math.floor(delta / day)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export function activityLine(activity: BotActivity, now: number): string {
  if (activity.count === 0) return 'No conversations yet'
  const noun = activity.count === 1 ? 'conversation' : 'conversations'
  return `${activity.count} ${noun} · last active ${lastActiveText(activity.lastActiveAt, now)}`
}

/**
 * This bot's memory notes, read-only. `enabled` follows `experimental.memory`:
 * when it is off the group is not rendered at all. `sessions` is optional so a
 * caller that has no conversations yet still sees the notes.
 */
export function BotMemoryGroup({ agentId, enabled, sessions, onOpenMemory }: {
  agentId: string
  enabled: boolean
  sessions?: readonly Session[]
  onOpenMemory?: () => void
}) {
  const noun = useEntityNoun()
  const [notes, setNotes] = useState<MemoryRecord[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !agentId) { setNotes(null); setProblem(null); return }
    let cancelled = false
    setNotes(null)
    setProblem(null)
    rpc<{ records?: unknown[] }>('memory.list', { scope: 'blob', scopeId: agentId, limit: 50 })
      .then((result) => {
        if (cancelled) return
        setNotes((Array.isArray(result?.records) ? result.records : []).filter(isMemoryRecord))
      })
      .catch((reason) => {
        if (cancelled) return
        setNotes([])
        setProblem(reason instanceof Error ? reason.message : 'Notes could not be loaded.')
      })
    return () => { cancelled = true }
  }, [agentId, enabled])

  if (!enabled || !agentId) return null
  const activity = botActivity(agentId, sessions)

  return <section id={`bot-section-${MEMORY_SECTION_ID}`} className="settings-group blob-group" aria-label="Memory">
    <div className="settings-group-head">
      <h3>Memory</h3>
      {onOpenMemory && <button type="button" className="link-button bot-memory-link" onClick={onOpenMemory}>Open in Settings › Memory</button>}
    </div>
    <div className="settings-card">
      {sessions && <div className="settings-row">
        <span className="settings-row-copy"><strong>Activity</strong><small>{activityLine(activity, Date.now())}</small></span>
      </div>}
      <div className="blob-form">
        <span className="blob-field-label">Notes about this {noun}</span>
        {notes === null && <Skeleton lines={2} />}
        {notes !== null && notes.length === 0 && !problem && <p className="blob-muted bot-memory-empty">No notes yet</p>}
        {notes !== null && notes.length > 0 && <ul className="memory-list bot-memory-list">
          {notes.map((note) => <li key={note.id} className="memory-row">
            <div className="memory-main">
              <strong className="memory-title">{note.pinned && <span className="memory-pin" title="Pinned">★</span>}{note.title}</strong>
              <p className="memory-body">{note.body}</p>
            </div>
          </li>)}
        </ul>}
        {problem && <p className="blob-error" role="alert">{problem}</p>}
      </div>
    </div>
  </section>
}
