// Fixtures for the Mini skin study (/preview1, /preview2, /preview3). Everything
// here is invented sample data; nothing is read from the daemon.

export type Runtime = 'claude' | 'codex' | 'opencode'
export type Status = 'idle' | 'thinking' | 'working' | 'needs' | 'error' | 'done'
export type LogoMode = 'original' | 'tint' | 'mono'

export interface Bot {
  id: string; name: string; runtime: Runtime; model: string; color: string; status: Status; lastActive: string
  manager?: boolean; ratePerMin: number | null; logo?: LogoMode
}

export interface Project { id: string; name: string }

export type TaskState = 'unassigned' | 'queued' | 'running' | 'needs_you' | 'done' | 'failed'
export type ScheduleKind = 'none' | 'once' | 'repeat'
export interface Task {
  id: string; title: string; brief: string; doneGoal: string; reportBack: string; projectId: string
  estimateMinutes: number; maxRuntimeMinutes: number; supervision: 'report_only' | 'bounded' | 'manager_completes'
  state: TaskState; assigneeId: string | null; parentId: string | null; origin: 'manager' | 'you'
  schedule: { kind: ScheduleKind; at: string; cron: string }; sessionId: string | null; costSoFar: number | null
}

export interface Session {
  id: string; botId: string; title: string; projectId: string; startMs: number; endMs: number | null
  state: 'running' | 'needs' | 'error' | 'done'; steps: string[]
}

export interface Message { from: 'you' | 'bot' | 'step'; text: string }

export const RUNTIME_NAME: Record<Runtime, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }

export const BOTS: Bot[] = [
  { id: 'manager', name: 'Manager', runtime: 'claude', model: 'Opus 5.5', color: '#e7b24a', status: 'idle', lastActive: '2m ago', manager: true, ratePerMin: 0.08 },
  { id: 'claude', name: 'Claude', runtime: 'claude', model: 'Sonnet 5.5', color: '#ef8354', status: 'working', lastActive: '36m ago', ratePerMin: 0.03 },
  { id: 'doop', name: 'Doop', runtime: 'opencode', model: 'DeepSeek v4.1 Flash', color: '#f2a93b', status: 'thinking', lastActive: '6h ago', ratePerMin: 0.01 },
  { id: 'ads', name: 'Weekly Ads Loop', runtime: 'opencode', model: 'DeepSeek v4.1 Flash', color: '#ef5b4c', status: 'needs', lastActive: '1d ago', ratePerMin: 0.01 },
  { id: 'codex', name: 'Codex', runtime: 'codex', model: 'GPT-6 Sol', color: '#7c9bff', status: 'error', lastActive: '5d ago', ratePerMin: 0.06 },
  { id: 'pololo', name: 'Pololo', runtime: 'codex', model: 'GPT-6 Luna', color: '#3fcf9c', status: 'idle', lastActive: '2d ago', ratePerMin: null },
  { id: 'cc', name: 'Claude Code', runtime: 'claude', model: 'Haiku 5.5', color: '#b48cf2', status: 'idle', lastActive: '7d ago', ratePerMin: 0.01 },
]

export const PROJECTS: Project[] = [
  { id: 'bitbots', name: 'Bitbots' },
  { id: 'pricing', name: 'Pricing site' },
  { id: 'ads', name: 'Ads automation' },
]

const MIN = 60_000
export function makeSessions(now: number): Session[] {
  const s = (id: string, botId: string, title: string, projectId: string, startAgo: number, endAgo: number | null, state: Session['state'], steps: string[]): Session =>
    ({ id, botId, title, projectId, startMs: now - startAgo * MIN, endMs: endAgo === null ? null : now - endAgo * MIN, state, steps })
  return [
    s('s1', 'manager', 'Plan the pricing launch', 'pricing', 96, 80, 'done', ['Split the request into four tasks', 'Drafted briefs for Claude, Codex and Doop']),
    s('s2', 'claude', 'Competitor pricing scan', 'pricing', 27, 15, 'done', ['Read five pricing pages', 'Wrote a comparison table']),
    s('s3', 'claude', 'Write the plan copy', 'pricing', 11, null, 'running', ['Drafted the three plan blurbs', 'Tightening the Pro plan wording']),
    s('s4', 'doop', 'Customer interview notes', 'pricing', 19, null, 'running', ['Read 14 interview notes', 'Grouping quotes by theme']),
    s('s5', 'ads', 'Sync the ad spend sheet', 'ads', 29, 22, 'done', ['Pulled last week of spend', 'Updated 42 rows']),
    s('s6', 'ads', 'Rotate the ads API keys', 'ads', 8, null, 'needs', ['Prepared the new key', 'Waiting for approval to run the rotate script']),
    s('s7', 'codex', 'Build the checkout page', 'pricing', 24, 6, 'error', ['Wired the plan picker', 'Checkout tests failed: coupon total off by one cent']),
    s('s8', 'pololo', 'Review PR #482 billing', 'bitbots', 70, 48, 'done', ['Left six review comments', 'Approved after fixes']),
    s('s9', 'cc', 'Release notes for beta.37', 'bitbots', 140, 118, 'done', ['Collected 23 merged changes', 'Wrote the notes']),
  ]
}

export const SESSION_MESSAGES: Record<string, Message[]> = {
  claude: [
    { from: 'you', text: 'Write the copy for the three plans. Keep it short and plain.' },
    { from: 'step', text: 'Read pricing/plans.md and the competitor table' },
    { from: 'bot', text: 'Here is a first pass. Free: everything you need to try it. Pro: for daily work, with unlimited bots. Team: shared bots, one bill.' },
    { from: 'step', text: 'Editing site/pricing/copy.ts' },
  ],
  doop: [
    { from: 'you', text: 'Group the interview notes by theme and pull the strongest quotes.' },
    { from: 'step', text: 'Read 14 interview notes' },
  ],
  ads: [
    { from: 'you', text: 'Rotate the ads API keys before Monday.' },
    { from: 'step', text: 'Prepared a new key in the vault draft' },
    { from: 'bot', text: 'I need your approval to run scripts/rotate-keys.sh against the live account.' },
  ],
  codex: [
    { from: 'you', text: 'Build the checkout page and wire up the plan picker.' },
    { from: 'step', text: 'Edited checkout/Plans.tsx, checkout/total.ts' },
    { from: 'step', text: 'Ran npm test checkout' },
    { from: 'bot', text: 'The checkout tests failed: the coupon total is one cent off when tax rounds down.' },
  ],
  manager: [
    { from: 'you', text: 'Launch the new pricing page by Friday.' },
    { from: 'bot', text: 'I split it into four tasks and drafted briefs. Drag them onto bots on the Tasks board when you are ready, or tell me who should take each one.' },
  ],
}

const blank = { brief: '', doneGoal: '', reportBack: 'A short summary of what changed and anything left open.', maxRuntimeMinutes: 30, supervision: 'bounded' as const, schedule: { kind: 'none' as const, at: '', cron: '0 9 * * 1-5' }, costSoFar: null }
export const TASKS: Task[] = [
  { ...blank, id: 't-root', title: 'Launch the new pricing page by Friday', brief: 'Ship the new pricing page with three plans and a working checkout.', doneGoal: 'The page is live behind the flag and checkout passes its tests.', projectId: 'pricing', estimateMinutes: 90, state: 'running', assigneeId: 'manager', parentId: null, origin: 'you', sessionId: 's1', costSoFar: 0.12 },
  { ...blank, id: 't1', title: 'Compare the pricing of five competitors', brief: 'Read the public pricing pages of five competitors and tabulate plans, limits and prices.', doneGoal: 'A table in docs/pricing/competitors.md.', projectId: 'pricing', estimateMinutes: 12, state: 'done', assigneeId: 'claude', parentId: 't-root', origin: 'manager', sessionId: 's2', costSoFar: 0.29 },
  { ...blank, id: 't2', title: 'Write the copy for the three plans', brief: 'Short, plain plan descriptions for Free, Pro and Team, using the competitor table.', doneGoal: 'copy.ts holds final copy for each plan.', projectId: 'pricing', estimateMinutes: 15, state: 'running', assigneeId: 'claude', parentId: 't-root', origin: 'manager', sessionId: 's3', costSoFar: 0.16 },
  { ...blank, id: 't3', title: 'Build the page and wire up checkout', brief: 'Build the pricing page from the design and connect the plan picker to checkout.', doneGoal: 'The page renders and the checkout tests pass.', projectId: 'pricing', estimateMinutes: 25, state: 'failed', assigneeId: 'codex', parentId: 't-root', origin: 'manager', sessionId: 's7', costSoFar: 0.49 },
  { ...blank, id: 't4', title: 'Group interview quotes by theme', brief: 'Read the 14 interview notes and group the strongest quotes by theme for the page.', doneGoal: 'A quotes section in docs/pricing/quotes.md.', projectId: 'pricing', estimateMinutes: 18, state: 'running', assigneeId: 'doop', parentId: 't-root', origin: 'manager', sessionId: 's4', costSoFar: 0.03 },
  { ...blank, id: 't5', title: 'Fix the coupon rounding test', brief: 'The coupon total is one cent off when tax rounds down. Fix the rounding and run the checkout tests again.', doneGoal: 'npm test checkout passes.', projectId: 'pricing', estimateMinutes: 10, state: 'queued', assigneeId: 'codex', parentId: 't3', origin: 'manager', sessionId: null },
  { ...blank, id: 't6', title: 'Write release notes', brief: 'Collect merged changes since beta.36 and write plain release notes.', doneGoal: 'docs/releases/beta.37.md exists and reads well.', projectId: 'bitbots', estimateMinutes: 12, state: 'unassigned', assigneeId: null, parentId: null, origin: 'manager', sessionId: null },
  { ...blank, id: 't7', title: 'Fix the flaky checkout test', brief: 'checkout.spec fails about one run in ten. Find the race and fix it.', doneGoal: 'Fifty runs in a row pass.', projectId: 'pricing', estimateMinutes: 20, state: 'unassigned', assigneeId: null, parentId: null, origin: 'manager', sessionId: null },
  { ...blank, id: 't8', title: 'Summarise the churn calls', brief: 'Summarise last week’s churn call notes into the five most common reasons.', doneGoal: 'A list of five reasons with a quote each.', projectId: 'ads', estimateMinutes: 15, state: 'unassigned', assigneeId: null, parentId: null, origin: 'you', sessionId: null, schedule: { kind: 'repeat', at: '', cron: '0 9 * * 1' } },
  { ...blank, id: 't9', title: 'Refresh the weekly ad report', brief: 'Pull spend and conversions for the last seven days and update the report sheet.', doneGoal: 'The sheet shows this week’s numbers.', projectId: 'ads', estimateMinutes: 10, state: 'queued', assigneeId: 'ads', parentId: null, origin: 'you', sessionId: null, schedule: { kind: 'repeat', at: '', cron: '30 8 * * 1-5' } },
  { ...blank, id: 't10', title: 'Clean up duplicate CRM contacts', brief: 'Merge duplicate contacts in the CRM export; keep the newest email.', doneGoal: 'The export has no duplicate emails.', projectId: 'ads', estimateMinutes: 18, state: 'unassigned', assigneeId: null, parentId: null, origin: 'manager', sessionId: null },
]

/** A drafted task the Manager "writes" from a one-line ask, so the board can show the flow. */
export function draftFromAsk(ask: string, id: string): Task {
  const title = ask.trim().replace(/[.]+$/, '')
  const head = title.charAt(0).toUpperCase() + title.slice(1)
  return {
    ...blank, id, title: head, projectId: 'bitbots', estimateMinutes: 15, state: 'unassigned', assigneeId: null, parentId: null, origin: 'manager', sessionId: null,
    brief: `${head}. Start by reading the relevant code and docs, then make the smallest correct change. Keep notes of anything surprising.`,
    doneGoal: 'The change is in place, its tests pass, and nothing else broke.',
    reportBack: 'What changed (files), how it was checked, and anything left open.',
  }
}

/* ----------------------------------------------------------------- colour */

export function hexToHsl(hex: string): [number, number, number] {
  const v = hex.replace('#', ''), n = parseInt(v.length === 3 ? v.split('').map((c) => c + c).join('') : v, 16)
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  if (max === min) return [0, 0, l * 100]
  const d = max - min, s = l > .5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s * 100, l * 100]
}
export function shift(hex: string, dh: number, ds = 0, dl = 0) {
  const [h, s, l] = hexToHsl(hex)
  return `hsl(${(h + dh + 360) % 360} ${Math.max(0, Math.min(100, s + ds))}% ${Math.max(0, Math.min(100, l + dl))}%)`
}

/* ------------------------------------------------------------------- cron */

function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const [range, stepText] = part.split('/'), step = stepText ? Math.max(1, parseInt(stepText, 10)) : 1
    let lo = min, hi = max
    if (range !== '*') { const [a, b] = range.split('-').map((x) => parseInt(x, 10)); if (Number.isNaN(a)) throw new Error('bad'); lo = a; hi = b === undefined || Number.isNaN(b) ? (stepText ? max : a) : b }
    if (lo < min || hi > max || lo > hi) throw new Error('bad')
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

/** The next few times a five-field cron expression fires, or null if it does not parse. */
export function nextRuns(expr: string, from: Date, count = 3): Date[] | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  try {
    const [mi, ho, dom, mo, dow] = [field(parts[0], 0, 59), field(parts[1], 0, 23), field(parts[2], 1, 31), field(parts[3], 1, 12), field(parts[4], 0, 7)]
    if (dow.has(7)) dow.add(0)
    const out: Date[] = [], t = new Date(from); t.setSeconds(0, 0); t.setMinutes(t.getMinutes() + 1)
    for (let i = 0; i < 60 * 24 * 40 && out.length < count; i++, t.setMinutes(t.getMinutes() + 1))
      if (mi.has(t.getMinutes()) && ho.has(t.getHours()) && dom.has(t.getDate()) && mo.has(t.getMonth() + 1) && dow.has(t.getDay())) out.push(new Date(t))
    return out
  } catch { return null }
}

export const CRON_PRESETS = [
  { label: 'Every weekday at 9:00', cron: '0 9 * * 1-5' },
  { label: 'Every Monday at 9:00', cron: '0 9 * * 1' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 18:30', cron: '30 18 * * *' },
]

export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
export const duration = (ms: number) => { const m = Math.max(0, Math.round(ms / MIN)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` }
export const money = (v: number) => `$${v.toFixed(2)}`
