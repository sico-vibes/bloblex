// Memory: short notes blobs can save and recall across conversations. The
// daemon owns the store and the rules; this page lets the user review, edit and
// remove notes, and write a few lines about themselves.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RowCopy } from './SettingsParts'
import { Check, Pencil, Plus, Trash2, Pin } from 'lucide-react'
import type { Agent, MemoryRecord, Project } from '../types'
import { isMemoryRecord } from '../types'
import { rpc } from '../tauri'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
import { Select } from './Select'
import { ConfirmDialog } from './BlobPage'
import { entityNoun, useEntityNoun } from './vocabulary'
import { themeStyle } from '../blob/bitbots'
import './memory.css'

export const ABOUT_LIMIT = 1500
export const TITLE_LIMIT = 120
export const BODY_LIMIT = 2000

const KINDS: Array<{ value: MemoryRecord['kind']; label: string }> = [
  { value: 'fact', label: 'Fact' },
  { value: 'preference', label: 'Preference' },
  { value: 'decision', label: 'Decision' },
  { value: 'procedure', label: 'How to' },
  { value: 'reference', label: 'Reference' },
]

export function scopeLabel(record: Pick<MemoryRecord, 'scope' | 'scopeId'>, agents: readonly Agent[], projects: readonly Project[]): string {
  if (record.scope === 'shared') return 'Everyone'
  if (record.scope === 'blob') return agents.find((agent) => agent.id === record.scopeId)?.name ?? `A ${entityNoun(themeStyle())}`
  return projects.find((project) => project.id === record.scopeId)?.name ?? 'A project'
}

export interface MemoryPageProps {
  agents: readonly Agent[]
  projects: readonly Project[]
  enabled: boolean
  /** Whether blobs may propose notes for a project or everyone (each waits for approval). */
  sharedWrites: boolean
  about: string
  connected: boolean
  onEnabledChange: (next: boolean) => Promise<void>
  onSharedWritesChange: (next: boolean) => Promise<void>
  onAboutSave: (text: string) => Promise<void>
}

export function MemoryPage({ agents, projects, enabled, sharedWrites, about, connected, onEnabledChange, onSharedWritesChange, onAboutSave }: MemoryPageProps) {
  const noun = useEntityNoun()
  const nouns = useEntityNoun({ plural: true })
  const Nouns = useEntityNoun({ plural: true, capital: true })
  const [records, setRecords] = useState<MemoryRecord[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<MemoryRecord | 'new' | null>(null)
  const [deleting, setDeleting] = useState<MemoryRecord | null>(null)
  const [aboutDraft, setAboutDraft] = useState(about)
  const [aboutSaving, setAboutSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => setAboutDraft(about), [about])

  const load = useCallback(async () => {
    try {
      const result = await rpc<{ records?: unknown[] }>('memory.list', { limit: 200 })
      setRecords((Array.isArray(result.records) ? result.records : []).filter(isMemoryRecord))
      setProblem(null)
    } catch (reason) {
      setRecords([])
      setProblem(reason instanceof Error ? reason.message : 'Notes could not be loaded.')
    }
  }, [])
  useEffect(() => { if (connected) void load() }, [connected, load])

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setProblem(null)
    try { await work(); await load() } catch (reason) { setProblem(reason instanceof Error ? reason.message : 'That did not work.') } finally { setBusy(false) }
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (records ?? []).filter((record) => !needle || `${record.title} ${record.body}`.toLowerCase().includes(needle))
  }, [records, query])
  const review = visible.filter((record) => !record.reviewed)
  const rest = visible.filter((record) => record.reviewed)
  const aboutDirty = aboutDraft.trim() !== about.trim()
  const aboutOver = aboutDraft.length > ABOUT_LIMIT

  const row = (record: MemoryRecord) => <li key={record.id} className={`memory-row${record.reviewed ? '' : ' unreviewed'}`}>
    <div className="memory-main">
      <strong className="memory-title">{record.pinned && <span className="memory-pin" title="Pinned"><Pin size={12} aria-hidden="true" /></span>}{record.title}</strong>
      <span className="memory-meta">
        {KINDS.find((kind) => kind.value === record.kind)?.label ?? record.kind} · {scopeLabel(record, agents, projects)} · {record.origin === 'agent' ? `Saved by a ${noun}` : 'Written by you'}
      </span>
      <p className="memory-body">{record.body}</p>
    </div>
    <div className="memory-actions">
      {!record.reviewed && <button type="button" className="primary-button small" disabled={busy} onClick={() => void run(() => rpc('memory.approve', { id: record.id }))}><Check size={13} aria-hidden="true" />Approve</button>}
      <button type="button" className="queue-icon" aria-label={`Edit ${record.title}`} title="Edit" disabled={busy} onClick={() => setEditing(record)}><Pencil size={13} /></button>
      <button type="button" className="queue-icon" aria-label={`Delete ${record.title}`} title="Delete" disabled={busy} onClick={() => setDeleting(record)}><Trash2 size={13} /></button>
    </div>
  </li>

  return <div className="memory-page">
    <p className="settings-intro">Memory lets {nouns} save short notes, like preferences and decisions, and recall them in later conversations. Notes a {noun} saves for a project or for everyone stay unused until you approve them. Don’t keep passwords or keys here.</p>
    <section className="settings-group memory-switches" aria-label="Memory">
      <div className="settings-card">
      <div className="settings-row">
        <RowCopy label={`Let ${nouns} use memory`} hint={`Adds saved notes to what ${nouns} see and lets them save new ones.`} />
        <span className="settings-row-control">
          <button type="button" className={`toggle ${enabled ? 'on' : ''}`} role="switch" aria-label={`Let ${nouns} use memory`} aria-checked={enabled} disabled={!connected || busy} onClick={() => void run(() => onEnabledChange(!enabled))}><i /></button>
        </span>
      </div>
      {enabled && <div className="settings-row">
        <RowCopy label={`Let ${nouns} suggest shared notes`} hint={`${Nouns} may propose notes for a project or for everyone. Each one waits for your approval before anyone uses it.`} />
        <span className="settings-row-control">
          <button type="button" className={`toggle ${sharedWrites ? 'on' : ''}`} role="switch" aria-label={`Let ${nouns} suggest shared notes`} aria-checked={sharedWrites} disabled={!connected || busy} onClick={() => void run(() => onSharedWritesChange(!sharedWrites))}><i /></button>
        </span>
      </div>}
      </div>
    </section>

    <section className="memory-about" aria-label="About you">
      <label className="blob-field"><span>About you<small className={aboutOver ? 'over' : ''}>{aboutDraft.length}/{ABOUT_LIMIT}</small></span>
        <textarea rows={4} value={aboutDraft} disabled={!connected} placeholder={`How you like to work, what you are building, anything every ${noun} should know.`} onChange={(event) => setAboutDraft(event.target.value)} />
      </label>
      <p className="memory-hint">Shared with every {noun}. Changing it starts new conversations with the updated text; a running Codex conversation keeps what it had.</p>
      <div className="memory-about-actions">
        <button type="button" className="secondary-button small" disabled={!aboutDirty || aboutOver || aboutSaving || !connected} onClick={async () => {
          setAboutSaving(true)
          setProblem(null)
          try { await onAboutSave(aboutDraft.trim()) } catch (reason) { setProblem(reason instanceof Error ? reason.message : 'That could not be saved.') } finally { setAboutSaving(false) }
        }}>{aboutSaving ? 'Saving…' : 'Save'}</button>
      </div>
    </section>

    <section aria-label="Notes" className="memory-notes">
      <div className="memory-toolbar">
        <input className="memory-search" type="search" aria-label="Search notes" placeholder="Search notes" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="button" className="secondary-button small" disabled={!connected} onClick={() => setEditing('new')}><Plus size={13} aria-hidden="true" />Add note</button>
      </div>
      {problem && <p className="memory-problem" role="alert">{problem}</p>}
      {records === null && <p className="blob-muted">Loading…</p>}
      {records !== null && records.length === 0 && !problem && <p className="memory-empty">No notes yet. {Nouns} save them as they work once memory is on, or you can add one.</p>}
      {review.length > 0 && <>
        <h3 className="memory-heading">Needs your review <b>{review.length}</b></h3>
        <ul className="memory-list">{review.map(row)}</ul>
      </>}
      {rest.length > 0 && <>
        {review.length > 0 && <h3 className="memory-heading">Saved notes</h3>}
        <ul className="memory-list">{rest.map(row)}</ul>
      </>}
      {records !== null && records.length > 0 && visible.length === 0 && <p className="memory-empty">No notes match that search.</p>}
    </section>

    {editing && <NoteEditor
      key={editing === 'new' ? 'new' : editing.id}
      existing={editing === 'new' ? null : editing}
      agents={agents.filter((agent) => !agent.archived)}
      projects={projects}
      onClose={() => setEditing(null)}
      onSave={async (draft) => {
        if (editing === 'new') await rpc('memory.create', { ...draft })
        else await rpc('memory.update', { id: editing.id, expectedVersion: editing.version, title: draft.title, body: draft.body, kind: draft.kind, pinned: draft.pinned })
        setEditing(null)
        await load()
      }} />}
    {deleting && <ConfirmDialog title={`Delete “${deleting.title}”?`} body={`${Nouns} will no longer see this note.`} confirmLabel="Delete" cancelLabel="Keep" tone="danger" onCancel={() => setDeleting(null)} onConfirm={async () => {
      const target = deleting
      setDeleting(null)
      await run(() => rpc('memory.delete', { id: target.id }))
    }} />}
  </div>
}

interface NoteDraft { scope: 'blob' | 'project' | 'shared'; scopeId?: string; kind: MemoryRecord['kind']; title: string; body: string; pinned: boolean }

function NoteEditor({ existing, agents, projects, onClose, onSave }: {
  existing: MemoryRecord | null
  agents: readonly Agent[]
  projects: readonly Project[]
  onClose: () => void
  onSave: (draft: NoteDraft) => Promise<void>
}) {
  const entered = useDialogEntered()
  const noun = useEntityNoun()
  const Noun = useEntityNoun({ capital: true })
  const Nouns = useEntityNoun({ plural: true, capital: true })
  const { ref, close } = useDialogAccessibility(onClose)
  const [title, setTitle] = useState(existing?.title ?? '')
  const [body, setBody] = useState(existing?.body ?? '')
  const [kind, setKind] = useState<MemoryRecord['kind']>(existing?.kind ?? 'fact')
  const [scope, setScope] = useState<NoteDraft['scope']>(existing?.scope ?? 'shared')
  const [scopeId, setScopeId] = useState(existing?.scopeId ?? (existing?.scope === 'project' ? projects[0]?.id : agents[0]?.id) ?? '')
  const [pinned, setPinned] = useState(existing?.pinned === true)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const needsTarget = scope !== 'shared'
  const targets = scope === 'project' ? projects.map((project) => ({ value: project.id, label: project.name })) : agents.map((agent) => ({ value: agent.id, label: agent.name }))
  const valid = title.trim().length > 0 && title.length <= TITLE_LIMIT && body.trim().length > 0 && body.length <= BODY_LIMIT && (!needsTarget || !!scopeId)

  const changeScope = (next: NoteDraft['scope']) => {
    setScope(next)
    setScopeId(next === 'project' ? projects[0]?.id ?? '' : next === 'blob' ? agents[0]?.id ?? '' : '')
  }
  const submit = async () => {
    if (!valid || saving) return
    setSaving(true)
    setFailure(null)
    try { await onSave({ scope, ...(needsTarget ? { scopeId } : {}), kind, title: title.trim(), body: body.trim(), pinned }) } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : 'The note could not be saved.')
      setSaving(false)
    }
  }

  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog memory-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-dialog-title" tabIndex={-1}>
      <h2 id="memory-dialog-title">{existing ? 'Edit note' : 'Add a note'}</h2>
      <label className="blob-field"><span>Title<small className={title.length > TITLE_LIMIT ? 'over' : ''}>{title.length}/{TITLE_LIMIT}</small></span><input data-dialog-initial-focus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Prefers tabs over spaces" /></label>
      <label className="blob-field"><span>Note<small className={body.length > BODY_LIMIT ? 'over' : ''}>{body.length}/{BODY_LIMIT}</small></span><textarea rows={4} value={body} onChange={(event) => setBody(event.target.value)} placeholder={`Short and specific. ${Nouns} will rely on this.`} /></label>
      <div className="memory-fields">
        <div className="blob-field"><span>Kind</span><Select ariaLabel="Kind" variant="field" value={kind} onChange={(value) => setKind(value as MemoryRecord['kind'])} options={KINDS} /></div>
        <div className="blob-field"><span>Who can use it</span>
          <Select ariaLabel="Who can use it" variant="field" value={scope} disabled={!!existing} onChange={(value) => changeScope(value as NoteDraft['scope'])} options={[{ value: 'shared', label: 'Everyone' }, { value: 'project', label: 'One project' }, { value: 'blob', label: `One ${noun}` }]} />
        </div>
        {needsTarget && <div className="blob-field"><span>{scope === 'project' ? 'Project' : Noun}</span><Select ariaLabel={scope === 'project' ? 'Project' : Noun} variant="field" value={scopeId} disabled={!!existing} onChange={setScopeId} options={targets} /></div>}
      </div>
      <label className="memory-pin-row"><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /><span>Pin it so it always comes first</span></label>
      {failure && <p className="memory-problem" role="alert">{failure}</p>}
      <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" onClick={close}>Cancel</button>
        <button type="button" className="primary-button" disabled={!valid || saving} onClick={() => void submit()}>{saving ? 'Saving…' : existing ? 'Save' : 'Add note'}</button>
      </div>
    </section>
  </div>
}
