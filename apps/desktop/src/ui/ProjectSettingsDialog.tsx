// Phase 1: per-project overrides. They are the owner's, set only here: a mode can
// widen what bots may do in this project, and a setup script is code that runs on
// this computer, so neither comes from the repository, a backup or the Manager.
import { useState } from 'react'
import type { ApprovalMode, Project, Runtime } from '../types'
import { parseModelCatalog } from '../executionContract'
import { rpc } from '../tauri'
import { useCachedRpc } from './catalogCache'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
import { Select } from './Select'
import './newProject.css'

export type ProjectOverrides = { models: Record<string, string>; approvalMode: ApprovalMode | null; setupScript: string | null; copyFiles: string[]; initSubmodules: boolean }

export const MAX_SETUP_SCRIPT_CHARS = 4_000

/** The paths in the box, one per line, and why any of them can't be used. The daemon checks again. */
export function parseCopyFiles(text: string): { paths: string[]; problem: string | null } {
  const paths = [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]
  if (paths.length > 50) return { paths, problem: 'List at most 50 files.' }
  const bad = paths.find((path) => path.length > 260 || /^[\\/]|^[a-z]:|(^|[\\/])\.\.([\\/]|$)|[*?]/i.test(path))
  return { paths, problem: bad ? `"${bad}" must be a path inside the project, with no .. or wildcards.` : null }
}

/** Whatever the daemon sent, as a complete object. */
export function normalizeOverrides(raw: unknown): ProjectOverrides {
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const models = item.models && typeof item.models === 'object' && !Array.isArray(item.models)
    ? Object.fromEntries(Object.entries(item.models).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1]))
    : {}
  const mode = item.approvalMode
  return { models, approvalMode: mode === 'ask' || mode === 'auto' || mode === 'accept_edits' || mode === 'bypass' ? mode : null, setupScript: typeof item.setupScript === 'string' && item.setupScript.trim() ? item.setupScript : null, copyFiles: Array.isArray(item.copyFiles) ? item.copyFiles.filter((path): path is string => typeof path === 'string' && !!path) : [], initSubmodules: item.initSubmodules === true }
}

const MODE_OPTIONS = [
  { value: '', label: 'Each bot’s own setting' },
  { value: 'ask', label: 'Ask first' },
  { value: 'accept_edits', label: 'Auto-accept edits' },
  { value: 'auto', label: 'Auto-approve' },
  { value: 'bypass', label: 'Full access' },
]
const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }

function ModelRow({ runtime, value, onChange }: { runtime: Runtime; value: string; onChange: (value: string) => void }) {
  const query = useCachedRpc('runtime.models', { runtimeId: runtime.id })
  const models = parseModelCatalog(query.value)?.models ?? []
  const options = [{ value: '', label: 'Each bot’s own model' }, ...models.map((model) => ({ value: model.id, label: model.displayName || model.id }))]
  // A saved model the catalog no longer lists stays visible, so it isn't lost by opening this.
  if (value && !models.some((model) => model.id === value)) options.push({ value, label: value })
  const name = PROVIDER_NAMES[runtime.provider ?? ''] ?? runtime.provider ?? 'Coding agent'
  return <label className="new-project-field"><span>{name}</span><Select ariaLabel={`Model for ${name} in this project`} variant="muted" value={value} searchable={8} onChange={onChange} options={options} /></label>
}

export function ProjectSettingsDialog({ project, runtimes, onClose, onSaved }: { project: Project; runtimes: readonly Runtime[]; onClose: () => void; onSaved: (project: Project) => void }) {
  const entered = useDialogEntered()
  const [busy, setBusy] = useState(false)
  const { ref, close } = useDialogAccessibility(onClose, () => !busy)
  const saved = normalizeOverrides(project.overrides)
  const [models, setModels] = useState(saved.models)
  const [mode, setMode] = useState<string>(saved.approvalMode ?? '')
  const [script, setScript] = useState(saved.setupScript ?? '')
  const [copyText, setCopyText] = useState(saved.copyFiles.join('\n'))
  const [submodules, setSubmodules] = useState(saved.initSubmodules)
  const copy = parseCopyFiles(copyText)
  const [accepted, setAccepted] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // One row per kind of coding agent, because model ids belong to a provider.
  const providers = runtimes.filter((runtime, index) => !!runtime.provider && runtimes.findIndex((other) => other.provider === runtime.provider) === index)
  const newlyFullAccess = mode === 'bypass' && saved.approvalMode !== 'bypass'
  const ready = !busy && (!newlyFullAccess || accepted) && !copy.problem
  const save = async () => {
    if (!ready) return
    setBusy(true); setProblem(null)
    const overrides: ProjectOverrides = { models: Object.fromEntries(Object.entries(models).filter(([, id]) => !!id)), approvalMode: (mode || null) as ApprovalMode | null, setupScript: script.trim() ? script : null, copyFiles: copy.paths, initSubmodules: submodules }
    try {
      const result = await rpc<{ project?: Project }>('project.update', { projectId: project.id, overrides, ...(mode === 'bypass' ? { confirm: true } : {}) })
      onSaved(result?.project ?? { ...project, overrides })
    } catch (reason) {
      setProblem(reason instanceof Error && reason.message ? reason.message : 'These settings could not be saved.')
      setBusy(false)
    }
  }
  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog new-project project-settings" role="dialog" aria-modal="true" aria-labelledby="project-settings-title" tabIndex={-1}>
      <h2 id="project-settings-title">{project.name} settings</h2>
      <p>These apply to every bot working in this project. A conversation you set yourself still keeps its own choice.</p>
      <label className="new-project-field"><span>Approvals</span>
        <Select ariaLabel="Approvals in this project" variant="muted" value={mode} onChange={(value) => { setMode(value); setAccepted(false) }} options={MODE_OPTIONS} />
      </label>
      {newlyFullAccess && <label className="new-project-check project-full-access"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /><span>Every bot in this project may run commands and change files without asking. Scheduled work still stays on safe actions.</span></label>}
      <div className="project-settings-models" role="group" aria-label="Model for new conversations in this project">
        <span className="project-settings-heading">Model for new conversations</span>
        {providers.map((runtime) => <ModelRow key={runtime.provider} runtime={runtime} value={models[runtime.provider ?? ''] ?? ''} onChange={(value) => setModels((current) => ({ ...current, [runtime.provider ?? '']: value }))} />)}
        {providers.length === 0 && <small>No coding agents found yet.</small>}
      </div>
      <label className="new-project-field"><span>Setup script</span>
        <textarea className="project-setup-script" rows={3} value={script} maxLength={MAX_SETUP_SCRIPT_CHARS} spellCheck={false} placeholder="npm install" onChange={(event) => setScript(event.target.value)} />
        <small className="project-settings-note">Runs with cmd on this computer each time a conversation gets its own copy of this repository, before its first turn. If it fails, the bot is told and carries on.</small>
      </label>
      <label className="new-project-field"><span>Files to copy into each new copy</span>
        <textarea className="project-setup-script" rows={2} value={copyText} spellCheck={false} placeholder=".env.local" aria-invalid={!!copy.problem} onChange={(event) => setCopyText(event.target.value)} />
        <small className="project-settings-note">One path per line, inside the project. Git doesn't copy ignored files like these. An existing file is never overwritten.</small>
        {copy.problem && <small className="new-project-error" role="alert">{copy.problem}</small>}
      </label>
      <label className="new-project-check"><input type="checkbox" checked={submodules} onChange={(event) => setSubmodules(event.target.checked)} /><span>Set up git submodules in each new copy</span></label>
      {problem && <p className="new-project-error" role="alert">{problem}</p>}
      <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="primary-button" disabled={!ready} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </section>
  </div>
}
