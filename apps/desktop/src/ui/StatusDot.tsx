import './statusDot.css'

/** The one status vocabulary: what a bot is doing, as a mark and a word. */
export type BotStatus = 'working' | 'waiting' | 'attention' | 'failed' | 'idle' | 'offline'

const WORDS: Record<BotStatus, string> = {
  working: 'Working',
  waiting: 'Waiting for you',
  attention: 'Needs attention',
  failed: 'Failed',
  idle: 'Idle',
  offline: 'Offline',
}

/**
 * A status mark. docs/design/design-system.md says dots only when something is happening, so
 * `idle` renders nothing unless `showIdle` is set. The shape differs per state
 * and a text label is always present, so colour never carries the meaning alone.
 */
export function StatusDot({ status, showIdle = false, label, className = '' }: { status: BotStatus; showIdle?: boolean; label?: string; className?: string }) {
  if (status === 'idle' && !showIdle) return null
  const text = label ?? WORDS[status]
  return <span className={`bot-status bot-status-${status} ${className}`} role="img" aria-label={text} title={text} />
}

export function statusWord(status: BotStatus) { return WORDS[status] }
