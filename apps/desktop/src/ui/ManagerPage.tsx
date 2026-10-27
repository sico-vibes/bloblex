// Settings › Manager: what the Manager knows about you and the playbook it
// works from. Both live in the daemon outside any provider session, so they
// stay when the Manager's model changes. The Manager can only propose changes
// to a locked fact or to the playbook; edits made here apply at once.
import { useCallback, useEffect, useState } from 'react'
import { Lock, LockOpen, Pencil, Plus, RotateCcw, Trash2, BriefcaseBusiness } from 'lucide-react'
import type { Agent, ManagerFact, PlaybookVersion } from '../types'
import { listenForDaemonEvents, rpc } from '../tauri'
import { rpcFailure } from '../executionContract'
import { SettingsGroup, SettingsRow } from './SettingsParts'
import { Select } from './Select'
import { PlaybookDiff } from './PlaybookDiff'
import { SafeMarkdown } from './SafeMarkdown'
import { ScheduleOverview } from './ScheduleOverview'
import { DelegationPause } from './DelegationPause'
import { unwrapMarkdown } from './WhatsNew'
import { openSafeLink } from './openSafeLink'
import './managerPage.css'

export const FACT_CATEGORIES: Array<{ id: ManagerFact['category']; label: string }> = [
  { id: 'identity', label: 'About you' },
  { id: 'workflow', label: 'How you work' },
  { id: 'style', label: 'How you like to talk' },
  { id: 'conventions', label: 'Coding conventions' },
  { id: 'design', label: 'Design taste' },
  { id: 'other', label: 'Other' },
]
const SOURCE_WORD: Record<ManagerFact['source'], string> = { said: 'You said', learned: 'Learned', corrected: 'Checked by you' }
const AUTHOR_WORD: Record<PlaybookVersion['author'], string> = { default: 'Starting playbook', user: 'Edited by you', manager: 'Proposed by the Manager' }
export const FACT_VALUE_LIMIT = 1000
export const PLAYBOOK_LIMIT = 16000

/** Facts grouped in category order; empty categories are left out. */
export function groupFacts(facts: readonly ManagerFact[]): Array<{ id: ManagerFact['category']; label: string; facts: ManagerFact[] }> {
  return FACT_CATEGORIES
    .map((category) => ({ ...category, facts: facts.filter((fact) => fact.category === category.id).sort((a, b) => Number(b.locked) - Number(a.locked) || a.key.localeCompare(b.key)) }))
    .filter((group) => group.facts.length > 0)
}

const when = (iso: string | undefined) => {
  const time = Date.parse(iso ?? '')
  return Number.isFinite(time) ? new Date(time).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
}

type FactDraft = { id?: string; category: ManagerFact['category']; key: string; value: string; locked: boolean }

function FactForm({ draft, busy, onSave, onCancel }: { draft: FactDraft; busy: boolean; onSave: (draft: FactDraft) => void; onCancel: () => void }) {
  const [value, setValue] = useState(draft)
  const isNew = !draft.id
  const ready = value.key.trim().length > 0 && value.value.trim().length > 0
  return <form className="manager-fact-form" onSubmit={(event) => { event.preventDefault(); if (ready) onSave({ ...value, key: value.key.trim(), value: value.value.trim() }) }}>
    {isNew && <div className="manager-fact-form-row">
      <div className="settings-field"><span>Kind</span><Select ariaLabel="Kind" variant="field" value={value.category} onChange={(category) => setValue({ ...value, category: category as ManagerFact['category'] })} options={FACT_CATEGORIES.map((category) => ({ value: category.id, label: category.label }))} /></div>
      <label className="settings-field"><span>What</span><input className="text-input" placeholder="Preferred language" value={value.key} maxLength={80} autoFocus onChange={(event) => setValue({ ...value, key: event.target.value })} /></label>
    </div>}
    <label className="settings-field"><span>{isNew ? 'Value' : value.key}</span><textarea className="text-input" rows={2} value={value.value} maxLength={FACT_VALUE_LIMIT} autoFocus={!isNew} onChange={(event) => setValue({ ...value, value: event.target.value })} /></label>
    <label className="manager-fact-lock"><input type="checkbox" checked={value.locked} onChange={(event) => setValue({ ...value, locked: event.target.checked })} />Lock it, so the Manager has to ask before changing it</label>
    <div className="settings-form-actions">
      <button type="button" className="ghost-button small" onClick={onCancel}>Cancel</button>
      <button className="primary-button small" disabled={busy || !ready}>Save</button>
    </div>
  </form>
}

export function ManagerPage({ manager, connected = true, onOpenManager, agents = [], onOpenSession }: { manager: Agent | null; connected?: boolean; onOpenManager: (agentId: string) => void; agents?: readonly Agent[]; onOpenSession?: (sessionId: string) => void }) {
  const [facts, setFacts] = useState<ManagerFact[] | null>(null)
  const [versions, setVersions] = useState<PlaybookVersion[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingFact, setEditingFact] = useState<FactDraft | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [editingPlaybook, setEditingPlaybook] = useState<string | null>(null)
  const [comparing, setComparing] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const [profile, history] = await Promise.all([
        rpc<{ facts?: ManagerFact[] }>('manager.profile.list'),
        rpc<{ versions?: PlaybookVersion[] }>('manager.playbook.history'),
      ])
      setFacts(Array.isArray(profile?.facts) ? profile.facts : [])
      setVersions(Array.isArray(history?.versions) ? history.versions : [])
      setProblem(null)
    } catch (reason) {
      setFacts((current) => current ?? [])
      setProblem(rpcFailure(reason).message)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    let stop: (() => void) | null = null
    let alive = true
    void listenForDaemonEvents((event) => { if (event.type === 'manager.profile.changed' || event.type === 'manager.playbook.changed') void load() })
      .then((fn) => { if (alive) stop = fn; else fn() }).catch(() => undefined)
    return () => { alive = false; stop?.() }
  }, [load])

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setProblem(null)
    try { await work(); await load() } catch (reason) { setProblem(rpcFailure(reason).message) } finally { setBusy(false) }
  }
  const saveFact = (draft: FactDraft) => act(async () => {
    await rpc('manager.profile.set', { ...(draft.id ? { id: draft.id } : {}), category: draft.category, key: draft.key, value: draft.value, locked: draft.locked })
    setEditingFact(null)
  })
  const toggleLock = (fact: ManagerFact) => act(() => rpc('manager.profile.set', { id: fact.id, category: fact.category, key: fact.key, value: fact.value, locked: !fact.locked }))
  const deleteFact = (fact: ManagerFact) => act(async () => { await rpc('manager.profile.delete', { id: fact.id }); setConfirmDelete(null) })
  const current = versions[0] ?? null
  const savePlaybook = (text: string) => act(async () => { await rpc('manager.playbook.set', { text }); setEditingPlaybook(null) })
  const restore = (version: number) => act(async () => { await rpc('manager.playbook.revert', { version }); setComparing(null) })

  const groups = groupFacts(facts ?? [])
  return <>
    <p className="settings-intro">Your Manager keeps notes about you and a playbook for how it works. They stay when you change its model, so a new model picks up where the old one left off.</p>
    {problem && <p className="settings-banner error" role="alert">{problem}</p>}

    <SettingsGroup title="Manager">
      {manager
        ? <SettingsRow label={<span className="manager-identity"><BriefcaseBusiness size={14} aria-hidden="true" />{manager.name}</span>} hint={`${manager.model ? `${manager.model} · ` : ''}Name, look, model and personality are set on its page. Changing the model starts a fresh conversation; it keeps everything below.`}>
          <button type="button" className="secondary-button small" onClick={() => onOpenManager(manager.id)}>Open</button>
        </SettingsRow>
        : <SettingsRow label="No Manager yet" hint="Set one up from the card at the top of the sidebar. It plans the work with you and asks before it creates anything." />}
    </SettingsGroup>

    <DelegationPause connected={connected} />

    <ScheduleOverview agents={agents} connected={connected} onOpenSession={onOpenSession} />

    <SettingsGroup title="What it knows about you" action={<button type="button" className="ghost-button small" disabled={busy || !connected || editingFact !== null} onClick={() => setEditingFact({ category: 'workflow', key: '', value: '', locked: true })}><Plus size={13} aria-hidden="true" />Add</button>}>
      {editingFact && !editingFact.id && <FactForm draft={editingFact} busy={busy} onSave={(draft) => void saveFact(draft)} onCancel={() => setEditingFact(null)} />}
      {facts === null && <p className="settings-loading">Loading…</p>}
      {facts !== null && facts.length === 0 && !editingFact && <p className="settings-empty manager-empty">Nothing yet. The Manager notes what it learns as you work together, and you can add things yourself. Lock what matters, and it will ask before changing it.</p>}
      {groups.map((group) => <div key={group.id} className="manager-fact-group">
        <h4>{group.label}</h4>
        <ul className="manager-facts">
          {group.facts.map((fact) => <li key={fact.id} className={fact.locked ? 'locked' : ''}>
            {editingFact?.id === fact.id
              ? <FactForm draft={editingFact} busy={busy} onSave={(draft) => void saveFact(draft)} onCancel={() => setEditingFact(null)} />
              : <>
                <span className="manager-fact-copy">
                  <strong>{fact.key}</strong>
                  <span>{fact.value}</span>
                  <small>{SOURCE_WORD[fact.source] ?? fact.source}{fact.updatedAt ? ` · ${when(fact.updatedAt)}` : ''}</small>
                </span>
                <span className="manager-fact-actions">
                  <button type="button" className="icon-button" aria-pressed={fact.locked} aria-label={fact.locked ? `Unlock ${fact.key}` : `Lock ${fact.key}`} title={fact.locked ? 'Locked: the Manager asks before changing it' : 'Lock it'} disabled={busy} onClick={() => void toggleLock(fact)}>{fact.locked ? <Lock size={14} /> : <LockOpen size={14} />}</button>
                  <button type="button" className="icon-button" aria-label={`Edit ${fact.key}`} title="Edit" disabled={busy} onClick={() => setEditingFact({ id: fact.id, category: fact.category, key: fact.key, value: fact.value, locked: fact.locked })}><Pencil size={14} /></button>
                  {confirmDelete === fact.id
                    ? <button type="button" className="ghost-button small danger" disabled={busy} onClick={() => void deleteFact(fact)} onBlur={() => setConfirmDelete(null)} autoFocus>Delete?</button>
                    : <button type="button" className="icon-button" aria-label={`Delete ${fact.key}`} title="Delete" disabled={busy} onClick={() => setConfirmDelete(fact.id)}><Trash2 size={14} /></button>}
                </span>
              </>}
          </li>)}
        </ul>
      </div>)}
    </SettingsGroup>

    <SettingsGroup title="Playbook" action={editingPlaybook === null && current ? <button type="button" className="ghost-button small" disabled={busy || !connected} onClick={() => setEditingPlaybook(current.text)}><Pencil size={13} aria-hidden="true" />Edit</button> : undefined}>
      <p className="manager-playbook-intro">How the Manager interviews you, plans a team and works with you. It can propose changes, which you approve in the chat.</p>
      {editingPlaybook !== null
        ? <form className="manager-playbook-form" onSubmit={(event) => { event.preventDefault(); if (editingPlaybook.trim()) void savePlaybook(editingPlaybook) }}>
          <textarea className="text-input mono" aria-label="Playbook" rows={16} value={editingPlaybook} maxLength={PLAYBOOK_LIMIT} onChange={(event) => setEditingPlaybook(event.target.value)} />
          <small className="manager-count">{editingPlaybook.length.toLocaleString()} / {PLAYBOOK_LIMIT.toLocaleString()}</small>
          {current && editingPlaybook !== current.text && <PlaybookDiff before={current.text} after={editingPlaybook} label="Your changes" />}
          <div className="settings-form-actions">
            <button type="button" className="ghost-button small" onClick={() => setEditingPlaybook(null)}>Cancel</button>
            <button className="primary-button small" disabled={busy || !editingPlaybook.trim() || editingPlaybook === current?.text}>Save playbook</button>
          </div>
        </form>
        : current ? <div className="manager-playbook"><SafeMarkdown text={unwrapMarkdown(current.text)} onOpenLink={(url) => void openSafeLink(url)} /></div> : <p className="settings-loading">Loading…</p>}
      {versions.length > 1 && <div className="manager-history">
        <h4>History</h4>
        <ol>
          {versions.map((version, index) => {
            const previous = versions[index + 1]
            const open = comparing === version.version
            return <li key={version.version}>
              <div className="manager-history-row">
                <span><strong>Version {version.version}</strong>{index === 0 && <em>Current</em>}<small>{AUTHOR_WORD[version.author] ?? version.author}{version.createdAt ? ` · ${when(version.createdAt)}` : ''}</small></span>
                {previous && <button type="button" className="ghost-button small" aria-expanded={open} onClick={() => setComparing(open ? null : version.version)}>{open ? 'Hide changes' : 'Changes'}</button>}
                {index > 0 && <button type="button" className="ghost-button small" disabled={busy || !connected} onClick={() => void restore(version.version)}><RotateCcw size={12} aria-hidden="true" />Restore</button>}
              </div>
              {open && previous && <PlaybookDiff before={previous.text} after={version.text} label={`Changes in version ${version.version}`} />}
            </li>
          })}
        </ol>
      </div>}
    </SettingsGroup>
  </>
}
