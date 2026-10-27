// A Manager proposal in the conversation: what it wants to create or do, with
// the fields you can change before you approve. Nothing happens until you
// choose Approve; Reject tells the Manager no.
import { useState } from 'react'
import { BlobCanvas } from '../blob/BlobCanvas'
import type { BlobLook } from '../blob/look'
import { BookOpen, Bot, FolderPlus, GitMerge, ListChecks, Pencil, ShieldCheck, UserCog } from 'lucide-react'
import type { JsonRecord, PermissionRequest, Project, Runtime } from '../types'
import { parseModelCatalog } from '../executionContract'
import { useCachedRpc } from './catalogCache'
import { friendlyErrorText } from './errorCopy'
import { openProjectFolder, rpc, setActiveRuntime, setActiveSession } from '../tauri'
import { Select } from './Select'
import { providerBrand } from './providerBrand'
import { ProposedPlaybook } from './PlaybookDiff'
import './proposalCard.css'

type Decision = 'approve' | 'reject'

const KIND_LABEL: Record<string, { title: string; Icon: typeof Bot }> = {
  project: { title: 'Create a project', Icon: FolderPlus },
  bot: { title: 'Create a bot', Icon: Bot },
  task: { title: 'Assign a task', Icon: ListChecks },
  playbook: { title: 'Update its playbook', Icon: BookOpen },
  profile: { title: 'Change something it knows about you', Icon: UserCog },
  permission: { title: 'Change a bot\'s permission', Icon: ShieldCheck },
  merge: { title: 'Merge a task', Icon: GitMerge },
}

const text = (value: unknown) => typeof value === 'string' ? value : ''

/** The same words for a bot's permission in the create and update cards. */
const permissionLabel = (value: unknown) => text(value) === 'auto' ? 'Auto' : 'Ask first'

/** A folder name made from the project name: no characters Windows forbids. */
export function folderNameFor(name: string): string {
  return name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').replace(/[-. ]+$/, '') || 'New project'
}

/**
 * FIX39 P6 audit finding 4: a task's named project is matched by the daemon by
 * id or by a trimmed, case-insensitive name. The card must resolve it the same
 * way, or it shows "—" while the delegated bot still runs and writes in that
 * project's folder. Undefined means the name matches nothing (the daemon will
 * refuse it).
 */
export function projectForDraft(projects: readonly Project[], name: string | undefined): Project | undefined {
  const wanted = (name ?? '').trim()
  if (!wanted) return undefined
  const lower = wanted.toLowerCase()
  return projects.find((project) => project.id === wanted || project.name.trim().toLowerCase() === lower)
}

/** The full path of a new project folder inside the chosen parent. */
export function joinFolder(parent: string, name: string): string {
  const separator = parent.includes('\\') ? '\\' : '/'
  return `${parent.replace(/[\\/]+$/, '')}${separator}${folderNameFor(name)}`
}

/** Only the fields the owner changed, as the `edits` proposal.decide takes. */
export function proposalEdits(original: JsonRecord, edited: JsonRecord): JsonRecord | undefined {
  const changes: JsonRecord = {}
  for (const [key, value] of Object.entries(edited)) {
    if (JSON.stringify(value) !== JSON.stringify(original[key])) changes[key] = value
  }
  return Object.keys(changes).length ? changes : undefined
}

export function ProposalCard({ request, managerName = 'The Manager', projects, runtimes = [], onDecided, onError }: {
  request: PermissionRequest
  managerName?: string
  projects: readonly Project[]
  runtimes?: readonly Runtime[]
  onDecided?: (decision: Decision) => void
  onError?: (message: string) => void
}) {
  const proposal = request.proposal
  const original = (proposal?.payload ?? {}) as JsonRecord
  const [draft, setDraft] = useState<JsonRecord>(original)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const runtime = runtimes.find((item) => item.provider === draft.provider)
  const modelsQuery = useCachedRpc('runtime.models', editing && proposal?.kind === 'bot' && runtime ? { runtimeId: runtime.id } : null)
  const catalog = modelsQuery.value === undefined ? null : parseModelCatalog(modelsQuery.value)
  if (!proposal) return null
  const kind = String(proposal.kind)
  const updating = draft.action === 'update' && (kind === 'bot' || kind === 'project')
  const opening = kind === 'task' && draft.action === 'open'
  // FIX39 P10: a merge card has no fields to edit; it offers merge, keep or discard.
  const merging = kind === 'merge'
  const mergeFiles = Array.isArray(draft.files) ? draft.files.map(text).filter(Boolean) : []
  const { title, Icon } = updating
    ? { title: kind === 'bot' ? 'Update a bot' : 'Update a project', Icon: Pencil }
    : opening ? { title: 'Open a conversation', Icon: ListChecks }
      : KIND_LABEL[kind] ?? { title: 'Do something', Icon: Pencil }
  const set = (key: string, value: unknown) => setDraft((current) => ({ ...current, [key]: value }))
  const folder = (draft.folder ?? {}) as JsonRecord
  const needsFolder = kind === 'project' && !updating && folder.mode === 'new' && !text(folder.path)
  // FIX39 P6 audit finding 4: the task's folder line uses the same match as the
  // daemon (id or trimmed, case-insensitive name), so the card never understates
  // where an approved task may write.
  const taskProject = kind === 'task' ? projectForDraft(projects, text(draft.project)) : undefined
  const decide = async (decision: Decision, discard?: boolean) => {
    setBusy(true)
    setDecisionError(null)
    try {
      const edits = decision === 'approve' ? proposalEdits(original, draft) : undefined
      const result = await rpc<{ result?: { sessionId?: string; runtimeId?: string; action?: string } }>('proposal.decide', { id: proposal.id, decision, ...(edits ? { edits } : {}), ...(discard ? { discard: true } : {}) })
      if (decision === 'approve' && opening && result.result?.action === 'open' && result.result.sessionId) {
        if (result.result.runtimeId) await setActiveRuntime(result.result.runtimeId)
        await setActiveSession(result.result.sessionId)
      }
      onDecided?.(decision)
    } catch (reason) {
      const raw = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
      const message = /model is not available in this runtime catalog/i.test(raw)
        ? 'This model is not available for the selected coding agent. Edit the proposal and choose an available model.'
        : raw ? friendlyErrorText(raw) : 'Could not complete this proposal. Check your connection and try again.'
      setDecisionError(message)
      onError?.(message)
    } finally { setBusy(false) }
  }
  const chooseParent = async () => {
    const parent = await openProjectFolder()
    if (parent) set('folder', { ...folder, mode: 'new', path: joinFolder(parent, text(draft.name)) })
  }
  const field = (key: string, label: string, options: { multiline?: boolean; max?: number } = {}) => <label className="proposal-field">
    <span>{label}</span>
    {editing
      ? options.multiline
        ? <textarea rows={4} maxLength={options.max} value={text(draft[key])} onChange={(event) => set(key, (key === 'model' || key === 'thinking') && !event.target.value ? null : event.target.value)} />
        : <input maxLength={options.max} value={text(draft[key])} onChange={(event) => set(key, (key === 'model' || key === 'thinking') && !event.target.value ? null : event.target.value)} />
      : <p className={options.multiline ? 'proposal-value multiline' : 'proposal-value'}>{text(draft[key]) || '—'}</p>}
  </label>

  const lookPreview = (value: unknown) => <div className="proposal-field">
    <span>Look</span>
    <BlobCanvas color="#a7f3d0" size={56} decorative track={false} label="Proposed look" look={value as BlobLook | null} />
    <p className="proposal-value">{text((value as JsonRecord | null)?.shape) || 'Default look'}</p>
  </div>

  return <section className="proposal-card" aria-label={`${managerName} proposes: ${title}`}>
    <header className="proposal-head">
      <span className="proposal-icon" aria-hidden="true"><Icon size={15} /></span>
      <div><small>{managerName} proposes</small><strong>{title}</strong></div>
      {kind !== 'playbook' && !opening && !merging && <button type="button" className="ghost-button small" aria-pressed={editing} onClick={() => setEditing((value) => !value)}><Pencil size={12} aria-hidden="true" />{editing ? 'Done editing' : 'Edit'}</button>}
    </header>
    <div className="proposal-body">
      {kind === 'project' && !updating && <>
        {field('name', 'Name', { max: 80 })}
        {field('description', 'What it is for', { multiline: true, max: 500 })}
        <div className="proposal-field"><span>Folder</span>
          <p className="proposal-value mono">{text(folder.path) || (folder.mode === 'new' ? 'A new folder — choose where it goes' : '—')}</p>
          {folder.mode === 'new' && <button type="button" className="secondary-button small" onClick={() => void chooseParent()}><FolderPlus size={12} aria-hidden="true" />{text(folder.path) ? 'Choose another place' : 'Choose where'}</button>}
        </div>
      </>}
      {kind === 'bot' && !updating && <>
        {field('name', 'Name', { max: 40 })}
        {field('role', 'Role', { max: 40 })}
        {field('description', 'What it does', { max: 255 })}
        {field('instructions', 'Instructions', { multiline: true, max: 4000 })}
        <div className="proposal-row">
          <label className="proposal-field"><span>Coding agent</span>
            {editing
              ? <Select ariaLabel="Coding agent" variant="field" value={text(draft.provider)} onChange={(value) => set('provider', value)} options={['claude', 'codex', 'opencode'].map((value) => ({ value, label: providerBrand(value).name, provider: value }))} />
              : <p className="proposal-value">{providerBrand(text(draft.provider)).name}{text(draft.model) ? ` · ${text(draft.model)}` : ''}</p>}
          </label>
          <label className="proposal-field"><span>Project</span>
            {editing
              ? <Select ariaLabel="Project" variant="field" value={projectForDraft(projects, text(draft.project))?.id || text(draft.project)} onChange={(value) => set('project', value)} options={[{ value: '', label: 'No project' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} />
              : <p className="proposal-value">{projectForDraft(projects, text(draft.project))?.name || text(draft.project) || 'No project'}</p>}
          </label>
        </div>
        {editing && <label className="proposal-field"><span>Model</span>
          {catalog?.models.length ? <Select ariaLabel="Model" variant="field" value={text(draft.model)} onChange={(value) => set('model', value || null)} options={[
            { value: '', label: 'Agent default' },
            ...(text(draft.model) && !catalog.models.some((model) => model.id === draft.model) ? [{ value: text(draft.model), label: `${text(draft.model)} · unavailable`, disabled: true }] : []),
            ...catalog.models.map((model) => ({ value: model.id, label: model.displayName || model.id }))
          ]} searchable={8} /> : <input aria-label="Model" value={text(draft.model)} onChange={(event) => set('model', event.target.value || null)} />}
          {!catalog && <small className="proposal-hint">{modelsQuery.loading ? 'Loading available models…' : 'Available models could not be loaded. Enter a model ID or leave it empty.'}</small>}
        </label>}
      </>}
      {(kind === 'bot' || kind === 'project') && !updating && <>
        {Array.isArray(draft.tags) && <div className="proposal-field"><span>Tags</span><p className="proposal-value">{draft.tags.join(', ') || 'No tags'}</p></div>}
        {kind === 'bot' && <>
          {text(draft.thinking) && field('thinking', 'Effort')}
          {text(draft.approvalMode) && <div className="proposal-field"><span>Permission</span><p className="proposal-value">{permissionLabel(draft.approvalMode)}</p></div>}
          {draft.look != null && lookPreview(draft.look)}
        </>}
      </>}
      {kind === 'task' && !opening && <>
        <div className="proposal-row">
          <div className="proposal-field"><span>For</span><p className="proposal-value">{text(draft.botName) || text(draft.bot)}</p></div>
          {text(draft.project) && <div className="proposal-field"><span>Project</span><p className="proposal-value">{text(draft.projectName) || taskProject?.name || text(draft.project)}</p></div>}
        </div>
        {/* FIX39 risk 7: a delegated task runs in the project's folder, which
            widens where its Auto mode may write. Show that folder on the card. */}
        {text(draft.project) && <div className="proposal-field"><span>Folder it runs in</span><p className="proposal-value mono">{taskProject ? taskProject.path || '—' : 'Project not found'}</p></div>}
        {text(draft.conversation) && field('conversation', 'Continue conversation')}
        {text(draft.topic) && field('topic', 'Topic', { max: 60 })}
        {field('brief', 'The task', { multiline: true, max: 180000 })}
        {field('doneGoal', 'Done when', { multiline: true, max: 4000 })}
        {field('reportBack', 'Report back', { multiline: true, max: 4000 })}
      </>}
      {updating && <>
        <div className="proposal-field"><span>{kind === 'bot' ? 'Bot' : 'Project'}</span><p className="proposal-value">{text(draft.targetName) || text(draft.blob) || text(draft.project)}</p></div>
        {Object.entries(draft).filter(([key]) => !['action', 'blob', 'project', 'targetName'].includes(key)).map(([key, value]) => {
          const label = ({ name: 'Name', description: 'What it is for', role: 'Role', instructions: 'Instructions', model: 'Model', thinking: 'Effort', approvalMode: 'Permission', tags: 'Tags', look: 'Look' } as Record<string, string>)[key] ?? key
          if (key === 'look') return <div key={key}>{lookPreview(value)}</div>
          if (key === 'tags') return <label className="proposal-field" key={key}><span>{label}</span>{editing
            ? <input aria-label="Tags" value={Array.isArray(value) ? value.join(', ') : ''} onChange={(event) => set('tags', event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean))} />
            : <p className="proposal-value">{Array.isArray(value) ? value.join(', ') || 'No tags' : 'No tags'}</p>}</label>
          if (key === 'approvalMode') return <label className="proposal-field" key={key}><span>{label}</span>{editing
            ? <Select ariaLabel="Permission" variant="field" value={text(value)} onChange={(mode) => set(key, mode)} options={[{ value: 'ask', label: 'Ask first' }, { value: 'auto', label: 'Auto' }]} />
            : <p className="proposal-value">{permissionLabel(value)}</p>}</label>
          return <div key={key}>{field(key, label, { multiline: key === 'instructions' || key === 'description', max: key === 'instructions' ? 4000 : undefined })}</div>
        })}
      </>}
      {opening && <>
        <div className="proposal-field"><span>Conversation</span><p className="proposal-value">{text(draft.title)} · {text(draft.conversation)}</p></div>
      </>}
      {kind === 'playbook' && <>
        {text(draft.reason) && <p className="proposal-reason">{text(draft.reason)}</p>}
        <ProposedPlaybook text={text(draft.text)} />
      </>}
      {kind === 'profile' && <>
        <div className="proposal-row">
          <div className="proposal-field"><span>About</span><p className="proposal-value">{[text(draft.category), text(draft.key)].filter(Boolean).join(' · ')}</p></div>
        </div>
        {field('value', 'New value', { multiline: true, max: 1000 })}
      </>}
      {kind === 'permission' && <>
        <div className="proposal-row">
          <div className="proposal-field"><span>Conversation</span><p className="proposal-value mono">{text(draft.conversation)}</p></div>
          <div className="proposal-field"><span>Permission</span><p className="proposal-value">{text(draft.mode) === 'auto' ? 'Auto' : 'Ask first'}</p></div>
        </div>
        <p className="proposal-hint">Changes this bot's permission for all its conversations, from their next turn. Full access can never be set this way.</p>
      </>}
      {merging && <>
        <div className="proposal-row">
          <div className="proposal-field"><span>Task</span><p className="proposal-value">{text(draft.taskTitle) || text(draft.botName) || 'A task'}</p></div>
          {text(draft.botName) && <div className="proposal-field"><span>Bot</span><p className="proposal-value">{text(draft.botName)}</p></div>}
        </div>
        <div className="proposal-row">
          <div className="proposal-field"><span>Branch</span><p className="proposal-value mono">{text(draft.branch)}</p></div>
          <div className="proposal-field"><span>Merge into</span><p className="proposal-value mono">{text(draft.baseBranch)}</p></div>
        </div>
        <div className="proposal-field"><span>Changes</span><p className="proposal-value">{text(draft.diffSummary) || 'No summary'}</p></div>
        {mergeFiles.length > 0 && <div className="proposal-field"><span>Files</span>
          <ul className="proposal-value mono">{mergeFiles.map((file) => <li key={file}>{file}</li>)}</ul>
        </div>}
        <p className="proposal-hint">The task ran in its own copy of the project so it could not clash with other work. Merging brings its changes back and removes the copy.</p>
      </>}
    </div>
    <footer className="proposal-actions">
      {decisionError && <p className="proposal-error" role="alert">{decisionError}</p>}
      {needsFolder && <small className="proposal-hint">Choose where the new folder goes, then approve.</small>}
      {merging && <button type="button" className="ghost-button small" disabled={busy} onClick={() => void decide('reject', true)}>Discard</button>}
      <button type="button" className="ghost-button small" disabled={busy} onClick={() => void decide('reject')}>{merging ? 'Keep branch' : 'Reject'}</button>
      <button type="button" className="primary-button small" disabled={busy || needsFolder} onClick={() => void decide('approve')}>{merging ? 'Merge' : 'Approve'}</button>
    </footer>
  </section>
}
