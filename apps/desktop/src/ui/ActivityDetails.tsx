// What a blob actually did during a turn: one quiet summary line under the
// reply that opens into each step, and each step opens into its details
// (command and output, tool input and result, search query, file and diff).
// Shown only when Settings → Experimental → "Agent activity" is on.
import { useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Globe, ShieldAlert, Terminal, Wrench } from 'lucide-react'
import type { JsonRecord } from '../types'
import { activityCategory, activitySummary, type ActivityGroup, type ConversationItem } from './conversation'

const TEAM_TOOLS: Record<string, string> = {
  list_blobs: 'Checked the team',
  message_blob: 'Messaged a teammate',
}

function detailOf(item: ConversationItem): JsonRecord {
  const detail = item.activity?.detail
  return detail && typeof detail === 'object' && !Array.isArray(detail) ? detail as JsonRecord : {}
}

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null

/** A readable name for one step. */
export function activityTitle(item: ConversationItem): string {
  const activity = item.activity ?? {}
  const detail = detailOf(item)
  const category = activityCategory(item)
  if (category === 'file') return text(detail.path) ?? text(activity.path) ?? 'Edited a file'
  const tool = text(detail.tool)
  const toolName = tool?.split(' · ').pop() ?? null
  if (toolName && TEAM_TOOLS[toolName]) return TEAM_TOOLS[toolName]
  if (category === 'command') return text(detail.command) ?? text(activity.title) ?? 'Ran a command'
  if (category === 'search') return text(detail.query) ? `Searched: ${text(detail.query)}` : text(activity.title) ?? 'Searched the web'
  return text(activity.title) ?? toolName ?? 'Used a tool'
}

function stateOf(item: ConversationItem) {
  const state = String(item.activity?.state ?? item.activity?.status ?? '').toLowerCase()
  if (['error', 'failed', 'rejected'].includes(state)) return 'failed'
  if (['running', 'working', 'started', 'in_progress'].includes(state)) return 'running'
  return 'done'
}

function StepIcon({ item }: { item: ConversationItem }) {
  const category = activityCategory(item)
  if (stateOf(item) === 'failed') return <ShieldAlert size={13} aria-hidden="true" />
  if (category === 'file') return <FileText size={13} aria-hidden="true" />
  if (category === 'search') return <Globe size={13} aria-hidden="true" />
  if (category === 'command') return <Terminal size={13} aria-hidden="true" />
  return <Wrench size={13} aria-hidden="true" />
}

function StepDetail({ item, onDiff }: { item: ConversationItem; onDiff?: (path: string, content: string) => void }) {
  const detail = detailOf(item)
  const blocks: Array<{ label: string; value: string; mono?: boolean }> = []
  const add = (label: string, value: unknown, mono = true) => { const content = text(value); if (content) blocks.push({ label, value: content, mono }) }
  add('Command', detail.command)
  add('Tool', detail.tool, false)
  add('Input', detail.input)
  add('Query', detail.query, false)
  add('Path', detail.path)
  add('Output', detail.output)
  add('Result', detail.result)
  add('Error', detail.error)
  const diff = text(detail.diff)
  if (!blocks.length && !diff) return <p className="activity-step-empty">The agent did not report details for this step.</p>
  return <div className="activity-step-detail">
    {blocks.map((block) => <div key={block.label} className="activity-step-block">
      <span>{block.label}</span>
      {block.mono ? <pre>{block.value}</pre> : <p>{block.value}</p>}
    </div>)}
    {typeof detail.exitCode === 'number' && <small>Exit code {detail.exitCode}</small>}
    {diff && <div className="activity-step-block"><span>Diff</span><pre className="diff">{diff}</pre>{onDiff && <button type="button" className="ghost-button small" onClick={() => onDiff(text(detail.path) ?? 'Reported change', diff)}>Open diff</button>}</div>}
  </div>
}

function Step({ item, onDiff }: { item: ConversationItem; onDiff?: (path: string, content: string) => void }) {
  const [open, setOpen] = useState(false)
  const state = stateOf(item)
  return <li className={`activity-step state-${state}`}>
    <button type="button" className="activity-step-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className="activity-step-icon"><StepIcon item={item} /></span>
      <span className="activity-step-title">{activityTitle(item)}</span>
      {state === 'running' && <span className="activity-step-state">Running</span>}
      {state === 'failed' && <span className="activity-step-state failed">Failed</span>}
      {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
    </button>
    {open && <StepDetail item={item} onDiff={onDiff} />}
  </li>
}

/** "Ran 3 commands · used 2 tools", collapsed, under the reply it belongs to. */
export function ActivitySummaryLine({ group, onDiff }: { group: ActivityGroup; onDiff?: (path: string, content: string) => void }) {
  const [open, setOpen] = useState(false)
  const summary = group.runningTitle ? `Working · ${activitySummary(group)}` : activitySummary(group)
  return <section className={`activity-summary${group.failed ? ' has-failed' : ''}${open ? ' open' : ''}`}>
    <button type="button" className="activity-summary-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {group.runningTitle && <span className="typing" aria-hidden="true"><i /><i /><i /></span>}
      <span>{summary}{group.failed > 0 ? ` · ${group.failed} failed` : ''}</span>
      {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
    </button>
    {open && <ol className="activity-steps">{group.items.map((item) => <Step key={item.id} item={item} onDiff={onDiff} />)}</ol>}
  </section>
}

/** A flat list of steps (the companion's Activity view). */
export function ActivitySteps({ items }: { items: ConversationItem[] }) {
  return <ol className="activity-steps flat">{items.map((item) => <Step key={item.id} item={item} />)}</ol>
}
