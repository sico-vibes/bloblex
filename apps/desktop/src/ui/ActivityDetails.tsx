// What a blob actually did during a turn: one quiet summary line under the
// reply that opens into each step, and each step opens into its details
// (command and output, tool input and result, search query, file and diff).
// Shown only when Settings → Experimental → "Agent activity" is on.
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Globe, ShieldAlert, Terminal, Wrench } from 'lucide-react'
import type { JsonRecord } from '../types'
import { activityCategory, activityInput, activitySummary, activityToolName, type ActivityGroup, type ConversationItem } from './conversation'
import { TAIL_LINES, lastLine, maskSecrets, outputStreaming, tailOf, useActivityProvider } from './liveOutput'
import './ActivityDetails.css'

const TEAM_TOOLS: Record<string, string> = {
  list_blobs: 'Checked the team',
  list_conversations: 'Looked up side conversations',
  message_blob: 'Messaged a teammate',
  list_skills: 'Checked the skills',
  read_skill_file: 'Read a skill file',
}

/** The skill a `load_skill` call named, from its input (an object or JSON text). */
export function loadedSkillName(input: unknown): string | null {
  let value = input
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return null } }
  const name = value && typeof value === 'object' ? (value as JsonRecord).name : null
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

export function detailOf(item: ConversationItem): JsonRecord {
  const detail = item.activity?.detail
  return detail && typeof detail === 'object' && !Array.isArray(detail) ? detail as JsonRecord : {}
}

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null
const shorten = (value: string, from: 'head' | 'tail' = 'head') => {
  const line = value.split(/[\r\n]/, 1)[0].trim().replace(/\s+/g, ' ')
  const chars = [...line]
  if (chars.length <= 80) return line
  return from === 'tail' ? `…${chars.slice(-80).join('')}` : `${chars.slice(0, 80).join('')}…`
}
const short = (value: string) => shorten(value)
/** A path keeps its file name, so it is shortened from the left. */
const shortPath = (value: string) => shorten(value, 'tail')

/** A readable name for one step. */
export function activityTitle(item: ConversationItem): string {
  const activity = item.activity ?? {}
  const detail = detailOf(item)
  const input = activityInput(item)
  const category = activityCategory(item)
  const path = text(detail.path) ?? text(activity.path) ?? text(input.file_path) ?? text(input.filePath) ?? text(input.path)
  const tool = text(detail.tool)
  const toolName = tool?.split(' · ').pop() ?? null
  if (toolName === 'load_skill') { const name = loadedSkillName(detail.input ?? detail.arguments); return name ? `Used skill: ${name}` : 'Used a skill' }
  if (toolName && TEAM_TOOLS[toolName]) return TEAM_TOOLS[toolName]
  const label = text(detail.label)
  const title = text(activity.title)
  const fallback = label ?? (title && ![activityToolName(item), String(activity.kind ?? '').toLowerCase(), 'tool call'].includes(title.toLowerCase()) ? title : null)
  if (category === 'command') {
    const command = text(detail.command) ?? text(input.command)
    if (command) return `Ran ${short(command)}`
    return fallback ? `Ran ${short(fallback).replace(/^Ran /, '')}` : 'Ran a command'
  }
  if (category === 'file') {
    const fileCount = Number(detail.fileCount ?? input.fileCount)
    if (Number.isFinite(fileCount) && fileCount > 1) return `Edited ${fileCount} files`
    return path ? `Edited ${shortPath(path)}` : fallback ? shortPath(fallback) : 'Edited a file'
  }
  if (category === 'read') {
    const verb = ['list', 'ls'].includes(activityToolName(item)) ? 'Listed' : 'Read'
    return path ? `${verb} ${shortPath(path)}` : fallback ? shortPath(fallback) : `${verb} a file`
  }
  if (category === 'search') {
    const url = text(detail.url) ?? text(input.url)
    if (url) { try { return `Fetched ${short(new URL(url).host)}` } catch { return 'Fetched a page' } }
    const pattern = text(detail.pattern) ?? text(detail.query) ?? text(input.pattern) ?? text(input.query)
    if (pattern) return path ? `Searched ${short(pattern)} in ${shortPath(path)}` : `Searched ${short(pattern)}`
    if (path) return `Searched ${shortPath(path)}`
    return fallback ? short(fallback) : 'Searched files or the web'
  }
  return short(text(detail.label) ?? text(activity.title) ?? toolName ?? 'Used a tool')
}

export function stateOf(item: ConversationItem) {
  const state = String(item.activity?.state ?? item.activity?.status ?? '').toLowerCase()
  const resultStatus = String(detailOf(item).resultStatus ?? '').toLowerCase()
  if (['error', 'failed', 'rejected', 'declined'].includes(state) || ['failed', 'declined'].includes(resultStatus)) return 'failed'
  if (['running', 'working', 'started', 'in_progress'].includes(state)) return 'running'
  return 'done'
}

function StepIcon({ item }: { item: ConversationItem }) {
  const category = activityCategory(item)
  if (stateOf(item) === 'failed') return <ShieldAlert size={13} aria-hidden="true" />
  if (category === 'file' || category === 'read') return <FileText size={13} aria-hidden="true" />
  if (category === 'search') return <Globe size={13} aria-hidden="true" />
  if (category === 'command') return <Terminal size={13} aria-hidden="true" />
  return <Wrench size={13} aria-hidden="true" />
}

/** Command output as the coding agent reported it: the last lines while it runs, everything it kept once done. */
function OutputBlock({ value, running }: { value: string; running: boolean }) {
  const [all, setAll] = useState(false)
  const box = useRef<HTMLPreElement | null>(null)
  const tail = tailOf(value)
  const shown = all || !tail.cut ? value : tail.text
  useEffect(() => {
    const node = box.current
    if (running && node && node.scrollHeight - node.scrollTop - node.clientHeight < 48) node.scrollTop = node.scrollHeight
  }, [shown, running])
  return <div className="activity-step-block">
    <span>{running ? 'Live output' : 'Output'}{tail.cut && !all ? ` · last ${TAIL_LINES} lines` : ''}</span>
    <pre ref={box} className={running ? 'live' : undefined} tabIndex={0} aria-label={running ? 'Live command output' : 'Command output'}>{shown}</pre>
    {tail.cut && <button type="button" className="ghost-button small" onClick={() => setAll((current) => !current)}>{all ? 'Show only the end' : 'Show everything kept'}</button>}
  </div>
}

function StepDetail({ item, onDiff }: { item: ConversationItem; onDiff?: (path: string, content: string) => void }) {
  const detail = detailOf(item)
  const provider = useActivityProvider()
  const running = stateOf(item) === 'running'
  const blocks: Array<{ label: string; value: string; mono?: boolean }> = []
  let hidden = false
  const add = (label: string, value: unknown, mono = true) => {
    const content = text(value)
    if (!content) return
    const safe = maskSecrets(content)
    hidden ||= safe.masked
    blocks.push({ label, value: safe.text, mono })
  }
  add('Command', detail.command ?? activityInput(item).command)
  add('Tool', detail.tool, false)
  add('Input', detail.input)
  add('Query', detail.query, false)
  add('Pattern', detail.pattern, false)
  add('URL', detail.url)
  add('Path', detail.path)
  add('Progress', detail.progress, false)
  const output = text(detail.output)
  const safeOutput = output ? maskSecrets(output) : null
  hidden ||= !!safeOutput?.masked
  add('Result', detail.result)
  add('Error', detail.error)
  add('Status', detail.resultStatus, false)
  const diff = text(detail.diff)
  const isCommand = activityCategory(item) === 'command'
  const waitingNote = running && isCommand && !output ? outputStreaming(provider).note : null
  if (!blocks.length && !diff && !safeOutput && !waitingNote) return <p className="activity-step-empty">The agent did not report details for this step.</p>
  return <div className="activity-step-detail">
    {blocks.filter((block) => ['Command', 'Tool', 'Input', 'Query', 'Pattern', 'URL', 'Path', 'Progress'].includes(block.label)).map((block) => <div key={block.label} className="activity-step-block">
      <span>{block.label}</span>
      {block.mono ? <pre>{block.value}</pre> : <p>{block.value}</p>}
    </div>)}
    {safeOutput && <OutputBlock value={safeOutput.text} running={running} />}
    {waitingNote && <p className="activity-step-note">{waitingNote}</p>}
    {blocks.filter((block) => !['Command', 'Tool', 'Input', 'Query', 'Pattern', 'URL', 'Path', 'Progress'].includes(block.label)).map((block) => <div key={block.label} className="activity-step-block">
      <span>{block.label}</span>
      {block.mono ? <pre>{block.value}</pre> : <p>{block.value}</p>}
    </div>)}
    {typeof detail.exitCode === 'number' && <small>Exit code {detail.exitCode}</small>}
    {hidden && <small className="activity-step-note">Possible keys and passwords are hidden here. The agent's full output is unchanged.</small>}
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
      {state === 'running' && typeof detailOf(item).output === 'string' && <span className="activity-step-live" aria-hidden="true">{lastLine(maskSecrets(String(detailOf(item).output)).text)}</span>}
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
    {open && <GroupedSteps items={group.items} onDiff={onDiff} />}
  </section>
}

const STEP_GROUPS = [
  ['command', 'Commands'], ['read', 'Files'], ['search', 'Searches'], ['file', 'Edits'], ['tool', 'Other'],
] as const

function GroupedSteps({ items, onDiff, flat }: { items: ConversationItem[]; onDiff?: (path: string, content: string) => void; flat?: boolean }) {
  return <>{STEP_GROUPS.map(([category, label]) => {
    const steps = items.filter((item) => activityCategory(item) === category || (category === 'tool' && activityCategory(item) === 'turn'))
    return steps.length > 0 && <div className="activity-step-group" key={category}>
      <h4>{label}</h4>
      <ol className={`activity-steps${flat ? ' flat' : ''}`} aria-label={label}>{steps.map((item) => <Step key={item.id} item={item} onDiff={onDiff} />)}</ol>
    </div>
  })}</>
}

/** The companion uses the same readable groups as the conversation, laid flat. */
export function ActivitySteps({ items }: { items: ConversationItem[] }) {
  return <GroupedSteps items={items} flat />
}
