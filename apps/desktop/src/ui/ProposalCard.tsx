// A Manager proposal in the conversation: what it wants to create or do, with
// the fields you can change before you approve. Nothing happens until you
// choose Approve; Reject tells the Manager no.
import { useState } from 'react'
import { BookOpen, Bot, FolderPlus, ListChecks, Pencil, UserCog } from 'lucide-react'
import type { JsonRecord, PermissionRequest, Project } from '../types'
import { openProjectFolder, rpc } from '../tauri'
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
}

const text = (value: unknown) => typeof value === 'string' ? value : ''

/** A folder name made from the project name: no characters Windows forbids. */
export function folderNameFor(name: string): string {
  return name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').replace(/[-. ]+$/, '') || 'New project'
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

export function ProposalCard({ request, managerName = 'The Manager', projects, onDecided, onError }: {
  request: PermissionRequest
  managerName?: string
  projects: readonly Project[]
  onDecided?: (decision: Decision) => void
  onError?: (message: string) => void
}) {
  const proposal = request.proposal
  const original = (proposal?.payload ?? {}) as JsonRecord
  const [draft, setDraft] = useState<JsonRecord>(original)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!proposal) return null
  const kind = String(proposal.kind)
  const { title, Icon } = KIND_LABEL[kind] ?? { title: 'Do something', Icon: Pencil }
  const set = (key: string, value: unknown) => setDraft((current) => ({ ...current, [key]: value }))
  const folder = (draft.folder ?? {}) as JsonRecord
  const needsFolder = kind === 'project' && folder.mode === 'new' && !text(folder.path)
  const decide = async (decision: Decision) => {
    setBusy(true)
    try {
      const edits = decision === 'approve' ? proposalEdits(original, draft) : undefined
      await rpc('proposal.decide', { id: proposal.id, decision, ...(edits ? { edits } : {}) })
      onDecided?.(decision)
    } catch (reason) {
      onError?.(reason instanceof Error ? reason.message : 'That could not be done.')
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
        ? <textarea rows={4} maxLength={options.max} value={text(draft[key])} onChange={(event) => set(key, event.target.value)} />
        : <input maxLength={options.max} value={text(draft[key])} onChange={(event) => set(key, event.target.value)} />
      : <p className={options.multiline ? 'proposal-value multiline' : 'proposal-value'}>{text(draft[key]) || '—'}</p>}
  </label>

  return <section className="proposal-card" aria-label={`${managerName} proposes: ${title}`}>
    <header className="proposal-head">
      <span className="proposal-icon" aria-hidden="true"><Icon size={15} /></span>
      <div><small>{managerName} proposes</small><strong>{title}</strong></div>
      {kind !== 'playbook' && <button type="button" className="ghost-button small" aria-pressed={editing} onClick={() => setEditing((value) => !value)}><Pencil size={12} aria-hidden="true" />{editing ? 'Done editing' : 'Edit'}</button>}
    </header>
    <div className="proposal-body">
      {kind === 'project' && <>
        {field('name', 'Name', { max: 80 })}
        {field('description', 'What it is for', { multiline: true, max: 500 })}
        <div className="proposal-field"><span>Folder</span>
          <p className="proposal-value mono">{text(folder.path) || (folder.mode === 'new' ? 'A new folder — choose where it goes' : '—')}</p>
          {folder.mode === 'new' && <button type="button" className="secondary-button small" onClick={() => void chooseParent()}><FolderPlus size={12} aria-hidden="true" />{text(folder.path) ? 'Choose another place' : 'Choose where'}</button>}
        </div>
      </>}
      {kind === 'bot' && <>
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
              ? <Select ariaLabel="Project" variant="field" value={text(draft.project)} onChange={(value) => set('project', value)} options={[{ value: '', label: 'No project' }, ...projects.map((project) => ({ value: project.name, label: project.name }))]} />
              : <p className="proposal-value">{text(draft.project) || 'No project'}</p>}
          </label>
        </div>
      </>}
      {kind === 'task' && <>
        <div className="proposal-row">
          <div className="proposal-field"><span>For</span><p className="proposal-value">{text(draft.bot)}</p></div>
          {text(draft.project) && <div className="proposal-field"><span>Project</span><p className="proposal-value">{text(draft.project)}</p></div>}
        </div>
        {field('brief', 'The task', { multiline: true, max: 8000 })}
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
    </div>
    <footer className="proposal-actions">
      {needsFolder && <small className="proposal-hint">Choose where the new folder goes, then approve.</small>}
      <button type="button" className="ghost-button small" disabled={busy} onClick={() => void decide('reject')}>Reject</button>
      <button type="button" className="primary-button small" disabled={busy || needsFolder} onClick={() => void decide('approve')}>Approve</button>
    </footer>
  </section>
}
