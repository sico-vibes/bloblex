// Development-only stand-in for src/tauri.ts, wired by vite.preview.config.ts
// so the real App can be inspected in a browser without the daemon. Every
// value below is a visual fixture, not product data.
import type { DaemonEvent, Session, Snapshot } from '../types'

type Unlisten = () => void
const noop: Unlisten = () => undefined
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const sessions: Session[] = [
  {
    id: 'session-codex', runtimeId: 'runtime-codex', title: 'Invoice parser tests', projectPath: 'C:/work/korus', state: 'working', model: 'gpt-5.5', updatedAt: minutesAgo(2),
    messages: [
      { id: 'm1', role: 'user', content: 'Can you make the invoice parser tests pass?', createdAt: minutesAgo(9) },
      { id: 'm2', role: 'assistant', content: 'Sure. I found two failing cases in **tests/invoice.test.ts**: the currency field is parsed before the locale is known, and totals use floats.\n\nI will switch totals to integer minor units and parse the locale first.', createdAt: minutesAgo(8) },
      { id: 'm3', role: 'assistant', content: 'Patched `parseInvoice` and the fixture loader. Running the suite now.', createdAt: minutesAgo(3) },
    ],
    tools: [{ id: 't1', title: 'npm test', kind: 'command', state: 'running', command: 'npm test -- invoice', sequence: 4 }],
  },
  { id: 'session-claude', runtimeId: 'runtime-claude', title: 'Landing page copy', projectPath: 'C:/work/site', state: 'completed', model: 'claude-opus', updatedAt: minutesAgo(41), messages: [{ id: 'c1', role: 'assistant', content: 'Updated the hero copy and the pricing table.', createdAt: minutesAgo(41) }] },
  { id: 'session-opencode', runtimeId: 'runtime-opencode', title: 'Refactor auth', projectPath: 'C:/work/api', state: 'idle', updatedAt: minutesAgo(60 * 26), messages: [] },
]

const snapshot: Snapshot = {
  sequence: 1,
  runtimes: [
    { id: 'runtime-codex', provider: 'codex', status: 'online', protocolFamily: 'codex_app_server', version: 'codex-cli 0.159.3', authState: 'signed_in' },
    { id: 'runtime-claude', provider: 'claude', status: 'online', protocolFamily: 'claude_stream', version: '2.1.286' },
    { id: 'runtime-opencode', provider: 'opencode', status: 'online', protocolFamily: 'acp', version: '1.18.34' },
  ],
  sessions,
  permissions: new URLSearchParams(location.search).has('approval')
    ? [{ id: 'perm-1', sessionId: 'session-codex', runtimeId: 'runtime-codex', status: 'pending', title: 'Run shell command', command: 'npm test -- invoice', choices: ['allow_once', 'allow_session', 'deny'] }]
    : [],
  usageSummary: { inputTokens: 182_400, outputTokens: 24_900 },
  budgets: [],
}

export const inDesktop = true
export async function rpc<T>(method: string): Promise<T> {
  if (method === 'events.replay') return { replayAvailable: true, events: [] } as T
  if (method === 'settings.get') return { settings: {} } as T
  return {} as T
}
export async function fetchSnapshot() { return structuredClone(snapshot) }
export async function ensureDaemon() {}
export async function startDaemonEventStream() {}
export async function openProjectFolder() { return null }
export async function selectLocalFile() { return null }
export async function inspectLocalFile(path: string) { return { path, fileName: path.split(/[\\/]/).pop() ?? path, sizeBytes: 2048 } }
export async function openInEditor() {}
export async function revealInExplorer() {}
export async function resolveProjectFile(path: string) { return path }
export async function showMainWindow() {}
export async function showMainSettings() {}
export async function setActiveSession() {}
export async function getActiveSession() { return 'session-codex' }
export async function setActiveRuntime() {}
export async function getActiveRuntime() { return 'runtime-codex' }
export async function setCompanionVisibility() {}
export async function setCloseToTray() {}
export async function companionMonitorOptions() { return [] as string[] }
export async function currentCompanionMonitor() { return null }
export async function setCompanionMonitor() {}
export async function refreshTrayMenu() {}
const companionSizes: Record<string, [number, number]> = { petit: [344, 62], hidden: [344, 62], coucou: [640, 160], home: [640, 160], 'home-chat': [640, 264] }
export async function setCompanionMode(mode: string) {
  const [width, height] = companionSizes[mode] ?? [640, 160]
  let style = document.getElementById('fixture-companion-size')
  if (!style) { style = document.createElement('style'); style.id = 'fixture-companion-size'; document.head.append(style) }
  style.textContent = `:root.companion-surface body { background: radial-gradient(900px 500px at 70% 10%, #3b2f63, #12131a) !important; }
    .companion-root { position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); width: ${width}px !important; height: ${height}px !important; transition: width .34s, height .34s; }`
}
export async function quitBloblex() {}
export async function listenForActiveSession(): Promise<Unlisten> { return noop }
export async function listenForActiveRuntime(): Promise<Unlisten> { return noop }
export async function listenForOpenSettings(): Promise<Unlisten> { return noop }
export async function listenForDaemonEvents(_handler: (event: DaemonEvent) => void): Promise<Unlisten> { return noop }
export async function listenForDaemonConnection(): Promise<Unlisten> { return noop }
