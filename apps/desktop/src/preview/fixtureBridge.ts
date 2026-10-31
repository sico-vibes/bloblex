// Development-only stand-in for src/tauri.ts, wired by vite.preview.config.ts
// so the real App can be inspected in a browser without the daemon. Every
// value below is a visual fixture, not product data.
import { handleFixtureTaskRpc } from './fixtureTasks'
import { EXPERIMENTS } from '../ui/experiments'
import type { Agent, DaemonEvent, DaemonSupervisor, MessageMeta, PermissionRequest, Project, Runtime, Session, Snapshot, WindowBackdrop } from '../types'
import { answerUsageAnalytics } from '../ui/analyticsFixtures'
import { normalizeAnalytics } from '../ui/analyticsFormat'
import { parseCapabilities, parseExecSnapshot, parseModelCatalog } from '../executionContract'
import type { UsageAnalyticsRequest } from '../analyticsTypes'
import { IDLE_UPDATE_PHASE, parseUpdateChannel, type UpdateChannel, type UpdateInfo, type UpdatePhaseState, type UpdateProgress, type UpdatesState } from '../updatesContract'
import { entityNoun } from '../ui/vocabulary'
import { themeStyle } from '../blob/bitbots'
import { REMOTE_METHODS } from '../remote/remoteContract'
import type { RemoteMethod, RemoteStatus, RemoteTailscaleState } from '../remote/remoteContract'
import { createRemoteSimulator } from './remoteFixture'
import type { RemoteSeed } from './remoteFixture'

type Unlisten = () => void
const noop: Unlisten = () => undefined
let discoveryAttempts = 0
const pendingDeletes = new Map<string, { deadline: number; timer: number; archived: boolean }>()
const fixtureSettings: Record<string, unknown> = { 'notifications.enabled': true, 'claude.enableWorkflows': true }
const daemonListeners = new Set<(event: DaemonEvent) => void>()
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const flags = () => new URLSearchParams(location.search)
const fixturePreset = () => flags().get('preset')
const setPreviewSelection = (agentId: string) => {
  try { localStorage.setItem('bloblex.selectedAgentId', agentId) } catch { /* Preview selection is optional. */ }
}

// Remote mode preview: one shared simulator, seeded once from the URL. Flags are
// `?remote=off|on|<tailscale state>` and `?devices=0|1|3`; the default is off
// with no devices so the empty state is what people see first. A Tailscale state
// (`not_installed`, `starting`, `not_running`, `logged_out`, `https_disabled`,
// `port_in_use`, `funnel_on`) shows the host refusing to start and naming the
// fix; `on` and `ready` seed a working serve address.
const remoteSimulator = createRemoteSimulator()
let remoteFixtureSeeded = false
const REMOTE_PREVIEW_FLAGS = ['off', 'on', 'ready', 'not_installed', 'starting', 'not_running', 'logged_out', 'https_disabled', 'port_in_use', 'funnel_on'] as const
const remoteFixtureSeed = (): RemoteSeed => {
  const search = flags()
  const devicesParam = search.get('devices')
  const requested = search.get('remote') ?? 'off'
  const flag = (REMOTE_PREVIEW_FLAGS as readonly string[]).includes(requested) ? requested : 'off'
  const tailscale: RemoteTailscaleState = flag === 'on' || flag === 'off' ? 'ready' : flag as RemoteTailscaleState
  return {
    enabled: flag === 'on' || flag === 'ready',
    devices: devicesParam === '1' ? 1 : devicesParam === '3' ? 3 : 0,
    tailscale,
  }
}
function ensureRemoteFixture() {
  if (remoteFixtureSeeded) return
  remoteFixtureSeeded = true
  remoteSimulator.reset(remoteFixtureSeed())
}
remoteSimulator.subscribe((event) => { notifyFixtureDaemon(event.type, event.payload as Record<string, unknown>) })

const baseRuntimes: Runtime[] = [
  { id: 'runtime-codex', provider: 'codex', status: 'online', protocolFamily: 'codex_app_server', version: 'codex-cli 0.159.3', authState: 'signed_in' },
  { id: 'runtime-claude', provider: 'claude', status: 'online', protocolFamily: 'claude_stream', version: '2.1.286' },
  { id: 'runtime-opencode', provider: 'opencode', status: 'online', protocolFamily: 'acp', version: '1.18.34', authState: 'authenticated', gatewayAuthStates: { opencode: 'authenticated', 'opencode-go': 'authenticated' } },
]

// All catalog/session values below are preview-only visual fixtures. They do
// not represent installed models, provider capabilities, or user conversations.
const composerPreviewSessionId = 'session-codex-composer-preview'
/** Preview-only prompt queues, keyed by session id. */
const fixtureQueues: Record<string, { items: Array<Record<string, unknown>>; paused: boolean }> = {}
/** Preview-only automations and their runs. */
const fixtureAutomations: Array<Record<string, unknown>> = []
/** Preview-only memory notes. */
const fixtureMemory: Array<Record<string, unknown>> = []
const fixtureSkills: Array<Record<string, unknown>> = [
  { name: 'pdf', description: 'Read, fill and merge PDF files. Use when a task mentions a PDF form or document.', source: 'claude', sourcePath: null, contentSha256: 'a1', enabled: true, fileCount: 4, totalBytes: 18_400, importedAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z', disabledFor: [], nativeFor: ['claude'] },
  { name: 'release-notes', description: 'Write release notes from the git log in the house style: short, plain, grouped by area.', source: 'codex', sourcePath: null, contentSha256: 'b2', enabled: true, fileCount: 1, totalBytes: 2_100, importedAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z', disabledFor: [], nativeFor: [] },
  { name: 'figma-to-react', description: 'Turn a Figma frame export into React components that follow DESIGN.md.', source: 'folder', sourcePath: null, contentSha256: 'c3', enabled: false, fileCount: 7, totalBytes: 64_000, importedAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z', disabledFor: [], nativeFor: [] },
]
const fixtureRuns: Record<string, Array<Record<string, unknown>>> = {}
const fixtureFanouts: Array<{ id: string; title: string; text: string; projectId: string | null; projectName: string | null; createdAt: string; chosenSessionId: string | null; rows: Array<{ agentId: string; sessionId: string }> }> = []
const fixtureStash: Array<{ id: string; text: string; attachments: Array<{ file: string; name: string }>; agentId: string | null; agentName: string | null; projectId: string | null; projectName: string | null; createdAt: string; updatedAt: string }> = []
const fixtureExternal: { enabled: boolean; tier: string; lastCallAt: string | null; lastClient: string | null; allowFullAccess: boolean } = fixturePreset() === 'mcp' ? { enabled: true, tier: 'operator', lastCallAt: new Date(Date.now() - 4 * 60_000).toISOString(), lastClient: 'claude-code', allowFullAccess: false } : { enabled: false, tier: 'chat', lastCallAt: null, lastClient: null, allowFullAccess: false }
const fixtureOutside = {
  enabled: fixturePreset() === 'outside',
  sessions: [
    { id: 'cli-1', provider: 'claude', folder: 'invoice-api', state: 'working', tool: 'Bash', startedAt: new Date(Date.now() - 600_000).toISOString(), updatedAt: new Date().toISOString() },
    { id: 'cli-2', provider: 'claude', folder: 'site', state: 'waiting', tool: null, startedAt: new Date(Date.now() - 1_800_000).toISOString(), updatedAt: new Date(Date.now() - 60_000).toISOString() },
  ],
}
// `?preset=schedule-retry`: one run failed after changing files, one ended quietly (wave 13).
if (fixturePreset() === 'schedule-retry') {
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const changed = { id: 'run-changed', automationId: 'auto-tidy', sessionId: null, status: 'failed', reason: 'error_after_changes', scheduledFor: at(30), startedAt: at(30), finishedAt: at(28) }
  const quiet = { id: 'run-quiet', automationId: 'auto-watch', sessionId: null, status: 'completed', reason: 'nothing_to_report', scheduledFor: at(60), startedAt: at(60), finishedAt: at(59) }
  const base = { agentId: 'agent-codex', sessionMode: 'new', approvalMode: 'auto', maxRuntimeSecs: 1800, enabled: true, createdBy: 'user', consecutiveFailures: 0, pauseReason: null, running: false, nextRunAt: new Date(Date.now() + 20 * 3_600_000).toISOString() }
  fixtureAutomations.push({ ...base, id: 'auto-tidy', name: 'Tidy the changelog', prompt: 'Tidy CHANGELOG.md.', schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' }, consecutiveFailures: 1, lastRunAt: changed.startedAt, lastRun: changed })
  fixtureAutomations.push({ ...base, id: 'auto-watch', name: 'Watch the build', prompt: 'Check the nightly build.', schedule: { kind: 'cron', cron: '0 * * * *', timezone: 'UTC' }, lastRunAt: quiet.startedAt, lastRun: quiet })
  fixtureRuns['auto-tidy'] = [changed]
  fixtureRuns['auto-watch'] = [quiet]
}
/** Preview-only Manager knowledge (FIX36 D3): structured facts and a playbook. */
const fixtureManagerFacts: Array<Record<string, unknown>> = [
  { id: 'fact-name', category: 'identity', key: 'name', value: 'Sico Vibes', source: 'said', locked: true, createdAt: '2026-10-16T09:00:00Z', updatedAt: '2026-10-16T09:00:00Z' },
  { id: 'fact-role', category: 'identity', key: 'role', value: 'Founder and product owner.', source: 'said', locked: false, createdAt: '2026-10-16T09:01:00Z', updatedAt: '2026-10-16T09:01:00Z' },
  { id: 'fact-tone', category: 'style', key: 'tone', value: 'Direct, plain English. No filler or hype.', source: 'learned', locked: false, createdAt: '2026-10-16T09:02:00Z', updatedAt: '2026-10-16T09:02:00Z' },
]
const fixturePlaybookSeed = `# How I work

I am the user's Manager. I plan, keep their notes and playbook, and ask before
anything consequential.

## First run: get to know the user

Ask about their name and role, how they work, their communication style, coding
conventions, design taste and references. Save each answer with
\`remember_about_user\`. Never store secrets.

## Proposing a team

One bot per responsibility, two to six bots, each role explained in a sentence.
`
const fixturePlaybookVersions: Array<Record<string, unknown>> = [
  { version: 1, text: fixturePlaybookSeed, author: 'default', createdAt: '2026-10-16T08:00:00Z' },
]
const composerPreviewStorageKey = 'bloblex.preview.composer-session.v1'

let agents: Agent[] = [
  { id: 'agent-claude', name: 'Claude', look: { shape: 'cloud', seed: 'claude' }, description: 'Default agent for Claude.', instructions: '', color: '#f38c6f', runtimeId: 'runtime-claude', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: minutesAgo(4000), updatedAt: minutesAgo(4000) },
  { id: 'agent-codex', name: 'Codex', description: 'Default agent for Codex.', instructions: '', color: '#82aaff', runtimeId: 'runtime-codex', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: minutesAgo(3000), updatedAt: minutesAgo(3000), approvalMode: 'auto', effectiveApprovalMode: 'auto' },
  { id: 'agent-invoice', name: 'Invoice helper', look: { shape: 'capsule', seed: 'invoice' }, description: '', instructions: '', color: 'lemon', runtimeId: 'runtime-codex', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 1, archived: false, createdAt: minutesAgo(2000), updatedAt: minutesAgo(2000) },
  { id: 'agent-opencode', name: 'OpenCode', look: { shape: 'droplet', seed: 'opencode' }, description: 'Default agent for OpenCode.', instructions: '', color: 'violet', runtimeId: 'runtime-opencode', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: minutesAgo(1000), updatedAt: minutesAgo(1000) },
  { id: 'agent-old', name: 'Retired', description: '', instructions: '', color: 'pink', runtimeId: 'runtime-codex', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 2, archived: true, createdAt: minutesAgo(5000), updatedAt: minutesAgo(10) },
]

let sessions: Session[] = [
  {
    id: 'session-codex', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Invoice parser tests', projectPath: 'C:/work/korus', ...(fixturePreset() === 'moved' ? { link: { movedTo: { machineId: 'preview-laptop', name: 'Work laptop', at: new Date().toISOString() } } } : {}), state: flags().has('idle') ? 'idle' : 'working', model: 'gpt-6.1-sol', updatedAt: minutesAgo(fixturePreset() === 'generated-image' ? 0 : 2),
    messages: [
      { id: 'm1', role: 'user', content: 'Can you make the invoice parser tests pass?', createdAt: minutesAgo(9), ...(fixturePreset() === 'mcp' ? { meta: { origin: { kind: 'mcp', client: 'claude-code' } } } : {}) },
      { id: 'm2', role: 'assistant', content: 'Sure. I found two failing cases in **tests/invoice.test.ts**: the currency field is parsed before the locale is known, and totals use floats.\n\nI will switch totals to integer minor units and parse the locale first.', createdAt: minutesAgo(8) },
      ...(fixturePreset() === 'generated-image' ? [
        { id: 'img-failed', role: 'notice', content: "The image couldn't be generated: The image didn't arrive.", createdAt: minutesAgo(8), meta: { kind: 'generated_image', mediaId: 'img-failed', status: 'failed', detail: "The image didn't arrive." } },
        { id: 'img-ready', role: 'notice', content: 'Generated an image: sunrise.png', createdAt: minutesAgo(7), meta: { kind: 'generated_image', mediaId: 'img-ready', status: 'ready', name: 'sunrise.png', bytes: 182_400, mediaType: 'image/png', provider: 'codex' } },
        { id: 'img-pending', role: 'notice', content: 'Generating an image…', createdAt: minutesAgo(6), meta: { kind: 'generated_image', mediaId: 'img-pending', status: 'pending' } },
      ] : []),
      { id: 'm3', role: 'assistant', content: fixturePreset() === 'message-links'
        ? 'Here are the projects I found:\n\n| Project | Stars | Licence | What it gives you |\n| --- | ---: | --- | --- |\n| [dicebear/dicebear](https://github.com/dicebear/dicebear) | 9.9k | MIT | 61 styles for avatars and characters |\n| [Alain00/blobatar](https://github.com/Alain00/blobatar) | 1.5k | MIT | Parametric blob illustrations |\n\nMore details: https://github.com/hardbeat920/monocode.'
        : 'Patched `parseInvoice` and the fixture loader. Running the suite now.', createdAt: minutesAgo(3) },
    ],
    tools: [{ id: 't1', title: 'npm test', kind: 'command', state: 'running', command: 'npm test -- invoice', sequence: 4 }],
  },
  {
    id: composerPreviewSessionId, runtimeId: 'runtime-codex', agentId: 'agent-codex',
    title: 'Preview: composer controls', projectPath: 'C:/work/korus', state: 'idle',
    modelLock: { model: 'gpt-6.1-sol', thinking: flags().has('composer-low') ? 'low' : 'high' }, contextUsed: 14_000, contextSize: 1_000_000,
    updatedAt: minutesAgo(4), previewOnly: true,
    messages: [
      { id: 'composer-preview-user-1', role: 'user', content: 'Check the checkout flow and keep the controls in the composer.', createdAt: minutesAgo(9) },
      { id: 'composer-preview-assistant-1', role: 'assistant', content: 'I reviewed the checkout steps. The selected model and effort are locked to this preview conversation.', createdAt: minutesAgo(8) },
      { id: 'composer-preview-user-2', role: 'user', content: 'Can you make the confirmation state clearer?', createdAt: minutesAgo(7) },
      { id: 'composer-preview-assistant-2', role: 'assistant', content: 'The confirmation summary now shows the selected delivery option before submission.', createdAt: minutesAgo(6) },
      { id: 'composer-preview-user-3', role: 'user', content: 'Check the selected model, effort and context meter.', createdAt: minutesAgo(5) },
    ],
  },
  // `?preset=usage-limit`: Claude reached its usage limit, so the conversation offers a handoff (wave 13).
  { id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Landing page copy', projectPath: 'C:/work/site', state: fixturePreset() === 'usage-limit' ? 'limited' : 'completed', ...(fixturePreset() === 'usage-limit' ? { provider: 'claude', limitedUntil: new Date(Date.now() + 2 * 3_600_000).toISOString() } : {}), model: 'claude-opus', updatedAt: minutesAgo(41), messages: [{ id: 'c1', role: 'assistant', content: 'Updated the hero copy and the pricing table.', createdAt: minutesAgo(41) },
    ...(fixturePreset() === 'usage-limit' ? [{ id: 'c-limit', role: 'notice', content: "Limited until 14:00. I'll pick up when the window opens.", createdAt: minutesAgo(40), meta: { kind: 'usage_limit' } }] : [])] },
  { id: 'session-opencode', runtimeId: 'runtime-opencode', agentId: 'agent-opencode', title: 'Refactor auth', projectPath: 'C:/work/api', state: 'idle', updatedAt: minutesAgo(60 * 26), messages: [] },
  { id: 'session-legacy', runtimeId: 'runtime-codex', agentId: null, title: 'Untied notes', projectPath: 'C:/work/notes', state: 'idle', updatedAt: minutesAgo(90), messages: [] },
  { id: 'session-claude-2', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Hero follow-up', projectPath: 'c:\\work\\site\\', state: 'idle', updatedAt: minutesAgo(20), modelLock: flags().get('preset') === 'claude-context' ? { model:'claude-sonnet-5-5', thinking:'high' } : undefined, contextUsed: flags().get('preset') === 'claude-context' ? 17_340 : null, contextSize: flags().get('preset') === 'claude-context' ? 1_000_000 : null, contextModel: flags().get('preset') === 'claude-context' ? 'claude-sonnet-5-5' : null, contextEstimated: flags().get('preset') === 'claude-context', messages: [] },
  { id: 'session-claude-web', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Pricing page', projectPath: 'C:\\work\\web', state: 'completed', updatedAt: minutesAgo(80), messages: [] },
  { id: 'session-claude-dotdot', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Dotdot path', projectPath: 'C:\\work\\site\\..\\site', state: 'idle', updatedAt: minutesAgo(120), messages: [] },
  { id: 'session-claude-dot', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Dot path', projectPath: 'C:\\work\\site\\.', state: 'idle', updatedAt: minutesAgo(130), messages: [] },
  { id: 'session-invoice-a', runtimeId: 'runtime-codex', agentId: 'agent-invoice', title: 'North site', projectPath: 'C:\\client\\site', state: 'idle', updatedAt: minutesAgo(50), messages: [] },
  { id: 'session-invoice-b', runtimeId: 'runtime-codex', agentId: 'agent-invoice', title: 'South site', projectPath: 'D:\\other\\site', state: 'working', updatedAt: minutesAgo(40), messages: [] },
  { id: 'session-retired', runtimeId: 'runtime-codex', agentId: 'agent-old', title: 'Archived chat', projectPath: 'C:\\old\\repo', state: 'idle', updatedAt: minutesAgo(15), messages: [] },
  ...Array.from({ length: 31 }, (_, index) => {
    const n = index + 1
    return { id: `session-codex-many-${n}`, runtimeId: 'runtime-codex', agentId: 'agent-codex', title: `Bulk ${n}`, projectPath: 'C:\\work\\korus', state: 'idle' as const, updatedAt: minutesAgo(32 - n), messages: [] }
  }),
]

try {
  const saved = localStorage.getItem(composerPreviewStorageKey)
  if (saved) {
    const state = JSON.parse(saved) as { modelLock?:Session['modelLock']; contextUsed?:number|null; contextSize?:number|null }
    const session = sessions.find((item) => item.id === composerPreviewSessionId)
    if (session && state.modelLock && typeof state.modelLock === 'object') {
      session.modelLock = state.modelLock
      session.model = state.modelLock.model ?? undefined
      session.contextUsed = typeof state.contextUsed === 'number' ? state.contextUsed : null
      session.contextSize = typeof state.contextSize === 'number' ? state.contextSize : null
    }
  }
} catch { /* Preview fixture storage is optional. */ }

// Team fixture (preview only): projects own blobs; Codex leads, Pololo is a teammate.
let projects: Project[] = [
  { id: 'project-board', name: 'Board', path: 'C:/work/korus', sortOrder: 0, collapsed: false },
  { id: 'project-side', name: 'Side Projects', path: 'C:/work/site', sortOrder: 1, collapsed: false },
]
const teamFields: Record<string, Partial<Agent>> = {
  'agent-codex': { projectId: 'project-board', role: 'CTO', leader: true },
  'agent-claude': { projectId: 'project-side', role: 'Copywriter' },
  'agent-invoice': { projectId: 'project-board', role: 'Finance' },
  'agent-opencode': { role: 'Researcher' },
}
agents = agents.map((agent) => ({ projectId: null, role: '', leader: false, hidden: false, ...agent, ...teamFields[agent.id] }))
agents.push({ id: 'agent-pololo', name: 'Pololo', look: { shape: 'cloud', seed: 'pololo' }, description: 'UI/UX designer: finds and adapts component references.', instructions: '', color: '#2fbf9b', runtimeId: 'runtime-opencode', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 2, archived: false, createdAt: minutesAgo(900), updatedAt: minutesAgo(900), projectId: 'project-board', role: 'UI/UX Designer', leader: false, hidden: false })
// FIX36: the one built-in Manager previews as an ordinary bot that carries
// systemRole "manager" and works across every project (projectId null).
const managerDescription = 'Runs your team: knows every project and bot, plans the work and asks before it acts.'
const managerInstructions = "You are the Manager. You work across all of the user's projects and know every bot on the team. Ask the user before consequential actions: creating a project, creating a bot, assigning a task, or changing your own playbook."
agents.push({ id: 'agent-manager', name: 'Manager', look: { shape: 'hexagon', seed: 'manager' }, description: managerDescription, instructions: managerInstructions, color: 'mint', runtimeId: 'runtime-opencode', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: minutesAgo(5000), updatedAt: minutesAgo(2), projectId: null, role: 'Manager', leader: false, hidden: false, approvalMode: 'ask', effectiveApprovalMode: 'ask', systemRole: 'manager' })
const teamMainId = 'session-team-leader'
const teamSideId = 'session-team-side'
sessions.push({
  id: teamMainId, runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Codex', projectPath: 'C:/work/korus', state: flags().has('idle') ? 'idle' : 'waiting_permission', updatedAt: minutesAgo(0.5),
  modelLock: { model: 'gpt-6.1-sol', thinking: 'high', planMode: flags().has('plan') }, contextUsed: 52_000, contextSize: 400_000,
  messages: [
    { id: 'team-u1', sequence: 1, turnId: 'team-tA', role: 'user', content: 'Can you research an effort picker like the one on 21st.dev? @Pololo is great at UI, ask him to find it.', createdAt: minutesAgo(30) },
    { id: 'team-a1', sequence: 2, turnId: 'team-tA', role: 'assistant', content: 'On it — sending Pololo the brief and asking him to hunt down that effort / reasoning-level picker.', createdAt: minutesAgo(29) },
    { id: 'team-n1', sequence: 3, role: 'notice', content: 'Find an open-source effort picker like the 21st.dev one…', createdAt: minutesAgo(29), meta: { kind: 'delegation', direction: 'sent', peerAgentId: 'agent-pololo', peerName: 'Pololo', topic: 'Effort picker research', sideSessionId: teamSideId } },
    { id: 'team-r1', sequence: 4, turnId: 'team-tB', role: 'user', content: '[Reply from Pololo]\nNothing pixel-exact exists as a package. Closest: a PostHog ReasoningLevelDropdown (MIT) and a model selector on 21st.dev with Effort, Context and Fast toggles.', createdAt: minutesAgo(12), meta: { kind: 'blob_reply', fromAgentId: 'agent-pololo', fromName: 'Pololo', sideSessionId: teamSideId } },
    { id: 'team-a2', sequence: 5, turnId: 'team-tB', role: 'assistant', content: 'Pololo found it — nothing is a pixel-exact drop-in, but these are the useful hits:\n\n- **PostHog ReasoningLevelDropdown** (MIT): Faster ↔ Smarter, notched snaps, a Default badge.\n- **AI Model Select** on 21st.dev: Effort, Context and Fast in one popover.\n\nMy take: fork the PostHog one. Want me to plan the port?', createdAt: minutesAgo(11) },
    { id: 'team-u2', sequence: 6, turnId: 'team-tC', role: 'user', content: 'Yes, plan it.', createdAt: minutesAgo(3) },
    { id: 'team-p1', sequence: 7, turnId: 'team-tC', role: 'plan', content: '1. Vendor the ReasoningLevelDropdown into `src/ui/effort`.\n2. Replace its token colours with Bitbots theme tokens.\n3. Wire it to the session lock and add keyboard tests.', createdAt: minutesAgo(2), meta: { kind: 'plan' } },
  ],
  tools: [
    { id: 'team-tool-1', turnId: 'team-tA', kind: 'mcpToolCall', title: 'bloblex · list_blobs', state: 'completed', startedAt: minutesAgo(29.5), detail: { tool: 'bloblex · list_blobs', result: 'Your team:\n- Codex (you) [leader] — CTO\n- Pololo — UI/UX Designer · available' } },
    { id: 'team-tool-2', turnId: 'team-tA', kind: 'mcpToolCall', title: 'bloblex · message_blob', state: 'completed', startedAt: minutesAgo(29.2), detail: { tool: 'bloblex · message_blob', input: '{\n  "blob": "Pololo",\n  "message": "Find an open-source effort picker like the 21st.dev one…"\n}', result: 'Sent to Pololo. Their reply will arrive here as a message starting with "[Reply from Pololo]".' } },
    { id: 'team-tool-3', turnId: 'team-tB', kind: 'commandExecution', title: 'rg -n "ReasoningLevel" node_modules/@posthog', state: 'completed', startedAt: minutesAgo(11), detail: { command: 'rg -n "ReasoningLevel" node_modules/@posthog', output: 'node_modules/@posthog/ui/ReasoningLevelDropdown.tsx:12:export function ReasoningLevelDropdown(', exitCode: 0 } },
    { id: 'team-tool-4', turnId: 'team-tB', kind: 'webSearch', title: 'Searched: 21st.dev model select effort', state: 'completed', startedAt: minutesAgo(10.5), detail: { query: '21st.dev model select effort' } },
  ],
  files: [
    { id: 'team-file-1', turnId: 'team-tB', path: 'docs/effort-picker.md', createdAt: minutesAgo(10), detail: { path: 'docs/effort-picker.md', change: 'add', diff: '+# Effort picker options\n+- PostHog ReasoningLevelDropdown (MIT)\n+- 21st.dev AI Model Select' } },
  ],
})
sessions.push({
  id: teamSideId, runtimeId: 'runtime-opencode', agentId: 'agent-pololo', title: 'Effort picker research', projectPath: 'C:/work/korus', state: 'completed', updatedAt: minutesAgo(12),
  link: { kind: 'side', peerAgentId: 'agent-codex', peerName: 'Codex', originSessionId: teamMainId, topic: 'Effort picker research' },
  messages: [
    { id: 'side-m1', role: 'user', content: 'Hi Pololo, it\'s Codex. Sam needs a UI research hunt: an Effort / reasoning-level picker with a Faster ↔ Smarter slider, about six snap points and a Recommended mark. Search 21st.dev and GitHub for open-source replicas and reply with the best hits ranked.', createdAt: minutesAgo(29), meta: { kind: 'blob_message', fromAgentId: 'agent-codex', fromName: 'Codex' } },
    { id: 'side-t1', role: 'thinking', content: 'The user (Codex, a blob) wants a UI hunt. Search first, answer concisely.', createdAt: minutesAgo(12.5) },
    { id: 'side-a1', role: 'assistant', content: 'UI research done.\n\n**Bottom line:** nothing pixel-exact as a drop-in. Closest fork is PostHog; closest install is an AI Model Select on 21st.dev.', createdAt: minutesAgo(12) },
  ],
})
sessions.push({
  id: 'session-team-side-2', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Which model are you on', projectPath: 'C:/work/korus', state: 'completed', updatedAt: minutesAgo(95),
  link: { kind: 'side', peerAgentId: 'agent-pololo', peerName: 'Pololo', originSessionId: 'session-pololo', topic: 'Which model are you on' },
  messages: [
    { id: 'side2-m1', sequence: 1, role: 'user', content: 'Quick one from Pololo: which model and effort are you running?', createdAt: minutesAgo(96), meta: { kind: 'blob_message', fromAgentId: 'agent-pololo', fromName: 'Pololo' } },
    { id: 'side2-a1', sequence: 2, role: 'assistant', content: 'GPT-5.5 at High effort.', createdAt: minutesAgo(95) },
  ],
})
const teamQuestion: PermissionRequest = { id: 'perm-question', sessionId: teamMainId, runtimeId: 'runtime-codex', status: 'pending', kind: 'question', title: 'Codex has a question', choices: ['answer', 'dismiss'], questions: [{ id: 'q-direction', header: 'Direction', question: 'Which direction should the effort picker follow?', options: [{ label: 'PostHog fork', description: 'Closest behaviour, MIT licensed' }, { label: '21st.dev model select', description: 'One popover for effort, context and fast' }, { label: 'Build our own' }], multiSelect: false, allowOther: true }] }
// FIX36 D2: a Manager proposal surfaces as a `kind: "proposal"` permission card.
let fixtureProposalPending = true
const teamProposal: PermissionRequest = { id: 'perm-proposal', sessionId: teamMainId, runtimeId: 'runtime-opencode', status: 'pending', kind: 'proposal', title: 'Create the bot "Scout"', detail: 'Research · opencode', choices: ['approve', 'reject'], proposal: { id: 'perm-proposal', kind: 'bot', payload: { name: 'Scout', role: 'Research', provider: 'opencode' } } }

let sequence = 1
let agentSerial = 6
let fixtureAutostart = false
export const fixtureNotifications: Array<{ title: string; body: string }> = []
export const launchFixtureModes = ['in-progress', 'done', 'done-warning', 'service-down', 'onboarding-look', 'onboarding-step-1', 'onboarding-step-2', 'onboarding-step-3'] as const
export function launchFixtureData(mode: typeof launchFixtureModes[number]) {
  const warning = mode === 'done-warning'
  const progress = mode === 'in-progress'
  const checks = [
    { id: 'service', label: 'Connecting to the Bitbots service', state: mode === 'service-down' ? 'failed' : progress ? 'ok' : 'ok', detail: mode === 'service-down' ? 'Service did not respond' : 'Connected and loaded the latest state' },
    { id: 'discovery', label: 'Finding coding agents', state: progress ? 'running' : 'ok', detail: progress ? 'In progress' : '3 coding agents found' },
    { id: 'auth:runtime-claude', label: 'Checking Claude Code sign-in', state: progress ? 'running' : 'ok', detail: progress ? 'In progress' : 'Signed in' },
    { id: 'models:runtime-codex', label: 'Loading Codex models', state: progress ? 'running' : 'ok', detail: progress ? 'In progress' : 'Loaded 12 models' },
    ...(warning ? [{ id: 'auth:runtime-opencode', label: 'Checking OpenCode sign-in', state: 'warning', detail: 'Warning: OpenCode: sign-in could not be confirmed' }, { id: 'models:runtime-opencode', label: 'Loading OpenCode models', state: 'warning', detail: 'Warning: OpenCode: models could not be loaded' }] : []),
    { id: 'usage', label: 'Loading usage and limits', state: progress ? 'running' : 'ok', detail: progress ? 'In progress' : 'Usage and limits are ready' },
  ]
  const onboarding = mode.startsWith('onboarding-step-')
  const runtimes = (onboarding && mode === 'onboarding-step-1' ? [] : baseRuntimes).map((runtime) => ({ ...runtime, authState: runtime.provider === 'codex' ? 'authenticated' : runtime.authState }))
  return { checks, slow: false, serviceDown: mode === 'service-down', runtimes }
}
export async function autostartEnabled() { return fixtureAutostart }
export async function setAutostartEnabled(enabled: boolean) { fixtureAutostart = enabled }
export async function sendDesktopNotification(title: string, body: string) { fixtureNotifications.push({ title, body }) }
export async function flashMainWindow() {}
function rpcError(code: string, message: string) {
  return new Error(`${code}: ${message}`)
}

function sortAgents(list: Agent[]) {
  return [...list].sort((a, b) => a.runtimeId.localeCompare(b.runtimeId) || a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

function currentSnapshot(): Snapshot {
  const search = flags()
  const runtimes = baseRuntimes.map((runtime) => {
    if (fixturePreset() === 'opencode-runtime-error' && runtime.id === 'runtime-opencode') return { ...runtime, status: 'error', probeStep: 'Protocol check', probeError: 'The CLI does not advertise the required protocol.' }
    return search.has('offline') && runtime.id === 'runtime-codex' ? { ...runtime, status: 'offline' } : { ...runtime }
  })
  return {
    sequence,
    runtimes,
    agents: search.has('empty') ? [] : agents.map((agent) => ({ ...agent, customArgs: [...agent.customArgs], customEnv: { ...agent.customEnv } })),
    sessions: sessions.filter((session) => !session.archived).map((session) => ({ ...session })),
    permissions: fixturePreset() === 'message-links'
      ? []
      : search.has('approval')
      ? [{ id: 'perm-1', sessionId: 'session-codex', runtimeId: 'runtime-codex', status: 'pending', title: 'Run shell command', command: 'npm test -- invoice', choices: ['allow_once', 'allow_session', 'deny'] }]
      : [...(fixtureProposalPending ? [teamProposal] : []), ...(sessions.some((session) => session.id === teamMainId && session.state === 'waiting_permission') ? [teamQuestion] : [])],
    projects: projects.map((project) => ({ ...project })),
    usageSummary: { inputTokens: 182_400, outputTokens: 24_900 },
    quotas: fixtureQuotas(),
  }
}

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()
function fixtureQuotas() {
  if (flags().has('no-quota')) return []
  const window = (usedPercent: number, hours: number, windowDurationMins: number | null) => ({ usedPercent, remainingPercent: 100 - usedPercent, resetsAt: hoursFromNow(hours), windowDurationMins })
  const presetUsage = fixturePreset() === 'usage-tip-90'
  const orb = flags().get('orb')
  const fetchedAt = minutesAgo(1)
  return [
    { provider: 'claude', runtimeId: 'runtime-claude', fetchedAt, lastAttemptAt: fetchedAt, failureCount: 0, lastError: null, snapshot: { provider: 'claude', limits: [
      { label: 'Claude Code', primary: window(1, 3.9, 300), secondary: orb === 'unknown' ? null : window(orb === 'zero' ? 0 : orb === 'full' ? 100 : 27, 52, 10_080) },
      { label: 'Claude Opus', primary: window(12, 52, 10_080), secondary: null },
    ] } },
    { provider: 'codex', runtimeId: 'runtime-codex', fetchedAt, lastAttemptAt: fetchedAt, failureCount: 0, lastError: null, snapshot: { provider: 'codex', limits: [
      { label: 'Codex', primary: window(0, 4.98, 300), secondary: orb === 'unknown' ? null : window(orb === 'zero' ? 0 : orb === 'full' ? 100 : presetUsage ? 90 : 44, presetUsage ? 18 : 107, 10_080) },
    ] } },
    { provider: 'opencode', runtimeId: 'runtime-opencode', fetchedAt, lastAttemptAt: fetchedAt, failureCount: 0, lastError: flags().has('quota-error') ? 'unauthorized' : null, snapshot: { provider: 'opencode', limits: [
      { label: '5-hour', primary: window(0, 2.78, 300), secondary: null },
      { label: 'Weekly', primary: orb === 'unknown' ? null : window(orb === 'zero' ? 0 : orb === 'full' ? 100 : 4, 48, 10_080), secondary: null },
      { label: 'Monthly', primary: window(16, 493, null), secondary: null },
    ] } },
  ]
}

function nameTaken(name: string, exceptId?: string) {
  const key = name.trim().toLocaleLowerCase('en')
  return agents.some((agent) => !agent.archived && agent.id !== exceptId && agent.name.trim().toLocaleLowerCase('en') === key)
}

type FixtureModel = { id:string; displayName:string; supportedThinking:string[]; defaultThinking?:string; serviceTiers:unknown[]; isDefault?:boolean }

function fixtureCatalog(runtimeId: string) {
  const runtime = baseRuntimes.find((item) => item.id === runtimeId)
  const models: FixtureModel[] = runtimeId === 'runtime-opencode' ? [
    { id: 'opencode-go/preview', displayName: 'Preview model', supportedThinking: ['low', 'high', 'max'], serviceTiers: [] },
    { id: 'opencode-go/alternate-preview', displayName: 'Alternate preview', supportedThinking: [], serviceTiers: [] },
  ] : runtime?.provider === 'claude' ? [
    { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', supportedThinking: ['low', 'medium', 'high', 'xhigh', 'max', ...(fixtureSettings['claude.enableWorkflows'] === true ? ['ultracode'] : [])], defaultThinking: 'medium', serviceTiers: [{ id: 'fast', name: 'Fast' }], isDefault: true },
    { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', supportedThinking: ['low', 'medium', 'high', 'xhigh', 'max', ...(fixtureSettings['claude.enableWorkflows'] === true ? ['ultracode'] : [])], defaultThinking: 'medium', serviceTiers: [], isDefault: false },
    { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', supportedThinking: ['low', 'medium'], defaultThinking: 'low', serviceTiers: [], isDefault: false },
  ] : [
    // Raw effort values and offered order mirror the prompt-free Codex 0.161.0 catalog fixture.
    { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', supportedThinking: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultThinking: 'low', serviceTiers: [], isDefault: true },
    { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', supportedThinking: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultThinking: 'low', serviceTiers: [], isDefault: false },
    { id: 'gpt-6-sol', displayName: 'GPT-6-Sol', supportedThinking: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultThinking: 'low', serviceTiers: [], isDefault: false },
    { id: 'gpt-6-luna', displayName: 'GPT-6-Luna', supportedThinking: ['low', 'medium', 'high', 'xhigh', 'max'], defaultThinking: 'low', serviceTiers: [], isDefault: false },
    { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', supportedThinking: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultThinking: 'low', serviceTiers: [], isDefault: false },
    { id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', supportedThinking: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultThinking: 'low', serviceTiers: [], isDefault: false },
    { id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', supportedThinking: ['low', 'medium', 'high', 'xhigh', 'max'], defaultThinking: 'low', serviceTiers: [], isDefault: false },
  ]
  return { runtimeId, provider: runtime?.provider ?? '', models, validated: true, source: 'fixture', fetchedAt: '2026-10-04T00:00:00Z' }
}

export const inDesktop = true
export const previewMode = true
/**
 * `session.repository` for the preview: what the rail shows for a repository. `?repo=` picks the state:
 * changes (default), clean, nogit, error, many (a long list, cut short) or slow (the first read takes 2 s).
 * Visual fixtures only; no Git runs and nothing is ever written.
 */
const repositoryDiff = (name: string, added: string[], removed: string[]) => [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, `@@ -1,${removed.length + 2} +1,${added.length + 2} @@`, ' import { render } from "./render"', ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`), ' export {}'].join('\n')
const fixtureStaged = new Map<string, string>()
const withStaged = <T extends { files: Array<Record<string, unknown>> }>(answer: T): T => ({ ...answer, files: answer.files.map((file) => ({ ...file, staged: fixtureStaged.get(String(file.repositoryPath)) ?? 'none' })) })
// Phase 5: accounts, custom models and secrets. `?secretrequest=1` shows a bot asking for one.
let fixtureAccounts: Array<{ id: string; provider: string; name: string; signedIn: boolean; label: string | null; plan: string | null; bots: number }> = [{ id: 'preview-account-1', provider: 'claude', name: 'Work', signedIn: true, label: 'work@example.com', plan: 'max', bots: 2 }]
let fixtureCustomModels: Array<{ id: string; provider: string; modelId: string; label: string; efforts: string[] }> = []
let fixtureSecrets: Array<{ name: string; updatedAt: string | null; usedBy: string[] }> = [{ name: 'GITHUB_TOKEN', updatedAt: null, usedBy: ['Codex'] }]
let fixtureSecretAnswered = false
let fixturePushOn = false
// Phase 4: another machine. `?machines=1` shows one, `?machines=offline` one that can't be reached.
let fixtureSelfName = 'Home desktop'
let fixtureMachineList: Array<Record<string, unknown>> | null = null
let fixturePairJob: { id: string; url: string; state: string; detail: string | null; machine: { id: string; name: string } | null } | null = null
let fixtureTakeOver: { id: string; state: string; steps: Array<{ id: string; status: string; detail: string | null }>; sessionId: string | null; detail: string | null } | null = null
let fixtureShared: Record<string, unknown> = { found: true, valid: true, problems: [], settings: { setupScript: 'npm install', defaultBot: 'Rae', approvalMode: 'ask' }, hash: 'preview', trusted: false, state: 'untrusted' }
function fixtureMachines(): Array<Record<string, unknown>> {
  if (fixtureMachineList) return fixtureMachineList
  const wanted = flags().get('machines')
  if (!wanted) return []
  const online = wanted !== 'offline'
  return [{ id: 'preview-laptop', name: 'Work laptop', url: 'https://work-laptop.example.ts.net', auth: 'code', fingerprint: null, tier: 'operator', pairedAt: new Date(Date.now() - 86_400_000).toISOString(), lastSeenAt: new Date(Date.now() - (online ? 20_000 : 7_200_000)).toISOString(), state: online ? 'online' : 'offline', detail: null, version: '0.1.0-beta.44', bots: [
    { id: 'preview-rae', name: 'Rae', color: 'mint', role: 'Frontend', provider: 'claude', model: 'claude-sonnet-5-5', busy: online, activeSessionId: 'preview-remote-1', conversations: 2 },
    { id: 'preview-tom', name: 'Tom', color: 'sky', role: null, provider: 'codex', model: 'gpt-6-luna', busy: false, activeSessionId: null, conversations: 0 },
  ] }]
}
let fixtureAbandoned = [
  { id: 'wt-1', repo: 'C:/work/site', path: 'C:/work/site-bitbots/fix-the-header', branch: 'bitbots/fix-the-header', reason: 'conversation_deleted', dirtyFiles: 0, commitsAhead: 0, lastActivityAt: '2026-10-20T10:00:00Z' },
  { id: 'wt-2', repo: 'C:/work/site', path: 'C:/work/site-bitbots/try-a-new-rail', branch: 'bitbots/try-a-new-rail', reason: 'conversation_deleted', dirtyFiles: 2, commitsAhead: 3, lastActivityAt: '2026-10-22T10:00:00Z' },
  { id: 'wt-3', repo: 'C:/work/korus', path: 'C:/work/korus-bitbots/invoice-tests', branch: 'bitbots/invoice-tests', reason: 'conversation_archived', dirtyFiles: 0, commitsAhead: 1, lastActivityAt: '2026-10-25T10:00:00Z' },
]
let fixtureClone: { id: string; url: string; target: string; state: string; detail: string | null; project: null } | null = null

async function fixtureRepository(sessionId: string) {
  const mode = flags().get('repo') ?? 'changes'
  if (mode === 'slow') await new Promise((resolve) => window.setTimeout(resolve, 2000))
  const root = 'C:/Users/me/work/site'
  const base = { projectPath: root, repoRoot: root, gitRepo: true, branch: 'feature/rail', detached: false, files: [] as Array<Record<string, unknown>>, addedLines: 0, removedLines: 0, truncated: false, error: null as string | null }
  if (mode === 'nogit') return { ...base, repoRoot: null, gitRepo: false, branch: null }
  if (mode === 'error') return { ...base, error: 'git is not installed or could not be started.' }
  if (mode === 'clean') return base
  const files = [
    { path: `${root}/src/App.tsx`, repositoryPath: 'src/App.tsx', change: 'modified', addedLines: 12, removedLines: 3, diff: repositoryDiff('src/App.tsx', ['const title = "Bitbots"', 'render(title)'], ['render()']), binary: false, truncated: false },
    { path: `${root}/src/rail.ts`, repositoryPath: 'src/rail.ts', change: 'added', addedLines: 10_352, removedLines: 0, diff: repositoryDiff('src/rail.ts', ['export const rail = 1'], []), binary: false, truncated: true },
    { path: `${root}/docs/notes.md`, repositoryPath: 'docs/notes.md', change: 'added', addedLines: 41, removedLines: 0, diff: repositoryDiff('docs/notes.md', ['# Notes'], []), binary: false, truncated: false },
    { path: `${root}/old/legacy.ts`, repositoryPath: 'old/legacy.ts', change: 'deleted', addedLines: 0, removedLines: 94, diff: null, binary: false, truncated: false },
    { path: `${root}/src/Header.tsx`, repositoryPath: 'src/Header.tsx', change: 'renamed', addedLines: 2, removedLines: 2, diff: repositoryDiff('src/Header.tsx', ['export const Header = 1'], ['export const Head = 1']), binary: false, truncated: false },
    { path: `${root}/assets/logo.png`, repositoryPath: 'assets/logo.png', change: 'modified', addedLines: null, removedLines: null, diff: null, binary: true, truncated: false },
  ]
  if (mode === 'many') for (let index = 0; index < 24; index += 1) files.push({ path: `${root}/src/gen/file${index}.ts`, repositoryPath: `src/gen/file${index}.ts`, change: 'modified', addedLines: index + 1, removedLines: index, diff: repositoryDiff(`src/gen/file${index}.ts`, ['const a = 1'], ['const a = 0']), binary: false, truncated: false })
  const addedLines = files.reduce((sum, file) => sum + (Number(file.addedLines) || 0), 0)
  const removedLines = files.reduce((sum, file) => sum + (Number(file.removedLines) || 0), 0)
  return { ...base, files, addedLines: sessionId ? addedLines : 0, removedLines, truncated: mode === 'many' }
}

export async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (method === 'remote.preview.pair') {
    // Preview only: act as the phone submitting the code for the live offer. It
    // raises `remote.pairing.requested`; the owner still approves or rejects.
    ensureRemoteFixture()
    return remoteSimulator.simulatePhoneRequest({ code: typeof params.code === 'string' ? params.code : undefined }) as T
  }
  if ((REMOTE_METHODS as readonly string[]).includes(method)) {
    ensureRemoteFixture()
    return remoteSimulator.call(method as RemoteMethod, params) as Promise<T>
  }
  if (method === 'runtime.refresh') {
    discoveryAttempts += 1
    // ?discovery-timeout-once exercises timeout, background recovery and confirmation.
    if (flags().has('discovery-timeout-once') && discoveryAttempts === 1) await new Promise((resolve) => window.setTimeout(resolve, 31_000))
    else await new Promise((resolve) => window.setTimeout(resolve, 900))
    const runtimes = baseRuntimes.map((runtime) => fixturePreset() === 'opencode-runtime-error' && runtime.id === 'runtime-opencode'
      ? { ...runtime, probeStep: 'Protocol check', probeError: 'The CLI does not advertise the required protocol.', status: 'error' }
      : flags().has('discovery-probe-error') && runtime.provider === 'codex' ? { ...runtime, probeStep: 'Protocol check', probeError: 'Probe timed out.', status: 'error' } : { ...runtime })
    notifyFixtureDaemon('runtime.changed', { runtimes })
    return { runtimes } as T
  }
  if (method === 'events.replay') return { replayAvailable: true, events: [] } as T
  if (method === 'quota.list') return { quotas: fixtureQuotas() } as T
  if (method === 'quota.refresh') { window.setTimeout(() => notifyFixtureDaemon('quota.updated', {}), 600); return { started: true } as T }
  if (method === 'settings.get') {
    // Preview flags: ?activity turns on Agent activity, ?usage-bar the usage bar, ?chat=small|medium|large sizes the companion chat.
    if (flags().has('experiments')) for (const { name } of EXPERIMENTS) fixtureSettings[`experimental.${name}`] = true
    if (flags().has('activity')) fixtureSettings['experimental.activityDetails'] = true
    if (flags().has('usage-bar')) fixtureSettings['experimental.usageBar'] = true
    if (flags().has('logos')) fixtureSettings['experimental.runtimeLogos'] = true
    if (flags().get('style')) fixtureSettings['appearance.style'] = flags().get('style')
    if (flags().get('style') && ['haze','blobots'].includes(String(flags().get('style')))) localStorage.setItem('bitbots.style', String(flags().get('style')))
    if (['system','dark','light'].includes(String(flags().get('theme')))) { fixtureSettings['appearance.theme'] = flags().get('theme'); try { const saved = JSON.parse(localStorage.getItem('bloblex.appearance') ?? '{}'); localStorage.setItem('bloblex.appearance', JSON.stringify({ ...saved, theme: flags().get('theme') })) } catch {} }
    if (flags().get('accent')) fixtureSettings['appearance.accent'] = flags().get('accent')
    if (flags().get('density')) fixtureSettings['appearance.density'] = flags().get('density')
    for (const key of ['wallpaper','glass','font','monoFont']) { const value = flags().get(key); if (value) fixtureSettings[`appearance.${key}`] = value }
    if (flags().get('wallpaper')) localStorage.setItem('bitbots.wallpaper', String(flags().get('wallpaper')))
    if (flags().get('glass')) localStorage.setItem('bitbots.glass', String(flags().get('glass')))
    if (flags().get('font')) localStorage.setItem('bitbots.font', String(flags().get('font')))
    if (flags().get('monoFont')) localStorage.setItem('bitbots.monoFont', String(flags().get('monoFont')))
    if (flags().has('seen-hints')) fixtureSettings['hints.seen'] = ['companion.drag']
    if (flags().has('tour')) fixtureSettings['onboarding.tour'] = { version: 1, done: false, step: 2 }
    if (flags().has('focus')) fixtureSettings['companion.focusMode'] = true
    if (flags().has('positions')) fixtureSettings['companion.positions'] = { [String(flags().get('positions') ?? 'display')]: { x: 120, y: 900 } }
    return { settings: { ...fixtureSettings, ...(fixturePreset() === 'usage-tip-90' ? { 'experimental.usageTips': true } : {}) } } as T
  }
  if (method === 'settings.set') {
    if (params.key === 'permissions.default_mode' && params.value === 'bypass' && params.confirm !== true) throw rpcError('invalid_argument', 'Confirm making Full access the default first.')
    fixtureSettings[String(params.key)] = params.value
    return { saved: true } as T
  }
  if (method === 'session.repository') return withStaged(await fixtureRepository(String(params.sessionId ?? ''))) as T
  if (method === 'session.git.diff') {
    const file = (await fixtureRepository(String(params.sessionId ?? ''))).files.find((item) => item.repositoryPath === params.repositoryPath)
    if (!file) return { repositoryPath: params.repositoryPath, previousPath: null, change: 'modified', diff: null, truncated: false, binary: false, addedLines: null, removedLines: null, staged: 'none' } as T
    const long = ['import { render } from "./render"', '', ...Array.from({ length: 6 }, (_, index) => ` const line${index} = ${index}`)]
    const diff = file.diff ? `${file.diff}\n@@ -40,6 +42,7 @@${'\n'}${long.map((line) => line.startsWith(' ') ? line : ` ${line}`).join('\n')}\n-const oldest = load("the old value that was on a very long line which keeps going so wrapping can be seen in the side by side layout")\n+const newest = load("the new value")\n+const extra = true` : null
    return { ...file, previousPath: null, diff, staged: fixtureStaged.get(String(params.repositoryPath)) ?? 'none' } as T
  }
  if (method === 'session.git.stage') {
    for (const path of params.paths as string[]) fixtureStaged.set(path, params.staged === true ? 'all' : 'none')
    return { files: withStaged(await fixtureRepository(String(params.sessionId ?? ''))).files } as T
  }
  if (method === 'session.git.revert') return { undoId: 'preview-undo', name: String(params.repositoryPath), files: withStaged(await fixtureRepository(String(params.sessionId ?? ''))).files } as T
  if (method === 'session.git.revertUndo') return { files: withStaged(await fixtureRepository(String(params.sessionId ?? ''))).files } as T
  if (method === 'session.pr.draft') {
    const reason = flags().get('pr') === 'nogh' ? "The GitHub CLI isn't signed in." : null
    return { ready: !reason, reason, gh: { available: !reason, login: reason ? null : 'preview-user' }, repoRoot: 'C:/Users/me/work/site', branch: 'feature/rail', base: 'main', isWorktree: true, remote: 'origin', commitsAhead: 2, uncommitted: 6, title: 'Tidy the rail', body: '## Changes\n- Tidy the rail\n- Fix the header\n\n## Files\n6 files, +10,407 \u2212105\n\nMade with Bitbots.', existingUrl: flags().get('pr') === 'open' ? 'https://github.com/preview/site/pull/12' : null } as T
  }
  if (method === 'session.pr.create') {
    await new Promise((resolve) => window.setTimeout(resolve, 700))
    return { steps: [{ id: 'commit', status: params.commitMessage ? 'done' : 'skipped', detail: null }, { id: 'push', status: 'done', detail: null }, { id: 'pr', status: 'done', detail: null }], url: 'https://github.com/preview/site/pull/13' } as T
  }
  if (method === 'remote.push.get') return { enabled: fixturePushOn, publicKey: 'preview', devices: 0 } as T
  if (method === 'remote.push.set') { fixturePushOn = params.enabled === true; return { enabled: fixturePushOn } as T }
  if (method === 'account.list') return { accounts: fixtureAccounts } as T
  if (method === 'account.create') { const account = { id: `preview-account-${fixtureAccounts.length + 1}`, provider: String(params.provider), name: String(params.name), signedIn: false, label: null, plan: null, bots: 0 }; fixtureAccounts = [...fixtureAccounts, account]; return { account } as T }
  if (method === 'account.rename') { fixtureAccounts = fixtureAccounts.map((item) => item.id === params.id ? { ...item, name: String(params.name) } : item); return { ok: true } as T }
  if (method === 'account.delete') { fixtureAccounts = fixtureAccounts.filter((item) => item.id !== params.id); return { ok: true } as T }
  if (method === 'account.check') { fixtureAccounts = fixtureAccounts.map((item) => item.id === params.id ? { ...item, signedIn: true, label: 'work@example.com', plan: 'pro' } : item); return { ok: true } as T }
  if (method === 'account.signIn') return { command: `$env:CLAUDE_CONFIG_DIR='C:\\Users\\you\\AppData\\Local\\Bitbots\\accounts\\${params.id}'; claude auth login` } as T
  if (method === 'model.custom.list') return { models: fixtureCustomModels.filter((item) => item.provider === params.provider) } as T
  if (method === 'model.custom.save') { const model = { id: `preview-model-${fixtureCustomModels.length + 1}`, provider: String(params.provider), modelId: String(params.modelId), label: String(params.label), efforts: params.efforts as string[] }; fixtureCustomModels = [...fixtureCustomModels, model]; return { model } as T }
  if (method === 'model.custom.delete') { fixtureCustomModels = fixtureCustomModels.filter((item) => item.id !== params.id); return { ok: true } as T }
  if (method === 'secret.list') return { secrets: fixtureSecrets } as T
  if (method === 'secret.set') { fixtureSecrets = [...fixtureSecrets.filter((item) => item.name !== params.name), { name: String(params.name), updatedAt: new Date().toISOString(), usedBy: [] }]; return { ok: true } as T }
  if (method === 'secret.delete') { fixtureSecrets = fixtureSecrets.filter((item) => item.name !== params.name); return { ok: true } as T }
  if (method === 'secret.request.list') return { requests: flags().get('secretrequest') && !fixtureSecretAnswered ? [{ id: 'preview-request', sessionId: 'session-codex', name: 'DEPLOY_TOKEN', reason: 'I need it to check the staging deploy finished.', botName: 'Codex', expiresAt: null }] : [] } as T
  if (method === 'secret.request.answer' || method === 'secret.request.decline') { fixtureSecretAnswered = true; return { ok: true } as T }
  if (method === 'machine.self') return { id: 'preview-self', name: fixtureSelfName, version: '0.1.0-beta.44' } as T
  if (method === 'machine.self.rename') { fixtureSelfName = String(params.name); return { id: 'preview-self', name: fixtureSelfName, version: '0.1.0-beta.44' } as T }
  if (method === 'machine.list') return { machines: fixtureMachines() } as T
  if (method === 'machine.refresh' || method === 'machine.rename') return { ok: true } as T
  if (method === 'machine.remove') { fixtureMachineList = fixtureMachines().filter((item) => item.id !== params.id); return { removed: true, signedOut: true } as T }
  if (method === 'machine.probe') return (String(params.url).includes('ts.net')
    ? { origin: String(params.url), reachable: true, isBitbots: true, auth: 'code', fingerprint: null, trusted: true }
    : { origin: String(params.url), reachable: true, isBitbots: true, auth: 'password', fingerprint: 'AB:12:9F:44:0C:7E:D1:52:6A:33:BE:08:91:C4:7F:20:5D:EE:16:48:A9:02:C7:3B:60:1F:84:D5:72:96:BC:0E', trusted: false }) as T
  if (method === 'machine.pair.begin') {
    fixturePairJob = { id: 'preview-pair', url: String(params.url), state: 'pending', detail: null, machine: null }
    window.setTimeout(() => { fixturePairJob = { ...fixturePairJob!, state: 'approved', machine: { id: 'preview-laptop', name: 'Work laptop' } } }, 2500)
    return { job: fixturePairJob } as T
  }
  if (method === 'machine.pair.list') return { jobs: fixturePairJob ? [fixturePairJob] : [] } as T
  if (method === 'machine.pair.cancel') { fixturePairJob = null; return { ok: true } as T }
  if (method === 'machine.conversations') return { conversations: [
    { id: 'preview-remote-1', title: 'Fix the invoice export', updatedAt: new Date(Date.now() - 120_000).toISOString(), projectName: 'korus', state: 'working' },
    { id: 'preview-remote-2', title: 'Tidy the settings page', updatedAt: new Date(Date.now() - 86_400_000).toISOString(), projectName: 'korus', state: 'idle' },
  ] } as T
  if (method === 'machine.conversation') {
    const working = params.sessionId === 'preview-remote-1'
    return { session: { id: params.sessionId, title: working ? 'Fix the invoice export' : 'Tidy the settings page', state: working ? 'working' : 'idle', messages: [
      { id: 'r1', role: 'user', content: working ? 'The invoice export drops the last row. Can you find out why?' : 'Group the settings by what they change.', createdAt: new Date(Date.now() - 600_000).toISOString() },
      { id: 'r2', role: 'assistant', content: working ? 'Found it. The loop stops one row early because `end` is exclusive.\n\nI\'m adding a test for it now.' : 'Done. They\'re grouped under **Account**, **Appearance** and **Behaviour**.', createdAt: new Date(Date.now() - 300_000).toISOString() },
    ] } } as T
  }
  if (method === 'machine.takeOver.preview') return {
    ready: params.sessionId !== 'preview-remote-1', reason: params.sessionId === 'preview-remote-1' ? 'Rae is working. Stop it or wait, then try again.' : null,
    title: 'Tidy the settings page', bot: { id: 'preview-rae', name: 'Rae', provider: 'claude', model: null, agentId: 'preview-rae', willCreate: flags().get('takeover') === 'newbot' },
    repo: { identity: 'github.com/example/korus', url: 'https://github.com/example/korus.git', branch: 'bitbots/tidy-the-settings', isWorktree: true, hasRemote: true },
    uncommitted: 2, commitsAhead: 3, project: flags().get('takeover') === 'noproject' ? null : { id: 'korus', name: 'korus' }, needsProject: flags().get('takeover') === 'noproject', runtimeReady: true,
  } as T
  if (method === 'machine.takeOver') {
    fixtureTakeOver = { id: 'preview-takeover', state: 'running', steps: [{ id: 'prepare', status: 'done', detail: null }], sessionId: null, detail: null }
    window.setTimeout(() => { fixtureTakeOver = { id: 'preview-takeover', state: 'done', steps: ['prepare', 'code', 'bot', 'import', 'commit', 'open'].map((id) => ({ id, status: 'done', detail: null })), sessionId: String(params.sessionId), detail: null } }, 2200)
    return { job: fixtureTakeOver } as T
  }
  if (method === 'machine.takeOver.list') return { jobs: fixtureTakeOver ? [fixtureTakeOver] : [] } as T
  if (method === 'project.sharedSettings.get') return fixtureShared as T
  if (method === 'project.sharedSettings.trust') { fixtureShared = { ...fixtureShared, trusted: true, state: 'trusted' }; return fixtureShared as T }
  if (method === 'project.sharedSettings.untrust') { fixtureShared = { ...fixtureShared, trusted: false, state: 'untrusted' }; return fixtureShared as T }
  if (method === 'project.sharedSettings.write') return fixtureShared as T
  if (method === 'worktree.abandoned') return { items: fixtureAbandoned } as T
  if (method === 'worktree.removeAbandoned') {
    fixtureAbandoned = fixtureAbandoned.filter((item) => item.id !== params.id)
    return { removed: true, branchDeleted: params.deleteBranch === true, detail: null } as T
  }
  if (method === 'project.clone') {
    fixtureClone = { id: 'preview-clone', url: String(params.url), target: `${params.parent}\\${params.name ?? String(params.url).split('/').pop()?.replace(/\.git$/, '')}`, state: 'running', detail: null, project: null }
    window.setTimeout(() => { if (fixtureClone?.state === 'running') fixtureClone = { ...fixtureClone, state: flags().get('clone') === 'fail' ? 'failed' : 'done', detail: flags().get('clone') === 'fail' ? 'Repository not found.' : null } }, 2500)
    return { job: fixtureClone } as T
  }
  if (method === 'project.clone.list') return { jobs: fixtureClone ? [fixtureClone] : [] } as T
  if (method === 'project.clone.cancel') { if (fixtureClone) fixtureClone = { ...fixtureClone, state: 'cancelled' }; return { ok: true } as T }
  if (method === 'project.discover') return { folder: params.folder, truncated: false, repos: [
    { path: `${params.folder}\\korus`, name: 'korus', branch: 'main', alreadyAdded: true },
    { path: `${params.folder}\\site`, name: 'site', branch: 'feature/rail', alreadyAdded: false },
    { path: `${params.folder}\\tools\\scripts`, name: 'scripts', branch: 'main', alreadyAdded: false },
  ] } as T
  if (method === 'project.files.search') {
    const query = String(params.query ?? '').toLowerCase()
    const files = ['src/App.tsx', 'src/ui/ChangesView.tsx', 'src/ui/DiffBody.tsx', 'docs/notes.md', 'README.md', 'package.json']
    const found = files.flatMap((path) => {
      let at = 0
      const matches: number[] = []
      for (let index = 0; index < path.length && at < query.length; index += 1) if (path[index]!.toLowerCase() === query[at]) { matches.push(index); at += 1 }
      return at === query.length ? [{ path, name: path.split('/').pop() ?? path, score: 100 - path.length, matches }] : []
    })
    return { files: found.slice(0, Number(params.limit ?? 20)), truncated: false, source: 'git' } as T
  }
  if (method === 'project.content.search') {
    if (params.regex === true && /[[(]$/.test(String(params.query))) return { results: [], truncated: false, source: 'git', reason: "That isn't a valid search pattern." } as T
    const query = String(params.query ?? '')
    if (query === 'nothing') return { results: [], truncated: false, source: 'git', reason: null } as T
    return { truncated: false, source: 'git', reason: null, results: [
      { path: 'src/App.tsx', line: 12, preview: `const title = "${query}"` },
      { path: 'src/App.tsx', line: 88, preview: `render(${query})` },
      { path: 'src/ui/DiffBody.tsx', line: 41, preview: `  // Uses ${query} when the mode changes` },
    ] } as T
  }
  if (method === 'session.list') return { sessions: sessions.filter((session) => params.includeArchived === true || !session.archived).map((session) => ({ ...session })) } as T
  if (method === 'session.rename') {
    const session = sessions.find((item) => item.id === params.sessionId)
    const title = typeof params.title === 'string' ? params.title.trim() : ''
    if (!session) throw rpcError('not_found', 'Conversation not found.')
    if (!title || title.length > 120) throw rpcError('invalid_argument', 'Title must be between 1 and 120 characters.')
    session.title = title
    session.updatedAt = new Date().toISOString()
    notifyFixtureDaemon('session.changed', { session: { ...session } })
    return { session } as T
  }
  if (method === 'session.archive') {
    const session = sessions.find((item) => item.id === params.sessionId)
    if (!session) throw rpcError('not_found', 'Conversation not found.')
    session.archived = params.archived === true
    session.updatedAt = new Date().toISOString()
    notifyFixtureDaemon('session.changed', { session: { ...session } })
    return { session } as T
  }
  if (method === 'search.messages') {
    const query = String(params.query ?? '').trim().toLowerCase()
    const results = query ? sessions.filter((session) => !session.archived).flatMap((session) => (session.messages ?? []).filter((message) => ['user', 'assistant'].includes(String(message.role)) && String(message.content ?? message.text ?? '').toLowerCase().includes(query)).map((message) => {
      const text = String(message.content ?? message.text ?? '')
      const at = text.toLowerCase().indexOf(query)
      const start = Math.max(0, at - 45)
      const agent = agents.find((a) => a.id === session.agentId)
      return { sessionId: session.id, blobId: session.agentId, blob: agent ? { id: agent.id, name: agent.name, color: agent.color, look: agent.look, archived: agent.archived } : null, title: session.title, role: message.role, messageId: message.id, createdAt: message.createdAt ?? session.updatedAt, snippet: text.slice(start, Math.max(start + 180, at + query.length + 45)) }
    })).slice(0, 50) : []
    return { results } as T
  }
  if (method === 'file.revert') {
    const session = sessions.find((s) => s.id === params.sessionId)
    const file = session?.files?.find((f) => f.id === params.fileChangeId)
    if (!file) throw rpcError('not_found', 'File change not found.')
    return { reverted: true } as T
  }
  if (method === 'agent.purge') {
    const index = agents.findIndex((agent) => agent.id === params.agentId)
    if (index < 0) throw rpcError('not_found', 'Bot not found.')
    const agent = agents[index]
    if (params.confirm !== true || agent.locked || agent.systemRole === 'manager') throw rpcError('conflict', 'This bot cannot be deleted.')
    const related = sessions.filter((session) => session.agentId === agent.id || session.link?.kind === 'side' && session.link.peerAgentId === agent.id)
    if (related.some((session) => ['starting', 'working', 'cancelling', 'waiting_permission'].includes(String(session.state)))) throw rpcError('conflict', 'Stop the bot first.')
    for (const session of related) { const i = sessions.findIndex((item) => item.id === session.id); sessions.splice(i, 1); notifyFixtureDaemon('session.deleted', { sessionId: session.id }) }
    agents.splice(index, 1)
    notifyFixtureDaemon('agent.changed', { agentId: agent.id, action: 'deleted' })
    return { deleted: true, sessionIds: related.map((session) => session.id) } as T
  }
  if (method === 'agent.restore') {
    const agent = agents.find((a) => a.id === params.agentId)
    if (!agent) throw rpcError('not_found', `${entityNoun(themeStyle(), { capital: true })} not found.`)
    if (agents.some((a) => !a.archived && a.id !== agent.id && a.name.toLowerCase() === agent.name.toLowerCase())) throw rpcError('conflict', `Another ${entityNoun(themeStyle())} uses this name.`)
    agent.archived = false
    notifyFixtureDaemon('agent.changed', { agent })
    return { agent: { ...agent } } as T
  }
  if (method === 'session.delete.schedule') {
    const session = sessions.find((s) => s.id === params.sessionId)
    if (!session) throw rpcError('not_found', 'Conversation not found.')
    if (['starting', 'working', 'cancelling', 'waiting_permission'].includes(String(session.state))) throw rpcError('conflict', 'Cannot delete an active conversation.')
    const existing = pendingDeletes.get(session.id)
    if (existing) return { deadline: existing.deadline } as T
    const deadline = Date.now() + 8000
    const archived = session.archived === true
    session.archived = true
    const timer = window.setTimeout(() => { pendingDeletes.delete(session.id); void rpc('session.delete', { sessionId: session.id }) }, 8000)
    pendingDeletes.set(session.id, { deadline, timer, archived })
    notifyFixtureDaemon('session.changed', { session: { ...session } })
    return { deadline } as T
  }
  if (method === 'session.delete.cancel') {
    const id = String(params.sessionId)
    const pending = pendingDeletes.get(id)
    const session = sessions.find((s) => s.id === id)
    if (!pending || !session || Date.now() >= pending.deadline) throw rpcError('conflict', 'The Undo period has ended.')
    window.clearTimeout(pending.timer)
    pendingDeletes.delete(id)
    session.archived = pending.archived
    notifyFixtureDaemon('session.changed', { session: { ...session } })
    return { cancelled: true, session: { ...session } } as T
  }
  if (method === 'session.delete') {
    const index = sessions.findIndex((item) => item.id === params.sessionId)
    if (index < 0) throw rpcError('not_found', 'Conversation not found.')
    if (['starting', 'working', 'cancelling', 'waiting_permission'].includes(String(sessions[index].state))) throw rpcError('conflict', 'Cannot delete an active conversation.')
    const [session] = sessions.splice(index, 1)
    notifyFixtureDaemon('session.deleted', { sessionId: session.id })
    return { deleted: true } as T
  }
  if (method === 'session.model.update') {
    const session = sessions.find((item) => item.id === params.sessionId)
    if (!session) throw rpcError('not_found', 'Conversation not found.')
    if (['starting', 'working', 'cancelling', 'waiting_permission'].includes(String(session.state))) throw rpcError('conflict', 'Model and effort cannot change during an active turn.')
    if (params.model != null && (typeof params.model !== 'string' || !params.model.trim())) throw rpcError('invalid_argument', 'model must be a non-empty identifier or null')
    if (params.thinking != null && (typeof params.thinking !== 'string' || !params.thinking.trim())) throw rpcError('invalid_argument', 'thinking must be a non-empty identifier or null')
    const previousModel = session.modelLock?.model ?? session.model ?? agents.find((agent) => agent.id === session.agentId)?.model ?? null
    const previousThinking = session.modelLock?.thinking ?? agents.find((agent) => agent.id === session.agentId)?.thinking ?? null
    const nextModel = !('model' in params) ? previousModel : typeof params.model === 'string' && params.model ? params.model : null
    const nextThinking = !('thinking' in params) ? previousThinking : typeof params.thinking === 'string' && params.thinking ? params.thinking : null
    const modelChanged = previousModel !== nextModel
    if (modelChanged && params.confirmModelChange !== true) throw rpcError('confirmation_required', 'Confirm the model change before continuing.')
    const modelRows = fixtureCatalog(session.runtimeId).models
    if (nextModel && !modelRows.some((item) => item.id === nextModel)) throw rpcError('invalid_argument', 'The selected model is not in the fixture catalog.')
    const selected = modelRows.find((item) => item.id === nextModel)
    if (nextThinking && selected && !selected.supportedThinking.includes(nextThinking)) throw rpcError('invalid_argument', 'The selected effort is not advertised for this model.')
    const previousLock = session.modelLock ?? {}
    const nextLock: NonNullable<Session['modelLock']> = { model: nextModel, thinking: nextThinking }
    if ('serviceTier' in previousLock && !(modelChanged && !('serviceTier' in params))) nextLock.serviceTier = previousLock.serviceTier
    if ('approvalMode' in previousLock) nextLock.approvalMode = previousLock.approvalMode
    if ('serviceTier' in params) {
      if (params.serviceTier === null) delete nextLock.serviceTier
      else if (typeof params.serviceTier === 'string' && (selected?.serviceTiers ?? []).some((tier) => (tier as { id?: string }).id === params.serviceTier)) nextLock.serviceTier = params.serviceTier
      else throw rpcError('invalid_argument', 'The selected speed is not advertised for this model.')
    }
    if ('approvalMode' in params) {
      if (params.approvalMode === null) delete nextLock.approvalMode
      else if (params.approvalMode === 'ask' || params.approvalMode === 'auto' || params.approvalMode === 'bypass') nextLock.approvalMode = params.approvalMode
      else throw rpcError('invalid_argument', 'approvalMode must be ask, auto, bypass or null')
    }
    session.modelLock = nextLock
    session.model = nextModel ?? undefined
    session.updatedAt = new Date().toISOString()
    if (modelChanged) {
      session.contextUsed = null
      session.contextSize = null
      notifyFixtureDaemon('session.context.reset', { sessionId: session.id })
    }
    if (session.id === composerPreviewSessionId) {
      try { localStorage.setItem(composerPreviewStorageKey, JSON.stringify({ modelLock:session.modelLock, contextUsed:session.contextUsed, contextSize:session.contextSize })) } catch { /* Preview fixture storage is optional. */ }
    }
    notifyFixtureDaemon('session.changed', { session: { ...session } })
    return { session: { ...session }, modelChanged } as T
  }
  // FIX39 item 19: the side-conversation permission pill in the browser preview.
  if (method === 'session.permissions.set') {
    const session = sessions.find((item) => item.id === params.sessionId)
    if (!session) throw rpcError('not_found', 'Conversation not found.')
    if (session.link?.kind === 'automation') throw rpcError('conflict', "A scheduled run's permission mode is fixed by the schedule.")
    const approval = params.approvalMode
    if (approval !== null && !['ask', 'auto', 'bypass'].includes(String(approval))) throw rpcError('invalid_argument', 'approvalMode must be ask, auto, bypass or null')
    const nextLock: NonNullable<Session['modelLock']> = { ...(session.modelLock ?? {}) }
    if (approval === null) { delete nextLock.approvalMode; delete nextLock.approvalModeSource }
    else { nextLock.approvalMode = approval as 'ask' | 'auto' | 'bypass'; delete nextLock.approvalModeSource }
    session.modelLock = nextLock
    session.updatedAt = new Date().toISOString()
    notifyFixtureDaemon('session.changed', { session: { ...session } })
    return { session: { ...session } } as T
  }
  // FIX39 item 13: Lock and Unlock in the preview, so the badge, the read-only
  // editor and the disabled composer pills can be looked at without a daemon.
  if (method === 'agent.lock.set') {
    const agent = agents.find((item) => item.id === params.agentId)
    if (!agent) throw rpcError('not_found', `That ${entityNoun(themeStyle())} is no longer available.`)
    if (agent.systemRole === 'manager' && params.locked === true) throw rpcError('conflict', `The Manager cannot be locked.`)
    const updated: Agent = { ...agent, locked: params.locked === true, updatedAt: new Date().toISOString() }
    agents = sortAgents(agents.map((item) => item.id === updated.id ? updated : item))
    sequence += 1
    notifyFixtureDaemon('agent.changed', { agent: updated })
    return { agent: updated } as T
  }
  if (method === 'message.reaction.toggle') {
    const session = sessions.find((item) => item.id === params.sessionId)
    if (!session || session.archived || session.link?.kind === 'side') throw rpcError('not_found', 'Message conversation is unavailable.')
    const message = (session.messages ?? []).find((item) => item.id === params.messageId)
    const emoji = String(params.emoji ?? '')
    const allowed = ['👍', '👎', '❤️', '😂', '🎉', '😮']
    if (!message || !['user', 'assistant'].includes(String(message.role)) || !allowed.includes(emoji)) throw rpcError('invalid_argument', 'Reaction or message is unsupported.')
    const prior = Array.isArray(message.reactions) ? message.reactions.filter((item): item is string => typeof item === 'string' && allowed.includes(item)) : []
    const selected = !prior.includes(emoji)
    // One reaction per message: a different emoji replaces it, the same one removes it.
    message.reactions = selected ? [emoji] : []
    const payload = { sessionId: session.id, messageId: message.id, emoji, selected, reactions: message.reactions }
    notifyFixtureDaemon('message.reactions.changed', payload)
    return { reactions: message.reactions, selected } as T
  }
  if (typeof method === 'string' && method.startsWith('task.')) return handleFixtureTaskRpc(method, params, notifyFixtureDaemon, rpcError) as T
  if (typeof method === 'string' && method.startsWith('automation.')) {
    const find = () => fixtureAutomations.find((item) => item.id === params.id)
    const publish = (item: Record<string, unknown>) => notifyFixtureDaemon('automation.changed', { automation: { ...item } })
    if (method === 'automation.list') return { automations: fixtureAutomations.filter((item) => !params.agentId || item.agentId === params.agentId).map((item) => ({ ...item })) } as T
    if (method === 'automation.preview') {
      const schedule = params.schedule as { kind?: string; cron?: string; at?: string } | undefined
      if (!schedule || (schedule.kind === 'cron' && String(schedule.cron ?? '').trim().split(/\s+/).length !== 5)) throw rpcError('invalid_argument', 'That schedule is not valid.')
      const utc = fixtureNextRuns(schedule, Math.min(10, Math.max(1, Number(params.count) || 3)))
      return { utc, local: utc } as T
    }
    if (method === 'automation.create' || method === 'automation.update') {
      const schedule = params.schedule as Record<string, unknown> | undefined
      const name = typeof params.name === 'string' ? params.name.trim() : ''
      const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : ''
      if (!name || !prompt || !schedule) throw rpcError('invalid_argument', 'A name, a prompt and a schedule are required.')
      if (params.approvalMode !== undefined && params.approvalMode !== 'plan' && params.approvalMode !== 'auto') throw rpcError('invalid_argument', 'approvalMode must be plan or auto')
      const now = new Date().toISOString()
      const existing = method === 'automation.update' ? find() : undefined
      if (method === 'automation.update' && !existing) throw rpcError('not_found', 'That schedule is gone.')
      const next = { ...(existing ?? { id: `automation-${Date.now()}`, createdBy: 'user', consecutiveFailures: 0, lastRunAt: null, lastRun: null, running: false, pauseReason: null }),
        agentId: params.agentId ?? existing?.agentId, name, prompt, schedule, sessionMode: params.sessionMode ?? existing?.sessionMode ?? 'new',
        approvalMode: params.approvalMode ?? existing?.approvalMode ?? 'auto', maxRuntimeSecs: params.maxRuntimeSecs ?? existing?.maxRuntimeSecs ?? 1800,
        enabled: params.enabled === true || (existing?.enabled === true && params.enabled !== false),
        nextRunAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), updatedAt: now } as Record<string, unknown>
      if (!existing) fixtureAutomations.push(next)
      else Object.assign(existing, next)
      publish(next)
      return { automation: { ...next } } as T
    }
    const target = find()
    if (!target) throw rpcError('not_found', 'That schedule is gone.')
    if (method === 'automation.get') return { automation: { ...target } } as T
    if (method === 'automation.pause' || method === 'automation.resume') {
      const resume = method === 'automation.resume'
      target.enabled = resume
      target.pauseReason = resume ? null : 'user'
      target.consecutiveFailures = 0
      target.nextRunAt = resume ? new Date(Date.now() + 3 * 3_600_000).toISOString() : null
      publish(target)
      return { automation: { ...target } } as T
    }
    if (method === 'automation.delete') {
      fixtureAutomations.splice(fixtureAutomations.indexOf(target), 1)
      notifyFixtureDaemon('automation.deleted', { id: target.id })
      return { deleted: true } as T
    }
    if (method === 'automation.run_now') {
      const run = { id: `run-${Date.now()}`, automationId: target.id, sessionId: null, status: 'completed', reason: null, scheduledFor: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }
      ;(fixtureRuns[String(target.id)] ??= []).unshift(run)
      target.lastRun = run
      target.lastRunAt = run.startedAt
      publish(target)
      return { run } as T
    }
    if (method === 'automation.runs') return { runs: fixtureRuns[String(target.id)] ?? [] } as T
  }
  if (typeof method === 'string' && method.startsWith('skills.')) {
    const find = () => fixtureSkills.find((item) => item.name === params.name)
    if (method === 'skills.list') return { skills: fixtureSkills.map((item) => ({ ...item, disabledFor: [...(item.disabledFor as string[])] })) } as T
    if (method === 'skills.forAgent') {
      const agentId = typeof params.agentId === 'string' ? params.agentId : ''
      if (!agentId) throw rpcError('invalid_argument', 'agentId is required')
      const skills = fixtureSkills.filter((item) => item.enabled !== false && !(item.disabledFor as string[]).includes(agentId)).map((item) => ({ name: item.name, description: item.description, source: item.source }))
      return { skills } as T
    }
    if (method === 'skills.get') {
      const skill = find()
      if (!skill) throw rpcError('not_found', 'That skill is not in the pool.')
      return { name: skill.name, description: skill.description, body: `# ${skill.name}\n\n${skill.description}\n\n1. Read the input.\n2. Follow the steps.\n3. Report what changed.`, files: [{ path: 'SKILL.md', bytes: 1200 }, { path: 'scripts/run.py', bytes: 3400 }] } as T
    }
    if (method === 'skills.scan') return { candidates: [
      { source: 'claude', name: 'pdf', description: 'Read, fill and merge PDF files.', path: '~/.claude/skills/pdf', status: 'same' },
      { source: 'claude', name: 'brand-voice', description: 'Keep copy in the house voice: plain, short, kind.', path: '~/.claude/skills/brand-voice', status: 'new' },
      { source: 'codex', name: 'release-notes', description: 'Write release notes from the git log.', path: '~/.codex/skills/release-notes', status: 'changed' },
    ] } as T
    if (method === 'skills.import') {
      const items = Array.isArray(params.items) ? params.items as Array<{ source: string; name: string }> : []
      for (const item of items) if (!fixtureSkills.some((skill) => skill.name === item.name)) fixtureSkills.push({ name: item.name, description: 'Imported in the preview.', source: item.source, enabled: true, fileCount: 1, totalBytes: 900, disabledFor: [], nativeFor: [] })
      notifyFixtureDaemon('skills.changed', { action: 'imported' })
      return { imported: items.map((item) => item.name), skipped: [] } as T
    }
    if (method === 'skills.delete') { const index = fixtureSkills.findIndex((item) => item.name === params.name); if (index >= 0) fixtureSkills.splice(index, 1); return { deleted: true } as T }
    if (method === 'skills.toggle') {
      const skill = find()
      if (!skill) throw rpcError('not_found', 'That skill is not in the pool.')
      if (typeof params.agentId === 'string') {
        const off = new Set(skill.disabledFor as string[])
        if (params.enabled === false) off.add(params.agentId); else off.delete(params.agentId)
        skill.disabledFor = [...off]
      } else skill.enabled = params.enabled !== false
      return { skill: { ...skill } } as T
    }
  }
  if (method === 'backup.import') return { imported: { bots: 3, memory: 14, skills: 1, automations: 1, settings: 9 }, skipped: { bots: 0, memory: 0, skills: 1, automations: 0, settings: 0 }, renamed: [{ from: String(agents[0]?.name ?? 'Mochi'), to: `${String(agents[0]?.name ?? 'Mochi')} (2)` }] } as T
  if (typeof method === 'string' && method.startsWith('memory.')) {
    const live = () => fixtureMemory.filter((item) => !item.deletedAt)
    const find = () => fixtureMemory.find((item) => item.id === params.id)
    const secret = /(sk-[A-Za-z0-9]{8,}|ghp_|AKIA|-----BEGIN|bearer\s)/i
    if (method === 'memory.list') {
      const needle = typeof params.query === 'string' ? params.query.toLowerCase() : ''
      const rows = live().filter((item) => !needle || `${item.title} ${item.body}`.toLowerCase().includes(needle))
      return { records: rows.map((item) => ({ ...item })) } as T
    }
    if (method === 'memory.create') {
      const title = typeof params.title === 'string' ? params.title.trim() : ''
      const body = typeof params.body === 'string' ? params.body.trim() : ''
      if (!title || title.length > 120 || !body || body.length > 2000) throw rpcError('invalid_argument', 'A title up to 120 characters and a note up to 2000 characters are required.')
      if (secret.test(`${title} ${body}`)) throw rpcError('invalid_argument', 'That looks like a secret. Notes must not contain passwords or keys.')
      const record = { id: `memory-${Date.now()}-${fixtureMemory.length}`, scope: params.scope ?? 'shared', scopeId: params.scopeId ?? null, kind: params.kind ?? 'fact', title, body, tags: [], importance: 50, pinned: params.pinned === true, origin: 'user', reviewed: true, version: 1, updatedAt: new Date().toISOString(), deletedAt: null } as Record<string, unknown>
      fixtureMemory.push(record)
      notifyFixtureDaemon('memory.changed', { record: { ...record } })
      return { record: { ...record } } as T
    }
    const target = find()
    if (!target) throw rpcError('not_found', 'That note is gone.')
    if (method === 'memory.get') return { record: { ...target } } as T
    if (method === 'memory.update') {
      if (params.expectedVersion !== target.version) throw rpcError('conflict', 'That note changed. Reload and try again.')
      for (const key of ['title', 'body', 'kind', 'pinned']) if (key in params) target[key] = params[key]
      target.version = Number(target.version) + 1
      target.updatedAt = new Date().toISOString()
      notifyFixtureDaemon('memory.changed', { record: { ...target } })
      return { record: { ...target } } as T
    }
    if (method === 'memory.approve') { target.reviewed = true; notifyFixtureDaemon('memory.changed', { record: { ...target } }); return { record: { ...target } } as T }
    if (method === 'memory.delete') { target.deletedAt = new Date().toISOString(); notifyFixtureDaemon('memory.deleted', { id: target.id }); return { deleted: true } as T }
    if (method === 'memory.restore') { target.deletedAt = null; notifyFixtureDaemon('memory.changed', { record: { ...target } }); return { record: { ...target } } as T }
  }
  // Wave 13: watching Claude Code outside Bitbots. `?preset=outside` starts with it on and two sessions.
  if (method.startsWith('outside.')) {
    const status = () => ({ enabled: fixtureOutside.enabled, installed: fixtureOutside.enabled, settingsPath: 'C:/Users/you/.claude/settings.json', bridgeAvailable: true, problem: null })
    if (method === 'outside.status') return status() as T
    if (method === 'outside.sessions') return { sessions: fixtureOutside.enabled ? fixtureOutside.sessions : [] } as T
    if (method === 'outside.preview') return { settingsPath: status().settingsPath, exists: true, before: JSON.stringify({ model: 'opus' }, null, 2), after: JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '"C:/Program Files/Bitbots/bitbots-hook.exe" --outside "C:/Users/you/AppData/Roaming/Bitbots/outside-hook.json"', timeout: 5 }] }] }, model: 'opus' }, null, 2) } as T
    if (method === 'outside.enable') {
      if (params.confirm !== true) throw rpcError('confirmation_required', 'Confirm the change to Claude Code’s settings first.')
      fixtureOutside.enabled = true
      notifyFixtureDaemon('outside.sessions.changed', { sessions: fixtureOutside.sessions })
      return { status: status(), backupPath: 'C:/Users/you/.claude/settings.json.bitbots-backup-20261028-101500' } as T
    }
    if (method === 'outside.disable') { fixtureOutside.enabled = false; notifyFixtureDaemon('outside.sessions.changed', { sessions: [] }); return { status: status(), backupPath: null, problem: null } as T }
  }
  // Phase 1B: comparisons, the stash, new projects and issue reports.
  if (method.startsWith('fanout.')) {
    const nameOf = (id: string) => agents.find((item) => item.id === id)?.name ?? 'A removed bot'
    const view = (record: typeof fixtureFanouts[number]) => {
      const age = Date.now() - Date.parse(record.createdAt)
      return { ...record, rows: record.rows.map((row, index) => {
        const done = age > 2500 + index * 2500
        return { agentId: row.agentId, agentName: nameOf(row.agentId), sessionId: row.sessionId, error: null, state: done ? 'idle' : 'working', reply: done ? `**${nameOf(row.agentId)}'s answer.**\n\nHere is how I would approach it:\n\n1. Read the code that's there.\n2. Change the smallest thing.\n3. Run the tests.` : null, durationMs: done ? 2500 + index * 2500 : null, tokens: done && index % 2 === 0 ? 1200 + index * 340 : null, worktree: record.projectId ? { path: `C:/work/.worktrees/${row.agentId}`, branch: `bitbots/compare-${index + 1}` } : null }
      }) }
    }
    if (method === 'fanout.start') {
      const ids = Array.isArray(params.agentIds) ? params.agentIds as string[] : []
      if (ids.length < 2 || ids.length > 6) throw rpcError('invalid_argument', 'Choose 2 to 6 bots.')
      const text = String(params.text ?? '')
      const project = typeof params.projectId === 'string' ? projects.find((item) => item.id === params.projectId) : undefined
      const record = { id: `fanout-${fixtureFanouts.length + 1}`, title: text.slice(0, 60), text, projectId: project?.id ?? null, projectName: project?.name ?? null, createdAt: new Date().toISOString(), chosenSessionId: null as string | null, rows: ids.map((agentId, index) => ({ agentId, sessionId: `session-compare-${fixtureFanouts.length + 1}-${index}` })) }
      fixtureFanouts.unshift(record)
      notifyFixtureDaemon('fanout.changed', { id: record.id })
      return { fanout: view(record) } as T
    }
    if (method === 'fanout.list') return { fanouts: fixtureFanouts.map(view) } as T
    const record = fixtureFanouts.find((item) => item.id === params.id)
    if (!record) throw rpcError('not_found', 'That comparison no longer exists.')
    if (method === 'fanout.get') return { fanout: view(record) } as T
    if (method === 'fanout.pick') { record.chosenSessionId = typeof params.sessionId === 'string' ? params.sessionId : null; notifyFixtureDaemon('fanout.changed', { id: record.id }); return { fanout: view(record) } as T }
    if (method === 'fanout.delete') { fixtureFanouts.splice(fixtureFanouts.indexOf(record), 1); notifyFixtureDaemon('fanout.changed', { id: record.id }); return { deleted: true } as T }
  }
  if (method.startsWith('stash.')) {
    if (method === 'stash.list') return { items: fixtureStash } as T
    if (method === 'stash.add') {
      const text = String(params.text ?? '')
      const parts = Array.isArray(params.attachments) ? params.attachments as Array<{ name?: string }> : []
      if (!text && !parts.length) throw rpcError('invalid_argument', 'There is nothing to stash.')
      const agent = agents.find((item) => item.id === params.agentId)
      const project = projects.find((item) => item.id === params.projectId)
      const item = { id: `stash-${Date.now()}`, text, attachments: parts.map((part, index) => ({ file: `${index}.png`, name: part.name ?? 'image.png' })), agentId: agent?.id ?? null, agentName: agent?.name ?? null, projectId: project?.id ?? null, projectName: project?.name ?? null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      fixtureStash.unshift(item)
      notifyFixtureDaemon('stash.changed', {})
      return { item } as T
    }
    const index = fixtureStash.findIndex((item) => item.id === params.id)
    if (index < 0) throw rpcError('not_found', 'That draft is no longer in the stash.')
    if (method === 'stash.image') return { name: 'image.png', mediaType: 'image/png', dataUrl: '' } as T
    const [item] = fixtureStash.splice(index, 1)
    notifyFixtureDaemon('stash.changed', {})
    if (method === 'stash.delete') return { deleted: true } as T
    if (method === 'stash.restore') return { item: { text: item.text, attachments: item.attachments.map((part) => ({ path: `C:/Bitbots/stash-restored/${part.file}`, name: part.name })) } } as T
  }
  if (method === 'project.scaffold.status') return { git: true, gh: { available: true, login: 'preview-user' } } as T
  if (method === 'project.scaffold') {
    if (params.confirm !== true) throw rpcError('invalid_argument', 'Confirm creating the project first.')
    const name = String(params.name ?? '').trim()
    const path = `${String(params.parentPath ?? 'C:/work')}/${name}`
    const project: Project = { id: `project-${projects.length + 1}`, name, path, sortOrder: projects.length, collapsed: false } as Project
    projects = [...projects, project]
    notifyFixtureDaemon('project.changed', { action: 'created', projectId: project.id })
    const wantsGithub = !!params.github
    return { project, githubUrl: wantsGithub ? `https://github.com/preview-user/${name}` : null, steps: [
      { id: 'folder', status: 'done', detail: null }, { id: 'project', status: 'done', detail: null },
      { id: 'git_init', status: params.git ? 'done' : 'skipped', detail: null }, { id: 'first_commit', status: params.git ? 'done' : 'skipped', detail: null },
      { id: 'github', status: wantsGithub ? 'done' : 'skipped', detail: null },
    ] } as T
  }
  if (method === 'diagnostics.issueDraft') {
    const body = '## What happened\n\n\n## Version\n\nBitbots 0.1.0-beta.43 on Windows 11\n\n## Coding agents\n\n- claude 2.1\n- codex 0.9\n\n## Health check\n\nEverything passed.\n'
    return { repo: 'sico-vibes/bloblex', title: '', body, url: 'https://github.com/sico-vibes/bloblex/issues/new', gh: { available: true, login: 'preview-user' } } as T
  }
  if (method === 'diagnostics.issuePost') {
    if (params.confirm !== true) throw rpcError('invalid_argument', 'Confirm posting the issue first.')
    return { url: 'https://github.com/sico-vibes/bloblex/issues/1' } as T
  }
  // Wave 14: the Bitbots MCP. `?preset=mcp` starts with it on and used a few minutes ago.
  if (method.startsWith('external.')) {
    const bridge = 'C:/Users/you/AppData/Local/com.bitbots.desktop/bitbots-mcp.exe'
    const endpoint = 'C:/Users/you/AppData/Local/com.bitbots.desktop/external-mcp.json'
    const status = () => ({ enabled: fixtureExternal.enabled, tier: fixtureExternal.tier, endpointPath: fixtureExternal.enabled ? endpoint : null, bridgePath: bridge, command: `claude mcp add bitbots -- "${bridge}" mcp-server --endpoint "${endpoint}"`, lastCallAt: fixtureExternal.lastCallAt, lastClient: fixtureExternal.lastClient, allowFullAccess: fixtureExternal.enabled && fixtureExternal.allowFullAccess })
    const changed = () => { notifyFixtureDaemon('external.changed', status()); return status() as T }
    if (method === 'external.status') return status() as T
    if (method === 'external.enable') {
      if (params.confirm !== true) throw rpcError('invalid_argument', 'Confirm turning on the Bitbots MCP first.')
      fixtureExternal.enabled = true
      if (typeof params.tier === 'string') fixtureExternal.tier = params.tier
      return changed()
    }
    if (method === 'external.disable') { fixtureExternal.enabled = false; fixtureExternal.allowFullAccess = false; return changed() }
    if (method === 'external.setFullAccess') {
      if (!fixtureExternal.enabled) throw rpcError('conflict', 'Turn the Bitbots MCP on first.')
      if (params.allow === true && params.confirm !== true) throw rpcError('invalid_argument', 'Confirm letting outside sessions give bots Full access first.')
      fixtureExternal.allowFullAccess = params.allow === true
      return changed()
    }
    if (method === 'external.setTier') {
      if (!fixtureExternal.enabled) throw rpcError('conflict', 'Turn on the Bitbots MCP first.')
      if (typeof params.tier === 'string') fixtureExternal.tier = params.tier
      return changed()
    }
    if (method === 'external.rotate') return changed()
  }
  if (method === 'session.handoff.draft') {
    const source = sessions.find((item) => item.id === params.fromSessionId)
    if (!source || source.archived) throw rpcError('not_found', 'Conversation not found.')
    const owner = agents.find((item) => item.id === source.agentId)
    const recent = (source.messages ?? []).filter((message) => message.role === 'user' || message.role === 'assistant').slice(-8)
    const lines = recent.map((message) => `${message.role === 'user' ? 'You' : owner?.name ?? 'Assistant'}: ${String(message.content ?? '').slice(0, 600)}`)
    const title = String(source.title || 'Conversation')
    const note = typeof params.note === 'string' && params.note.trim() ? `\n\n${params.note.trim()}` : ''
    return { draft: `Continue from ${owner?.name ?? `another ${entityNoun(themeStyle())}`}'s conversation "${title}".${note}\n\n${lines.join('\n')}`.slice(0, 4200), carried: { messages: recent.length, truncated: false }, fromAgentId: source.agentId ?? null, title } as T
  }
  if (method === 'session.steer') {
    const session = sessions.find((item) => item.id === params.sessionId)
    if (!session || session.archived) throw rpcError('not_found', 'Conversation not found.')
    if (fixtureSettings['exec_gate.codex.steer'] === false) throw rpcError('unsupported', 'Steering is turned off for this runtime.')
    if (!['working', 'waiting_permission'].includes(String(session.state))) throw rpcError('conflict', 'Nothing is running to steer.')
    const text = typeof params.text === 'string' ? params.text.trim() : ''
    if (!text) throw rpcError('invalid_argument', 'text must contain 1 to 100000 UTF-8 bytes')
    const turnId = String((session.turns ?? []).at(-1)?.id ?? 'turn-preview')
    const id = `steer-${Date.now()}`
    session.messages = [...(session.messages ?? []), { id, role: 'user', content: text, turnId, meta: { kind: 'steer' } }]
    notifyFixtureDaemon('message.completed', { sessionId: session.id, turnId, id, messageId: id, role: 'user', content: text, meta: { kind: 'steer' } })
    return { steered: true, turnId } as T
  }
  if (method === 'turn.retry.cancel') {
    const session = sessions.find((item) => item.id === params.sessionId)
    if (!session) throw rpcError('not_found', 'Conversation not found.')
    const queue = (fixtureQueues[session.id] ??= { items: [], paused: false })
    const at = queue.items.findIndex((entry) => entry.kind === 'retry')
    if (at < 0) throw rpcError('not_found', 'No automatic retry is pending.')
    queue.items.splice(at, 1)
    notifyFixtureDaemon('queue.changed', { sessionId: session.id, items: queue.items.map((entry) => ({ ...entry })), paused: queue.paused })
    return { cancelled: true } as T
  }
  if (typeof method === 'string' && method.startsWith('session.queue.')) {
    // An in-memory stand-in for the daemon's durable queue so the preview can show every state.
    const session = sessions.find((item) => item.id === params.sessionId)
    if (!session || session.archived) throw rpcError('not_found', 'Conversation not found.')
    const items = (fixtureQueues[session.id] ??= { items: [], paused: false })
    const publish = () => {
      items.items.forEach((entry, index) => { entry.position = index })
      notifyFixtureDaemon('queue.changed', { sessionId: session.id, items: items.items.map((entry) => ({ ...entry })), paused: items.paused })
    }
    if (method === 'session.queue.list') return { items: items.items.map((entry) => ({ ...entry })), paused: items.paused } as T
    if (method === 'session.queue.add') {
      if (session.link?.kind === 'side') throw rpcError('read_only', 'Side conversations are read-only. Send a new message in the main conversation.')
      const text = typeof params.text === 'string' ? params.text.trim() : ''
      const attachments = Array.isArray(params.attachments) ? params.attachments as Array<{ name: string; path: string }> : []
      if (!text && !attachments.length) throw rpcError('invalid_argument', 'text must contain 1 to 1000000 UTF-8 bytes')
      if (items.items.length >= 20) throw rpcError('conflict', 'The queue is full.')
      const dueAt = typeof params.dueAt === 'string' ? params.dueAt : null
      if (dueAt) {
        const delta = Date.parse(dueAt) - Date.now()
        if (!(delta >= 5_000 && delta <= 366 * 24 * 3_600_000)) throw rpcError('invalid_argument', 'Pick a time between a few seconds and one year from now.')
      }
      const entry = { id: `queue-${Date.now()}-${items.items.length}`, sessionId: session.id, text, attachments, kind: dueAt ? 'send_later' : 'user', dueAt, status: 'queued', error: null, position: items.items.length } as Record<string, unknown>
      items.items.push(entry)
      publish()
      return { item: { ...entry } } as T
    }
    const target = items.items.findIndex((entry) => entry.id === params.id)
    if (method === 'session.queue.delete') { if (target >= 0) items.items.splice(target, 1); publish(); return { ok: true } as T }
    if (method === 'session.queue.update') {
      if (target < 0) throw rpcError('not_found', 'That queued message is gone.')
      if (typeof params.text === 'string' && params.text.trim()) items.items[target].text = params.text.trim()
      publish()
      return { item: { ...items.items[target] } } as T
    }
    if (method === 'session.queue.reorder') {
      const ids = Array.isArray(params.ids) ? params.ids.map(String) : []
      const plain = items.items.filter((entry) => entry.kind === 'user')
      if (ids.length !== plain.length || !ids.every((id) => plain.some((entry) => entry.id === id))) throw rpcError('invalid_argument', 'Reorder must list every queued message once.')
      const rest = items.items.filter((entry) => entry.kind !== 'user')
      items.items = [...ids.map((id) => plain.find((entry) => entry.id === id)!), ...rest]
      publish()
      return { ok: true } as T
    }
    if (method === 'session.queue.send_now') {
      if (target < 0) throw rpcError('not_found', 'That queued message is gone.')
      const [entry] = items.items.splice(target, 1)
      items.items.unshift(entry)
      publish()
      return { queued: true } as T
    }
    if (method === 'session.queue.resume') { items.paused = false; publish(); return { ok: true } as T }
  }
  if (method === 'session.prompt') {
    // A minimal echo so the preview shows sent messages, # references and a reply.
    const session = sessions.find((item) => item.id === params.sessionId)
    if (!session) throw rpcError('not_found', 'session not found')
    const command = params.command as Record<string, unknown> | null | undefined
    if (command !== undefined && command !== null) {
      const kind = String(command.kind ?? '')
      const name = String(command.name ?? '')
      const owner = agents.find((agent) => agent.id === session.agentId)
      if (kind === 'skill') {
        const skill = fixtureSkills.find((item) => item.name === name)
        const off = !skill || skill.enabled === false || (skill.disabledFor as string[]).includes(String(session.agentId ?? ''))
        if (off) throw rpcError('invalid_argument', `The skill "${name}" is not available to this bot.`)
      } else if (kind === 'manager') {
        if (owner?.systemRole !== 'manager') throw rpcError('invalid_argument', 'That command is only for the Manager.')
      } else throw rpcError('invalid_argument', 'command.kind must be "skill" or "manager"')
    }
    let replySnapshot: NonNullable<MessageMeta['replyTo']> | null = null
    if (params.replyTo !== undefined && params.replyTo !== null) {
      const replyTo = params.replyTo as Record<string, unknown>
      if (replyTo.sourceSessionId !== session.id || typeof replyTo.messageId !== 'string') throw rpcError('invalid_argument', 'Replies must target a message in this writable conversation.')
      const source = (session.messages ?? []).find((message) => message.id === replyTo.messageId && ['user', 'assistant'].includes(String(message.role)))
      if (!source) throw rpcError('not_found', 'The quoted message is no longer available in this conversation.')
      const content = String(source.content ?? source.text ?? '')
      const excerptChars = Array.from(content)
      const truncated = excerptChars.length > 6000
      const author = source.role === 'user' ? 'You' : agents.find((agent) => agent.id === session.agentId)?.name ?? 'Coding agent'
      replySnapshot = { sourceSessionId: session.id, messageId: replyTo.messageId, role: source.role as 'user' | 'assistant', author, excerpt: `${excerptChars.slice(0, 6000).join('')}${truncated ? '…' : ''}`, truncated, createdAt: source.createdAt ?? null }
    }
    const refs = Array.isArray(params.conversationRefs) ? params.conversationRefs.map(String) : []
    const references = refs.map((id) => sessions.find((item) => item.id === id)).filter((item): item is Session => !!item).map((item) => ({ id: item.id, title: String(item.link?.topic ?? item.title ?? 'Conversation') }))
    const next = (session.messages ?? []).reduce((top, message) => Math.max(top, Number(message.sequence) || 0), 0) + 1
    const now = new Date().toISOString()
    if ((fixtureSettings['experimental.autoTitles'] === true || flags().has('experiments')) && session.link?.kind !== 'side' && !(session.messages ?? []).some((m) => m.role === 'user')) {
      const owner = agents.find((a) => a.id === session.agentId)
      if (owner && (session.title === owner.name || session.title === 'New chat')) session.title = String(params.text ?? '').split(/\s+/).slice(0, 6).join(' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').slice(0, 48)
    }
    session.messages = [...(session.messages ?? []), { id: `preview-user-${next}`, turnId: `preview-turn-${next}`, sequence: next, role: 'user', content: String(params.text ?? ''), createdAt: now, ...(references.length ? { references } : {}), ...(replySnapshot ? { meta: { replyTo: replySnapshot } } : {}) }]
    session.updatedAt = now
    notifyFixtureDaemon('session.changed', { session: { ...session } })
    window.setTimeout(() => {
      session.messages = [...(session.messages ?? []), { id: `preview-reply-${next}`, turnId: `preview-turn-${next}`, sequence: next + 1, role: 'assistant', content: references.length ? `Picking up "${references[0].title}" where it left off.` : 'Got it.', createdAt: new Date().toISOString() }]
      notifyFixtureDaemon('session.changed', { session: { ...session } })
    }, 700)
    return { turnId: `preview-turn-${next}` } as T
  }
  if (method === 'runtime.capabilities') {
    const supported = { supported: true, enabled: true, scope: 'agent', evidence: 'preview' }
    // Like the real daemon, OpenCode keeps effort behind its execution check.
    const thinking = params.runtimeId === 'runtime-opencode' ? { ...supported, enabled: false, reason: 'execution entry gate is disabled' } : supported
    // Steering exists for Codex only, is open by default (FIX39 P13: the gate
    // follows the adapter's capability) and is never proven.
    const steer = params.runtimeId === 'runtime-codex'
      ? { supported: true, enabled: fixtureSettings['exec_gate.codex.steer'] !== false, scope: 'turn', evidence: 'none', ...(fixtureSettings['exec_gate.codex.steer'] === false ? { reason: 'execution entry gate is disabled' } : {}) }
      : { supported: false, enabled: false, scope: 'turn', evidence: 'none', reason: 'setting is unsupported by this runtime' }
    return { runtimeId: params.runtimeId, generatesImages: params.runtimeId === 'runtime-codex', settings: { model: supported, thinking, serviceTier: supported, instructions: supported, customEnv: supported, steer } } as T
  }
  if (method === 'media.preview' && typeof params.mediaId === 'string') {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 400
    const paint = canvas.getContext('2d')!
    const sky = paint.createLinearGradient(0, 0, 0, 400)
    sky.addColorStop(0, '#2b3a67')
    sky.addColorStop(1, '#f6a65a')
    paint.fillStyle = sky
    paint.fillRect(0, 0, 640, 400)
    paint.fillStyle = '#ffe9b0'
    paint.beginPath()
    paint.arc(320, 300, 70, 0, Math.PI * 2)
    paint.fill()
    return { status: 'ok', reason: null, name: 'sunrise.png', relativePath: null, kind: 'image', mediaType: 'image/png', size: 182_400, dataUrl: canvas.toDataURL('image/png') } as T
  }
  if (method === 'media.reveal') return { ok: true } as T
  if (method === 'runtime.models') {
    const runtimeId = String(params.runtimeId ?? '')
    return fixtureCatalog(runtimeId) as T
  }
  if (method === 'agent.list') {
    const includeArchived = params.includeArchived === true
    const runtimeId = typeof params.runtimeId === 'string' ? params.runtimeId : undefined
    const list = sortAgents(agents.filter((agent) => (includeArchived || !agent.archived) && (!runtimeId || agent.runtimeId === runtimeId)))
    return { agents: list } as T
  }
  if (method === 'agent.get') {
    const agent = agents.find((item) => item.id === params.agentId)
    if (!agent) throw rpcError('not_found', `That ${entityNoun(themeStyle())} is no longer available.`)
    return { agent: { ...agent } } as T
  }
  if (method === 'manager.get') {
    return { manager: agents.find((agent) => agent.systemRole === 'manager') ?? null } as T
  }
  if (method === 'manager.ensure') {
    const existing = agents.find((agent) => agent.systemRole === 'manager')
    if (existing) return { manager: { ...existing }, created: false } as T
    const runtimeId = typeof params.runtimeId === 'string' ? params.runtimeId : ''
    if (!baseRuntimes.some((runtime) => runtime.id === runtimeId)) throw rpcError('not_found', 'That runtime is no longer available.')
    const now = new Date().toISOString()
    const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : 'Manager'
    const manager: Agent = {
      id: `agent-manager-${agentSerial++}`,
      name,
      description: managerDescription,
      instructions: managerInstructions,
      color: 'mint',
      runtimeId,
      model: typeof params.model === 'string' ? params.model : null,
      thinking: typeof params.thinking === 'string' ? params.thinking : null,
      serviceTier: null,
      customArgs: [],
      customEnv: {},
      maxConcurrency: 1,
      defaultProject: null,
      sortOrder: agents.filter((agent) => agent.runtimeId === runtimeId && !agent.archived).reduce((max, agent) => Math.max(max, agent.sortOrder), -1) + 1,
      archived: false,
      createdAt: now,
      updatedAt: now,
      approvalMode: 'ask',
      effectiveApprovalMode: 'ask',
      projectId: null,
      role: 'Manager',
      leader: false,
      hidden: false,
      systemRole: 'manager',
    }
    agents = sortAgents([...agents, manager])
    sequence += 1
    return { manager, created: true } as T
  }
  if (method === 'manager.profile.list') {
    return { facts: fixtureManagerFacts.map((fact) => ({ ...fact })) } as T
  }
  if (method === 'manager.profile.set') {
    const category = typeof params.category === 'string' ? params.category : ''
    const key = typeof params.key === 'string' ? params.key.trim() : ''
    const value = typeof params.value === 'string' ? params.value.trim() : ''
    if (!['identity', 'workflow', 'style', 'conventions', 'design', 'other'].includes(category)) throw rpcError('invalid_argument', 'category must be identity, workflow, style, conventions, design or other.')
    if (!key || key.length > 80) throw rpcError('invalid_argument', 'key is required, up to 80 characters.')
    if (!value || value.length > 1000) throw rpcError('invalid_argument', 'value is required, up to 1000 characters.')
    if (/(sk-[A-Za-z0-9]{8,}|ghp_|AKIA|-----BEGIN|bearer\s)/i.test(value)) throw rpcError('invalid_argument', 'That looks like a credential; the profile must never store secrets.')
    const now = new Date().toISOString()
    const existing = fixtureManagerFacts.find((item) => item.category === category && item.key === key)
    if (existing) {
      existing.value = value
      existing.source = 'corrected'
      if (typeof params.locked === 'boolean') existing.locked = params.locked
      existing.updatedAt = now
      notifyFixtureDaemon('manager.profile.changed', { action: 'updated', fact: { ...existing } })
      return { fact: { ...existing } } as T
    }
    const fact = { id: `fact-${++agentSerial}`, category, key, value, source: 'said', locked: params.locked === true, createdAt: now, updatedAt: now }
    fixtureManagerFacts.push(fact)
    notifyFixtureDaemon('manager.profile.changed', { action: 'added', fact: { ...fact } })
    return { fact: { ...fact } } as T
  }
  if (method === 'manager.profile.delete') {
    const index = fixtureManagerFacts.findIndex((item) => item.id === params.id)
    if (index < 0) throw rpcError('not_found', 'That fact is gone.')
    const [removed] = fixtureManagerFacts.splice(index, 1)
    notifyFixtureDaemon('manager.profile.changed', { action: 'deleted', id: removed.id })
    return { deleted: true } as T
  }
  if (method === 'manager.playbook.get') {
    return { playbook: { ...fixturePlaybookVersions[fixturePlaybookVersions.length - 1] } } as T
  }
  if (method === 'manager.playbook.history') {
    return { versions: [...fixturePlaybookVersions].reverse().map((version) => ({ ...version })) } as T
  }
  if (method === 'manager.playbook.set') {
    const text = typeof params.text === 'string' ? params.text.trim() : ''
    if (!text || text.length > 16000) throw rpcError('invalid_argument', 'The playbook text must be 1 to 16000 characters.')
    const version = { version: fixturePlaybookVersions.length + 1, text, author: 'user', createdAt: new Date().toISOString() }
    fixturePlaybookVersions.push(version)
    notifyFixtureDaemon('manager.playbook.changed', { version: { ...version } })
    return { playbook: { ...version } } as T
  }
  if (method === 'manager.playbook.revert') {
    const target = fixturePlaybookVersions.find((version) => version.version === params.version)
    if (!target) throw rpcError('not_found', 'No such playbook version.')
    const version = { version: fixturePlaybookVersions.length + 1, text: target.text, author: 'user', createdAt: new Date().toISOString() }
    fixturePlaybookVersions.push(version)
    notifyFixtureDaemon('manager.playbook.changed', { version: { ...version } })
    return { playbook: { ...version } } as T
  }
  if (method === 'agent.create') {
    const name = typeof params.name === 'string' ? params.name.trim() : ''
    const runtimeId = typeof params.runtimeId === 'string' ? params.runtimeId : ''
    if (!name || !runtimeId) throw rpcError('invalid_argument', 'Check the name, description, colour, and runtime, then try again.')
    if (!baseRuntimes.some((runtime) => runtime.id === runtimeId)) throw rpcError('not_found', 'That runtime is no longer available.')
    if (nameTaken(name)) throw rpcError('conflict', `Another ${entityNoun(themeStyle())} already uses this name.`)
    const sortOrder = agents.filter((agent) => agent.runtimeId === runtimeId && !agent.archived).reduce((max, agent) => Math.max(max, agent.sortOrder), -1) + 1
    const now = new Date().toISOString()
    const agent: Agent = {
      id: `agent-new-${agentSerial++}`,
      name,
      description: typeof params.description === 'string' ? params.description : '',
      instructions: typeof params.instructions === 'string' ? params.instructions : '',
      color: typeof params.color === 'string' ? params.color : 'mint',
      runtimeId,
      model: typeof params.model === 'string' || params.model === null ? params.model as string | null : null,
      thinking: typeof params.thinking === 'string' || params.thinking === null ? params.thinking as string | null : null,
      serviceTier: typeof params.serviceTier === 'string' || params.serviceTier === null ? params.serviceTier as string | null : null,
      customArgs: Array.isArray(params.customArgs) ? params.customArgs.filter((item): item is string => typeof item === 'string') : [],
      customEnv: params.customEnv && typeof params.customEnv === 'object' && !Array.isArray(params.customEnv) ? params.customEnv as Record<string, string> : {},
      maxConcurrency: typeof params.maxConcurrency === 'number' ? params.maxConcurrency : 1,
      defaultProject: typeof params.defaultProject === 'string' ? params.defaultProject : null,
      sortOrder,
      archived: false,
      createdAt: now,
      updatedAt: now,
    }
    agents = sortAgents([...agents, agent])
    sequence += 1
    return { agent } as T
  }
  if (method === 'agent.update') {
    const agentId = typeof params.agentId === 'string' ? params.agentId : ''
    const existing = agents.find((agent) => agent.id === agentId)
    if (!existing) throw rpcError('not_found', `That ${entityNoun(themeStyle())} is no longer available.`)
    if (existing.archived) throw rpcError('conflict', `This ${entityNoun(themeStyle())} is archived and cannot be edited.`)
    if (typeof params.name === 'string' && nameTaken(params.name, existing.id)) throw rpcError('conflict', `Another ${entityNoun(themeStyle())} already uses this name.`)
    const nextRuntime = typeof params.runtimeId === 'string' ? params.runtimeId : existing.runtimeId
    if (!baseRuntimes.some((runtime) => runtime.id === nextRuntime)) throw rpcError('not_found', 'That runtime is no longer available.')
    const updated: Agent = {
      ...existing,
      name: typeof params.name === 'string' ? params.name.trim() : existing.name,
      description: typeof params.description === 'string' ? params.description : existing.description,
      instructions: typeof params.instructions === 'string' ? params.instructions : existing.instructions,
      color: typeof params.color === 'string' ? params.color : existing.color,
      runtimeId: nextRuntime,
      defaultProject: Object.prototype.hasOwnProperty.call(params, 'defaultProject') ? (typeof params.defaultProject === 'string' ? params.defaultProject : null) : existing.defaultProject,
      updatedAt: new Date().toISOString(),
    }
    agents = sortAgents(agents.map((agent) => agent.id === updated.id ? updated : agent))
    sequence += 1
    return { agent: updated } as T
  }
  if (method === 'agent.delete') {
    const agentId = typeof params.agentId === 'string' ? params.agentId : ''
    const existing = agents.find((agent) => agent.id === agentId)
    if (!existing) throw rpcError('not_found', `That ${entityNoun(themeStyle())} is no longer available.`)
    if (existing.systemRole === 'manager') throw rpcError('conflict', "The Manager can't be removed; you can rename it or change its model")
    const archived = { ...existing, archived: true, updatedAt: new Date().toISOString() }
    agents = sortAgents(agents.map((agent) => agent.id === archived.id ? archived : agent))
    sequence += 1
    return { agent: archived } as T
  }
  if (method === 'session.new') {
    const agentId = typeof params.agentId === 'string' ? params.agentId : undefined
    const runtimeId = typeof params.runtimeId === 'string' ? params.runtimeId : undefined
    if (!!agentId === !!runtimeId) throw rpcError('invalid_argument', 'Choose a project folder that exists on this device.')
    let resolvedRuntime = runtimeId
    let owner: string | null = null
    if (agentId) {
      const agent = agents.find((item) => item.id === agentId)
      if (!agent) throw rpcError('not_found', `That ${entityNoun(themeStyle())} is no longer available.`)
      if (agent.archived) throw rpcError('conflict', `This ${entityNoun(themeStyle())} is archived, so a new session cannot be started.`)
      resolvedRuntime = agent.runtimeId
      owner = agent.id
    }
    if (!resolvedRuntime || !baseRuntimes.some((runtime) => runtime.id === resolvedRuntime)) throw rpcError('not_found', `That ${entityNoun(themeStyle())} is no longer available.`)
    if (typeof params.projectPath !== 'string' || !params.projectPath.trim()) throw rpcError('invalid_argument', 'Choose a project folder that exists on this device.')
    const title = typeof params.title === 'string' && params.title.trim() ? params.title : 'New chat'
    const agent = owner ? agents.find((item) => item.id === owner) : undefined
    const catalog = fixtureCatalog(resolvedRuntime)
    const model = agent?.model ?? catalog.models.find((item) => item.isDefault === true)?.id ?? null
    const selected = catalog.models.find((item) => item.id === model)
    const thinking = agent?.thinking ?? selected?.defaultThinking ?? null
    const session: Session = { id: `session-new-${sessions.length + 1}`, runtimeId: resolvedRuntime, agentId: owner, title, projectPath: params.projectPath, state: 'idle', ...(model ? { model } : {}), modelLock:{ model, thinking }, contextUsed:null, contextSize:null, updatedAt: new Date().toISOString(), messages: [] }
    sessions = [...sessions, session]
    sequence += 1
    return { session } as T
  }
  if (method === 'agent.conversation' || method === 'agent.conversation.create') {
    const agent = agents.find((item) => item.id === params.agentId && !item.archived)
    if (!agent) throw rpcError('not_found', `That ${entityNoun(themeStyle())} is no longer available.`)
    const existing = method === 'agent.conversation' ? sessions.filter((session) => session.agentId === agent.id && !session.archived && !session.link).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] : undefined
    if (existing) return { session: { ...existing }, created: false } as T
    // Phase 1A: a conversation picks its project (an id, null for none); otherwise the bot's last, then default, project.
    const wanted = params.projectId === null ? null : typeof params.projectId === 'string' ? params.projectId : (agent.lastProjectId ?? agent.projectId ?? null)
    const project = wanted ? projects.find((item) => item.id === wanted) : undefined
    if (wanted && !project) throw rpcError('not_found', 'That project no longer exists.')
    if (project && !project.path) throw rpcError('invalid_argument', 'That project has no folder on this computer.')
    const title = typeof params.title === 'string' && params.title.trim() ? params.title.trim() : 'New chat'
    // Like the daemon, a lazily created conversation is stored untitled and named
    // from the first message, never with the bot's own name.
    const session: Session = { id: `session-new-${sessions.length + 1}`, runtimeId: agent.runtimeId, agentId: agent.id, title, projectPath: project?.path ?? `C:/Bloblex/workspaces/${agent.id}`, projectId: project?.id ?? null, projectName: project?.name ?? null, state: 'idle', modelLock: { model: agent.model, thinking: agent.thinking }, contextUsed: null, contextSize: null, updatedAt: new Date().toISOString(), messages: [] }
    sessions = [...sessions, session]
    return { session, created: true } as T
  }
  if (method === 'agent.team.update') {
    const agent = agents.find((item) => item.id === params.agentId)
    if (!agent) throw rpcError('not_found', `That ${entityNoun(themeStyle())} is no longer available.`)
    if (agent.systemRole === 'manager' && typeof params.projectId === 'string') throw rpcError('conflict', 'The Manager works across every project')
    if (agent.systemRole === 'manager' && 'leader' in params) throw rpcError('conflict', "The Manager can't be removed; you can rename it or change its model")
    if (params.leader === true) agents = agents.map((item) => item.id === agent.id ? item : { ...item, leader: false })
    const patch: Partial<Agent> = {}
    if ('projectId' in params) patch.projectId = typeof params.projectId === 'string' ? params.projectId : null
    if (typeof params.role === 'string') patch.role = params.role.trim()
    if (typeof params.leader === 'boolean') patch.leader = params.leader
    if (typeof params.hidden === 'boolean') patch.hidden = params.hidden
    agents = agents.map((item) => item.id === agent.id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item)
    return { agent: { ...agents.find((item) => item.id === agent.id)! } } as T
  }
  if (method === 'project.create') {
    const project: Project = { id: `project-${projects.length + 1}`, name: String(params.name ?? 'Project'), path: typeof params.path === 'string' ? params.path : null, sortOrder: projects.length, collapsed: false }
    projects = [...projects, project]
    return { project } as T
  }
  if (method === 'project.update') {
    if ((params.overrides as { approvalMode?: unknown } | undefined)?.approvalMode === 'bypass' && params.confirm !== true) throw rpcError('invalid_argument', 'Confirm Full access for this project first.')
    if (params.overrides) projects = projects.map((project) => project.id === params.projectId ? { ...project, overrides: params.overrides as Project['overrides'] } : project)
    projects = projects.map((project) => project.id === params.projectId ? { ...project, ...(typeof params.name === 'string' ? { name: params.name } : {}), ...(typeof params.collapsed === 'boolean' ? { collapsed: params.collapsed } : {}), ...('path' in params ? { path: typeof params.path === 'string' ? params.path : null } : {}) } : project)
    return { project: projects.find((project) => project.id === params.projectId) } as T
  }
  if (method === 'project.delete') {
    projects = projects.filter((project) => project.id !== params.projectId)
    agents = agents.map((agent) => agent.projectId === params.projectId ? { ...agent, projectId: null } : agent)
    return { deleted: true } as T
  }
  if (method === 'permission.reply' && params.permissionId === 'perm-question') {
    sessions = sessions.map((session) => session.id === teamMainId ? { ...session, state: 'idle' } : session)
    notifyFixtureDaemon('permission.resolved', { permissionId: 'perm-question' })
    return { resolved: true } as T
  }
  if (method === 'proposal.decide' && params.id === 'perm-proposal') {
    const decision = params.decision === 'approve' ? 'approved' : 'rejected'
    fixtureProposalPending = false
    notifyFixtureDaemon('permission.resolved', { permissionId: 'perm-proposal', choice: params.decision === 'approve' ? 'approve' : 'reject' })
    notifyFixtureDaemon('proposal.changed', { id: 'perm-proposal', kind: 'bot', sessionId: teamMainId, status: decision })
    return { id: 'perm-proposal', decision } as T
  }
  if (method === 'usage.analytics') return answerUsageAnalytics(params, flags().get('analytics')) as T
  return {} as T
}
let experimentalFixtureSeeded = false
function seedExperimentalFixtures() {
  if (!flags().has('experiments') || experimentalFixtureSeeded) return
  experimentalFixtureSeeded = true
  for (const session of sessions) {
    if (session.archived || session.link?.kind === 'side') continue
    let turnId: string | null = null
    for (const message of session.messages ?? []) {
      if (message.role === 'user') turnId = String(message.turnId ?? `fixture-turn-${session.id}-${message.id}`)
      if (message.role === 'user' || message.role === 'assistant') message.turnId ??= turnId ?? undefined
    }
    const reply = (session.messages ?? []).filter((m) => m.role === 'assistant' && m.turnId).at(-1)
    if (reply && !(session.files?.length)) session.files = [{
      id: `fixture-review-${session.id}`, turnId: reply.turnId, path: 'docs/example.md',
      detail: { path: 'docs/example.md', change: 'update', diff: '--- a/docs/example.md\n+++ b/docs/example.md\n@@ -1 +1 @@\n-Old note\n+Updated note\n' },
    }]
  }
}

export async function fetchSnapshot() {
  ensureRemoteFixture()
  seedExperimentalFixtures()
  if (fixturePreset() === 'opencode-runtime-error') setPreviewSelection('agent-opencode')
  else if (fixturePreset() === 'claude-context') setPreviewSelection('agent-claude')
  else if (fixturePreset() === 'usage-tip-90') {
    setPreviewSelection('agent-invoice')
    for (const session of sessions.filter((item) => item.agentId === 'agent-invoice')) session.state = 'idle'
  }
  const snapshot = currentSnapshot()
  snapshot.remote = await remoteSimulator.call('remote.status', {}) as RemoteStatus
  return snapshot
}
export async function ensureDaemon() {}
export async function startDaemonEventStream() {}
const PREVIEW_SUPERVISOR: DaemonSupervisor = { state: 'running', attempt: 0, nextRetryMs: null, lastExitCode: null }
export async function listenForDaemonSupervisor(_handler: (state: DaemonSupervisor) => void): Promise<Unlisten> { return noop }
export async function daemonSupervisorState(): Promise<DaemonSupervisor> { return PREVIEW_SUPERVISOR }
export async function restartDaemonNow(): Promise<DaemonSupervisor> { return PREVIEW_SUPERVISOR }
export async function openProjectFolder() { return null }
export async function selectLocalFile() { return null }
let stagedAttachmentSerial = 0
export async function stagePromptAttachment(bytes: Uint8Array) {
  if (!bytes.length) throw new Error('The image could not be read.')
  stagedAttachmentSerial += 1
  return `C:/preview/attachments/staged-${stagedAttachmentSerial}.png`
}
export async function readClipboardImage() {
  const response = await fetch('/src/assets/bloblex-128.png')
  if (!response.ok) throw new Error('The preview image is unavailable.')
  return new Uint8Array(await response.arrayBuffer())
}
export async function selectMarkdownExportPath() { return 'preview-markdown-token' }
export async function writeMarkdownExport(_selectionToken: string, _text: string) {}
export async function selectBlobExportPath(_name: string) { return 'preview-blob-export-token' }
export async function selectBlobImportPath() { return 'preview-blob-import-token' }
export async function readBlobImport(_selectionToken: string) {
  return JSON.stringify({
    format: 'bloblex.blob.v1', name: 'Mochi', description: 'Reviews pull requests and keeps the test suite green.', colour: '#f6a04d',
    instructions: 'Read the diff first. Run the tests before you say something works. Keep reviews short and kind.',
    model: 'gpt-6.1-sol', thinking: 'low', speed: null, look: { shape: 'pebble', seed: 'mochi' }, defaultApprovalMode: 'ask', providerId: 'codex',
  }, null, 2)
}
export async function writeBlobExport(_selectionToken: string, _text: string) {}
// Preview stand-ins for the backup types `src/tauri.ts` exports, so the backup
// page type-checks against the fixture bridge unchanged.
export type BackupInclude = { memory?: boolean; skills?: boolean; automations?: boolean; settings?: boolean }
export type BackupExportRequest = BackupInclude & { agentIds?: string[] }
export type BackupStats = { bots: number; memory: number; skills: number; automations: number; settings: number }
export async function selectBackupExportPath(_suggestedName?: string) { return 'preview-backup-export-token' }
export async function selectBackupImportPath() { return 'preview-backup-import-token' }
export type DiagnosticsPreview = { generatedAt: string; fileName: string; files: { name: string; sizeBytes: number }[] }
export async function selectDiagnosticsExportPath() { return 'preview-diagnostics-token' }
export async function writeDiagnosticsExport(_selectionToken: string): Promise<{ path: string; sizeBytes: number; files: { name: string; sizeBytes: number }[] }> {
  return {
    path: 'C:\\Users\\you\\Documents\\bitbots-diagnostics-2026-10-18.zip',
    sizeBytes: 48_512,
    files: [
      { name: 'README.txt', sizeBytes: 900 },
      { name: 'environment.json', sizeBytes: 640 },
      { name: 'settings.json', sizeBytes: 1_240 },
      { name: 'events.json', sizeBytes: 12_800 },
      { name: 'logs/daemon.2026-10-18.log', sizeBytes: 33_932 },
    ],
  }
}
export async function writeBackupExport(_selectionToken: string, _include?: BackupExportRequest) {
  return { path: 'C:\\Users\\you\\Documents\\bitbots-backup-2026-10-17.bitbots-backup.json', stats: { bots: agents.length, memory: fixtureMemory.length, skills: fixtureSkills.length, automations: 1, settings: 9 } }
}
export async function previewBackupImport(_selectionToken: string) {
  return {
    previewId: 'preview-backup',
    counts: { bots: 3, memory: 14, skills: 2, automations: 1, settings: 9 },
    conflicts: {
      bots: [{ exportId: 'export-1', name: String(agents[0]?.name ?? 'Mochi'), existingAgentId: String(agents[0]?.id ?? 'agent-1') }],
      skills: [{ name: 'pdf', same: false }, { name: 'release-notes', same: true }],
      memory: [],
      settings: [{ key: 'appearance.theme', current: 'dark', incoming: 'light' }],
    },
    warnings: ['This backup contains a leader, but a leader is already set; the restored bot will not lead.', 'One bot used Bypass approvals; it is restored as Ask.'],
  }
}
export async function inspectLocalFile(path: string) { return { path, fileName: path.split(/[\\/]/).pop() ?? path, sizeBytes: 2048 } }
export async function openInEditor() {}
export async function saveGeneratedImage(_sessionId: string, _mediaId: string) { return true }
export async function revealInExplorer() {}
export async function resolveProjectFile(path: string) { return path }
// The preview opens no window; the shape is what the sign-in sheet expects.
export async function runtimeTerminal(_provider: string, _action: string) { return { launched: true, terminal: 'wt' as const } }
const harnessPreviewVersions: Record<string, string> = { claude: '2.1.303', codex: '0.159.3', opencode: '1.18.34' }
export async function harnessLatestVersion(provider: string) {
  if (!fixturePreset()?.startsWith('harness-update')) throw new Error('No preview update is available.')
  return harnessPreviewVersions[provider] ?? ''
}
export async function harnessUpdate(provider: string) {
  if (!fixturePreset()?.startsWith('harness-update')) throw new Error('Harness updates are unavailable in this preview.')
  if (fixturePreset() === 'harness-update-progress') await new Promise((resolve) => setTimeout(resolve, 30_000))
  return { provider, version: harnessPreviewVersions[provider] ?? '2.1.303' }
}
export async function showMainWindow() {}
export async function showMainSettings(_sessionId?: string | null, _page?: string) {}
export async function setActiveSession() {}
export async function getActiveSession() { return composerPreviewSessionId }
export async function setActiveRuntime() {}
export async function getActiveRuntime() { return 'runtime-codex' }
export async function setCompanionVisibility() {}
export async function setCloseToTray() {}
export async function companionMonitorOptions() { return [] as string[] }
export async function currentCompanionMonitor() { return null }
export async function setCompanionMonitor() {}
export async function refreshTrayMenu() {}
const companionSizes: Record<string, [number, number]> = { petit: [344, 62], hidden: [344, 62], welcome: [640, 160], home: [640, 420], 'home-chat': [640, 420] }
/** The preview has no real window: the expanded size lives here, and the resize handles change it. */
let fixtureCompanionSize: [number, number] = [640, 420]
let fixtureCompanionMode = 'petit'
let fixtureCompanionDrag: { edge: string; x: number; y: number; size: [number, number] } | null = null
let fixturePointer: [number, number] = [0, 0]
if (typeof window !== 'undefined') for (const type of ['pointerdown', 'pointermove']) window.addEventListener(type, (event) => { fixturePointer = [(event as PointerEvent).screenX, (event as PointerEvent).screenY] }, true)
function paintFixtureCompanion() {
  const [width, height] = fixtureCompanionMode === 'petit' || fixtureCompanionMode === 'hidden' ? [344, 62] : fixtureCompanionSize
  let style = document.getElementById('fixture-companion-size')
  if (!style) { style = document.createElement('style'); style.id = 'fixture-companion-size'; document.head.append(style) }
  style.textContent = `:root.companion-surface body { background: radial-gradient(900px 500px at 70% 10%, #3b2f63, #12131a) !important; }
    .companion-root { position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); width: ${width}px !important; height: ${height}px !important; }`
}
export type CompanionEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
export async function companionResizeBegin(edge: CompanionEdge) { fixtureCompanionDrag = { edge, x: fixturePointer[0], y: fixturePointer[1], size: [...fixtureCompanionSize] } }
export async function companionResizeStep() {
  const drag = fixtureCompanionDrag
  if (!drag) return
  // The preview window grows from its bottom centre, so a side moves twice as far as the pointer.
  const dx = (fixturePointer[0] - drag.x) * (drag.edge.includes('w') ? -2 : drag.edge.includes('e') ? 2 : 0)
  const dy = (fixturePointer[1] - drag.y) * (drag.edge.includes('n') ? -1 : drag.edge.includes('s') ? 1 : 0)
  fixtureCompanionSize = [Math.min(window.innerWidth - 20, Math.max(520, drag.size[0] + dx)), Math.min(window.innerHeight - 60, Math.max(340, drag.size[1] + dy))]
  paintFixtureCompanion()
}
export async function companionResizeEnd(): Promise<[number, number] | null> { fixtureCompanionDrag = null; return fixtureCompanionSize }
export async function setCompanionSizePreset(preset: 'large' | 'normal' | 'default') {
  fixtureCompanionSize = preset === 'large' ? [Math.min(960, window.innerWidth - 20), Math.min(720, window.innerHeight - 60)] : [640, 420]
  paintFixtureCompanion()
  return preset === 'large'
}
// Next run times for the cron shapes the editor produces (daily, weekdays, one weekday, every n hours), in local time; a custom line the shapes do not cover falls back to daily at its hour and minute.
function fixtureNextRuns(schedule: { kind?: string; cron?: string; at?: string }, count: number): string[] {
  if (schedule.kind === 'once') return [new Date(String(schedule.at)).toISOString()]
  const [minute = '0', hour = '9', , , dow = '*'] = String(schedule.cron ?? '').trim().split(/\s+/)
  const every = /^\*\/(\d+)$/.exec(hour)
  const minutes = /^\d+$/.test(minute) ? Number(minute) : 0
  const hours = every ? Array.from({ length: Math.ceil(24 / Number(every[1])) }, (_, index) => index * Number(every[1])).filter((value) => value < 24) : [/^\d+$/.test(hour) ? Number(hour) : 9]
  const days = dow === '*' ? null : dow === '1-5' ? [1, 2, 3, 4, 5] : /^\d$/.test(dow) ? [Number(dow)] : null
  const now = Date.now()
  const runs: string[] = []
  for (let offset = 0; offset < 400 && runs.length < count; offset += 1) {
    const day = new Date(); day.setDate(day.getDate() + offset)
    if (days && !days.includes(day.getDay())) continue
    for (const at of hours) {
      const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), at, minutes, 0, 0)
      if (candidate.getTime() > now && runs.length < count) runs.push(candidate.toISOString())
    }
  }
  return runs
}
export async function setCompanionMode(mode: string, _animate?: boolean) {
  fixtureCompanionMode = mode
  const [width, height] = mode === 'petit' || mode === 'hidden' ? companionSizes.petit : fixtureCompanionSize
  let style = document.getElementById('fixture-companion-size')
  if (!style) { style = document.createElement('style'); style.id = 'fixture-companion-size'; document.head.append(style) }
  style.textContent = `:root.companion-surface body { background: radial-gradient(900px 500px at 70% 10%, #3b2f63, #12131a) !important; }
    .companion-root { position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); width: ${width}px !important; height: ${height}px !important; transition: width .34s, height .34s; }`
}
export async function quitBloblex() {}
export async function permissionsPolicyGet() {
  return { defaultMode: 'ask' as const, perAgent: [] }
}
export async function listenForActiveSession(): Promise<Unlisten> { return noop }
export async function listenForActiveRuntime(): Promise<Unlisten> { return noop }
export async function listenForOpenSettings(_handler?: (page: string | null) => void): Promise<Unlisten> { return noop }
export async function listenForDaemonEvents(handler: (event: DaemonEvent) => void): Promise<Unlisten> { daemonListeners.add(handler); return () => daemonListeners.delete(handler) }
function notifyFixtureDaemon(type: string, payload: Record<string, unknown>) {
  const event = { sequence: ++sequence, type, payload } as DaemonEvent
  for (const handler of daemonListeners) handler(event)
}
export async function listenForDaemonConnection(handler: (connected: boolean) => void): Promise<Unlisten> {
  if (flags().has('disconnected')) handler(false)
  return noop
}

const updateAvailableHandlers = new Set<(info: UpdateInfo) => void>()
const updateProgressHandlers = new Set<(progress: UpdateProgress) => void>()

function fixtureUpdateChannel(): UpdateChannel {
  return flags().get('channel') === 'stable' ? 'stable' : 'beta'
}

function fixtureUpdateInfo(channel: UpdateChannel): UpdateInfo {
  return { version: '0.2.0', notes: 'Preview notes for this release.', pubDate: '2026-10-01T12:00:00.000Z', channel }
}

function fixtureUpdatesState(): UpdatesState {
  const mode = flags().get('updates') ?? 'up_to_date'
  const channel = fixtureUpdateChannel()
  return {
    currentVersion: '0.1.0',
    channel,
    autoCheck: flags().get('autoCheck') !== '0',
    lastCheckedAt: mode === 'idle' ? null : '2026-10-02T08:00:00.000Z',
    available: mode === 'available' || mode === 'progress' ? fixtureUpdateInfo(channel) : null,
    devBuild: mode === 'dev',
  }
}

let previewUpdates = fixtureUpdatesState()

export async function updatesGetState(): Promise<UpdatesState> {
  previewUpdates = { ...previewUpdates, ...fixtureUpdatesState(), channel: previewUpdates.channel, autoCheck: previewUpdates.autoCheck }
  return { ...previewUpdates, available: previewUpdates.available ? { ...previewUpdates.available } : null }
}

export async function updatesSetPreferences(preferences: { channel?: string; autoCheck?: boolean }): Promise<UpdatesState> {
  const channel = parseUpdateChannel(preferences.channel)
  if (preferences.channel != null && !channel) throw new Error('invalid_argument')
  previewUpdates = {
    ...previewUpdates,
    ...(channel ? { channel } : {}),
    ...(typeof preferences.autoCheck === 'boolean' ? { autoCheck: preferences.autoCheck } : {}),
  }
  return updatesGetState()
}

export async function updatesCheck() {
  const mode = flags().get('updates') ?? 'up_to_date'
  if (mode === 'checking') await new Promise((resolve) => setTimeout(resolve, 1200))
  const checkedAt = new Date().toISOString()
  if (previewUpdates.devBuild || mode === 'dev') return { status: 'error' as const, checkedAt, error: 'unavailable' as const }
  if (mode === 'error') {
    const error = flags().get('updateError')
    const code = error === 'signature' || error === 'manifest' || error === 'unavailable' || error === 'network' ? error : 'network'
    return { status: 'error' as const, checkedAt, error: code }
  }
  if (mode === 'no_stable_release') {
    previewUpdates = { ...previewUpdates, available: null, lastCheckedAt: checkedAt }
    return { status: 'no_stable_release' as const, checkedAt }
  }
  if (mode === 'available' || mode === 'progress') {
    const update = fixtureUpdateInfo(previewUpdates.channel)
    previewUpdates = { ...previewUpdates, available: update, lastCheckedAt: checkedAt }
    for (const handler of updateAvailableHandlers) handler({ ...update })
    return { status: 'available' as const, checkedAt, update }
  }
  previewUpdates = { ...previewUpdates, available: null, lastCheckedAt: checkedAt }
  return { status: 'up_to_date' as const, checkedAt }
}

export async function updatesInstall() {
  if (!previewUpdates.available) throw new Error('no_update')
  const known = flags().get('updateProgress') !== 'unknown'
  const steps: UpdateProgress[] = known
    ? [
      { phase: 'downloading', downloadedBytes: 256, totalBytes: 1024 },
      { phase: 'downloading', downloadedBytes: 1024, totalBytes: 1024 },
      { phase: 'installing', downloadedBytes: 1024, totalBytes: 1024 },
    ]
    : [
      { phase: 'downloading', downloadedBytes: 256, totalBytes: null },
      { phase: 'installing', downloadedBytes: 256, totalBytes: null },
    ]
  for (const step of steps) {
    for (const handler of updateProgressHandlers) handler({ ...step })
    await new Promise((resolve) => setTimeout(resolve, 280))
  }
}

export async function listenForUpdateAvailable(handler: (info: UpdateInfo) => void): Promise<Unlisten> {
  updateAvailableHandlers.add(handler)
  return () => { updateAvailableHandlers.delete(handler) }
}

export async function listenForUpdateProgress(handler: (progress: UpdateProgress) => void): Promise<Unlisten> {
  updateProgressHandlers.add(handler)
  return () => { updateProgressHandlers.delete(handler) }
}

const updateStateHandlers = new Set<(state: UpdatePhaseState) => void>()
const UPDATE_PHASE_FLAGS = ['downloading', 'ready', 'error'] as const

// Preview flag `?update=downloading|ready|error` seeds the background-updater
// phase (version 0.1.0-beta.99, 42% while downloading) so the update badge can
// be inspected in the browser; with no flag the phase is idle.
function fixtureUpdatePhase(): UpdatePhaseState {
  const flag = flags().get('update')
  if (flag === 'downloading') return { phase: 'downloading', version: '0.1.0-beta.99', downloadedBytes: 42, totalBytes: 100, message: null }
  if (flag === 'ready') return { phase: 'ready', version: '0.1.0-beta.99', downloadedBytes: null, totalBytes: null, message: null }
  if (flag === 'error') return { phase: 'error', version: '0.1.0-beta.99', downloadedBytes: null, totalBytes: null, message: null }
  return IDLE_UPDATE_PHASE
}

export async function updatesPhase(): Promise<UpdatePhaseState> {
  return fixtureUpdatePhase()
}

export async function listenForUpdateState(handler: (state: UpdatePhaseState) => void): Promise<Unlisten> {
  updateStateHandlers.add(handler)
  const flag = flags().get('update')
  if (flag && (UPDATE_PHASE_FLAGS as readonly string[]).includes(flag)) {
    window.setTimeout(() => handler(fixtureUpdatePhase()), 0)
  }
  return () => { updateStateHandlers.delete(handler) }
}

export async function runtimeCapabilities(runtimeId: string, agentId?: string) {
  return parseCapabilities(await rpc('runtime.capabilities', agentId ? { runtimeId, agentId } : { runtimeId }))
}

export async function runtimeModels(runtimeId: string, refresh = false) {
  return parseModelCatalog(await rpc('runtime.models', refresh ? { runtimeId, refresh: true } : { runtimeId }))
}

export async function execSnapshotLatest(sessionId: string) {
  return parseExecSnapshot(await rpc('exec.snapshot.latest', { sessionId }))
}

export async function fetchUsageAnalytics(request: UsageAnalyticsRequest) {
  const params: Record<string, unknown> = { from: request.from, to: request.to, bucket: request.bucket, tz: request.tz }
  if (request.projectPath) params.projectPath = request.projectPath
  if (request.agentId) params.agentId = request.agentId
  const parsed = normalizeAnalytics(await rpc('usage.analytics', params))
  if (!parsed) throw new Error('internal: Usage analytics could not be loaded.')
  return parsed
}

export async function setApprovalBadge(_count: number): Promise<void> { /* No native taskbar in the browser preview. */ }

// The browser preview has no OS compositor behind it, so the frosted backdrop
// reports itself unavailable instead of pretending.
export async function applyWindowBackdrop(_enabled: boolean, _dark: boolean): Promise<WindowBackdrop> {
  return { effect: 'none', active: false, transparencyOff: false, reason: 'Not running in the desktop app.' }
}
export async function windowBackdropState(): Promise<WindowBackdrop> {
  return { effect: 'none', active: false, transparencyOff: false, reason: 'Not running in the desktop app.' }
}

// The browser preview has no shell: terminals are a desktop-only feature.
export type TerminalShell = 'powershell' | 'pwsh' | 'cmd'
export type TerminalOpened = { id: string; pid: number | null; shell: string; cwd: string }
export type TerminalInfo = TerminalOpened & { running: boolean; exitCode: number | null }
export type TerminalOutput = { id: string; seq: number; data: string }
export type TerminalExit = { id: string; exitCode: number | null }
export async function terminalOpen(_projectPath: string, _options: { cwd?: string | null; shell?: TerminalShell; cols?: number; rows?: number } = {}): Promise<TerminalOpened> { throw new Error('Terminals run in the desktop app, not in the browser preview.') }
export async function terminalWrite(_id: string, _data: string): Promise<void> {}
export async function terminalResize(_id: string, _cols: number, _rows: number): Promise<void> {}
export async function terminalClose(_id: string): Promise<void> {}
export async function terminalList(): Promise<TerminalInfo[]> { return [] }
export async function listenForTerminalOutput(_handler: (output: TerminalOutput) => void): Promise<Unlisten> { return noop }
export async function listenForTerminalExit(_handler: (exit: TerminalExit) => void): Promise<Unlisten> { return noop }
