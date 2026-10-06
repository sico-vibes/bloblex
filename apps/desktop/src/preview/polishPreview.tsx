import { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../ui/theme.css'
import '../ui/styles.css'
import '../ui/shell.css'
import '../ui/blobPage.css'
import '../ui/companion.css'
import '../ui/settings.css'
import { FirstRunOnboarding } from '../ui/FirstRunOnboarding'
import { BlobPage } from '../ui/BlobPage'
import { SettingsSheet } from '../ui/SettingsSheet'
import { draftFromAgent, executionFromAgent } from '../ui/agentForm'
import type { Agent, Runtime, Session, Snapshot } from '../types'

const runtimes: Runtime[] = [
  { id: 'runtime-claude', provider: 'claude', version: '2.1.286', authState: 'authenticated', status: 'online' },
  { id: 'runtime-codex', provider: 'codex', version: '0.159.3', authState: 'authenticated', status: 'online' },
  { id: 'runtime-opencode', provider: 'opencode', version: '1.18.34', authState: 'authenticated', gatewayAuthStates: { opencode: 'authenticated', 'opencode-go': 'authenticated' }, status: 'online' },
]
const agents: Agent[] = [
  { id: 'agent-codex', name: 'Invoice helper', description: 'Keeps invoice work moving.', instructions: '', color: '#82aaff', runtimeId: 'runtime-codex', model: 'gpt-5.5', thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-10-04T09:00:00Z', outfit: 'auto', approvalMode: 'ask' },
  { id: 'agent-claude', name: 'Release notes', description: '', instructions: '', color: '#f38c6f', runtimeId: 'runtime-claude', model: 'claude-sonnet', thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: '2026-08-02T00:00:00Z', updatedAt: '2026-10-04T09:00:00Z' },
  { id: 'agent-opencode', name: 'API reviewer', description: '', instructions: '', color: '#b7a7f4', runtimeId: 'runtime-opencode', model: 'opencode-go/preview-estimate', thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-10-04T09:00:00Z' },
]
const sessions: Session[] = [
  { id: 'session-1', agentId: 'agent-codex', runtimeId: 'runtime-codex', title: 'Invoice parser tests', projectPath: 'C:\\work\\billing', model: 'gpt-5.5', state: 'working', updatedAt: '2026-10-04T10:20:00Z', messages: [] },
  { id: 'session-2', agentId: 'agent-codex', runtimeId: 'runtime-codex', title: 'Reconcile duplicate entries', projectPath: 'C:\\work\\billing', model: 'gpt-5.5', state: 'completed', updatedAt: '2026-10-03T14:20:00Z', messages: [] },
  { id: 'session-3', agentId: 'agent-claude', runtimeId: 'runtime-claude', title: 'Release summary', projectPath: 'C:\\work\\product', model: 'claude-sonnet', state: 'idle', updatedAt: '2026-10-02T13:20:00Z', messages: [] },
  { id: 'session-4', agentId: 'agent-opencode', runtimeId: 'runtime-opencode', title: 'Review the API changes', projectPath: 'C:\\work\\api', model: 'opencode-go/preview-estimate', state: 'completed', updatedAt: '2026-10-01T12:20:00Z', messages: [] },
]
const snapshot = { agents, runtimes, sessions, permissions: [], usageSummary: null } as unknown as Snapshot

function Preview() {
  const query = new URLSearchParams(location.search)
  const initialScreen = query.get('screen') ?? 'blob-page'
  const initialOnboardingStep = initialScreen.startsWith('onboarding-') ? Number(initialScreen.slice(-1)) : Number(query.get('step') ?? 1)
  const [screen, setScreen] = useState(initialScreen)
  const [settingsOpen, setSettingsOpen] = useState(true)
  const [onboardingStep, setOnboardingStep] = useState<0 | 1 | 2>(initialOnboardingStep === 3 ? 2 : initialOnboardingStep === 2 ? 1 : 0)
  const currentAgent = agents[0]
  const draft = draftFromAgent(currentAgent)
  return <>
    <nav className="launch-preview-switcher" aria-label="Preview screens">{[
      ['blob-page', 'Blob page'], ['settings-general', 'Settings · General'], ['settings-agents', 'Settings · Agents'], ['onboarding-1', 'Onboarding 1'], ['onboarding-2', 'Onboarding 2'], ['onboarding-3', 'Onboarding 3'],
    ].map(([value, label]) => <button key={value} type="button" className="secondary-button small" aria-pressed={screen === value} onClick={() => { setScreen(value); setSettingsOpen(true); history.replaceState(null, '', `?screen=${value}`); if (value.startsWith('onboarding-')) setOnboardingStep((Number(value.slice(-1)) - 1) as 0 | 1 | 2) }}>{label}</button>)}</nav>
    {screen === 'blob-page' && <BlobPage mode="edit" agent={currentAgent} draft={draft} runtime={runtimes[1]} session={sessions[0]} runtimes={runtimes} sessions={sessions.slice(0, 2)} legacyCount={0} connected saving={false} dirty={false} ready canStartSession error={null} remoteNotice={null} errors={{}} execution={executionFromAgent(currentAgent)} onDraftChange={() => undefined} onBack={() => undefined} onSave={() => undefined} onCancel={() => undefined} onArchive={() => undefined} onNewSession={() => undefined} onOpenSession={() => undefined} />}
    {screen.startsWith('onboarding-') && <FirstRunOnboarding key={screen} initialStep={onboardingStep} runtimes={runtimes} scanning={false} error={null} onScan={() => undefined} onCreate={async () => null} onFinish={() => undefined} onSaveName={() => undefined} />}
    {(screen === 'settings-general' || screen === 'settings-agents') && settingsOpen && <SettingsSheet snapshot={snapshot} initialPage={screen === 'settings-general' ? 'General' : 'Agents'} onClose={() => setSettingsOpen(false)} onRefresh={() => undefined} onError={() => undefined} onRunSetup={() => { setSettingsOpen(false); setScreen('onboarding-1') }} onOpenAgent={() => setScreen('blob-page')} />}
  </>
}

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark'
ReactDOM.createRoot(document.getElementById('root')!).render(<Preview />)
