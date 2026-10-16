// Skills: one pool of skill folders (SKILL.md plus files) that every bot can
// load through the bloblex tools. The daemon owns the pool and the import
// guards; this page lists it, imports from the coding agents' own skill folders
// or any folder, shows a skill read-only, and switches skills on or off.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Eye, FolderOpen, RefreshCw, Trash2, X } from 'lucide-react'
import { openProjectFolder, rpc } from '../tauri'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
import { ConfirmDialog } from './BlobPage'
import { ProviderLogo } from './providerBrand'
import { RowCopy } from './SettingsParts'
import { Skeleton } from './Skeleton'
import { useEntityNoun } from './vocabulary'
import './skills.css'

export interface SkillRow {
  name: string
  description: string
  source: string
  sourcePath?: string | null
  enabled: boolean
  fileCount?: number
  totalBytes?: number
  disabledFor?: string[]
  nativeFor?: string[]
}

export interface SkillCandidate {
  source: string
  name: string
  description: string
  path: string
  status: 'new' | 'same' | 'changed'
}

interface SkillDetail { name: string; description: string; body: string; files: Array<{ path: string; bytes: number }> }

const SOURCE_LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', folder: 'Folder', backup: 'Backup' }
const PROVIDER_SOURCES = new Set(['claude', 'codex', 'opencode'])

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source
}

export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function isSkillRow(value: unknown): value is SkillRow {
  const row = value as Partial<SkillRow> | null
  return !!row && typeof row.name === 'string' && typeof row.description === 'string' && typeof row.source === 'string' && typeof row.enabled === 'boolean'
}

/** Case-insensitive match on name and description; every word must match. */
export function filterSkills(skills: readonly SkillRow[], query: string): SkillRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...skills]
  return skills.filter((skill) => { const text = `${skill.name} ${skill.description}`.toLowerCase(); return words.every((word) => text.includes(word)) })
}

/** The candidates worth importing start ticked: new ones and changed ones. */
export function defaultPicks(candidates: readonly SkillCandidate[]): Set<string> {
  return new Set(candidates.filter((candidate) => candidate.status !== 'same').map(candidateKey))
}

export function candidateKey(candidate: Pick<SkillCandidate, 'source' | 'name'>): string {
  return `${candidate.source}:${candidate.name}`
}

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : fallback

function SourceBadge({ source }: { source: string }) {
  return <span className="skill-source">{PROVIDER_SOURCES.has(source) && <ProviderLogo provider={source} size={12} />}{sourceLabel(source)}</span>
}

export function SkillsPage({ connected }: { connected: boolean }) {
  const noun = useEntityNoun()
  const nouns = useEntityNoun({ plural: true })
  const Nouns = useEntityNoun({ plural: true, capital: true })
  const [skills, setSkills] = useState<SkillRow[] | null>(null)
  const [poolOn, setPoolOn] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [candidates, setCandidates] = useState<SkillCandidate[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [picks, setPicks] = useState<Set<string>>(new Set())
  const [viewing, setViewing] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SkillRow | null>(null)

  const load = useCallback(async () => {
    try {
      const [list, settings] = await Promise.all([
        rpc<{ skills?: unknown[] }>('skills.list'),
        rpc<Record<string, unknown>>('settings.get').catch((): Record<string, unknown> => ({})),
      ])
      setSkills((Array.isArray(list.skills) ? list.skills : []).filter(isSkillRow))
      const values: Record<string, unknown> = (settings as { settings?: Record<string, unknown> }).settings ?? settings
      setPoolOn(values['skills.enabled'] !== false)
      setProblem(null)
    } catch (reason) {
      setSkills([])
      setProblem(messageOf(reason, 'Skills could not be loaded.'))
    }
  }, [])
  useEffect(() => { if (connected) void load() }, [connected, load])

  const run = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true)
    setProblem(null)
    try { await work(); await load() } catch (reason) { setProblem(messageOf(reason, failure)) } finally { setBusy(false) }
  }

  const reportImport = (result: { imported?: unknown[]; skipped?: Array<{ name?: string; reason?: string }> }) => {
    const imported = Array.isArray(result.imported) ? result.imported.length : 0
    const skipped = Array.isArray(result.skipped) ? result.skipped : []
    const parts = [imported ? `Imported ${imported} skill${imported === 1 ? '' : 's'}.` : 'Nothing was imported.']
    if (skipped.length) parts.push(`Skipped ${skipped.map((item) => `${item.name ?? 'one'}${item.reason ? ` (${item.reason})` : ''}`).join(', ')}.`)
    setNotice(parts.join(' '))
  }

  const scan = async () => {
    setScanning(true)
    setProblem(null)
    setNotice(null)
    try {
      const result = await rpc<{ candidates?: SkillCandidate[] }>('skills.scan')
      const found = Array.isArray(result.candidates) ? result.candidates : []
      setCandidates(found)
      setPicks(defaultPicks(found))
    } catch (reason) {
      setProblem(messageOf(reason, 'Your coding agents’ skills could not be read.'))
    } finally { setScanning(false) }
  }

  const importPicked = () => void run(async () => {
    const items = (candidates ?? []).filter((candidate) => picks.has(candidateKey(candidate))).map(({ source, name }) => ({ source, name }))
    const result = await rpc<{ imported?: unknown[]; skipped?: Array<{ name?: string; reason?: string }> }>('skills.import', { items })
    reportImport(result)
    setCandidates(null)
  }, 'Those skills could not be imported.')

  const importFolder = async () => {
    const path = await openProjectFolder()
    if (!path) return
    setNotice(null)
    await run(async () => reportImport(await rpc('skills.import', { path })), 'That folder could not be imported.')
  }

  const visible = useMemo(() => filterSkills(skills ?? [], query), [skills, query])
  const pickedCount = (candidates ?? []).filter((candidate) => picks.has(candidateKey(candidate))).length

  const row = (skill: SkillRow) => {
    const meta = [skill.fileCount ? `${skill.fileCount} file${skill.fileCount === 1 ? '' : 's'}` : '', formatBytes(skill.totalBytes)].filter(Boolean).join(' · ')
    const native = (skill.nativeFor ?? []).map(sourceLabel)
    return <li key={skill.name} className={`skill-row${skill.enabled ? '' : ' off'}`}>
      <div className="skill-main">
        <span className="skill-title"><strong>{skill.name}</strong><SourceBadge source={skill.source} /></span>
        <p className="skill-description">{skill.description}</p>
        {(meta || native.length > 0) && <span className="skill-meta">{meta}{native.length > 0 && <>{meta && ' · '}{native.join(' and ')} also {native.length === 1 ? 'loads' : 'load'} {native.length === 1 ? 'its' : 'their'} own copy</>}</span>}
      </div>
      <div className="skill-actions">
        <button type="button" className="queue-icon" aria-label={`View ${skill.name}`} title="View" onClick={() => setViewing(skill.name)}><Eye size={14} /></button>
        <button type="button" className="queue-icon" aria-label={`Delete ${skill.name}`} title="Delete" disabled={busy} onClick={() => setDeleting(skill)}><Trash2 size={14} /></button>
        <button type="button" className={`toggle ${skill.enabled ? 'on' : ''}`} role="switch" aria-label={`Use ${skill.name}`} aria-checked={skill.enabled} disabled={busy || !connected} onClick={() => void run(() => rpc('skills.toggle', { name: skill.name, enabled: !skill.enabled }), 'That skill could not be changed.')}><i /></button>
      </div>
    </li>
  }

  return <div className="skills-page">
    <p className="settings-intro">Skills are folders of instructions, and sometimes scripts, that every {noun} can load when a task matches. {Nouns} see a short list and load a skill only when they need it, so a large pool costs little.</p>
    <section className="settings-group" aria-label="Skills switch">
      <div className="settings-card">
        <div className="settings-row">
          <RowCopy label={`Let ${nouns} use skills`} hint={`Adds the list of skills to what ${nouns} see and gives them tools to load one. You can also turn single skills off for one ${noun} on its page.`} />
          <span className="settings-row-control">
            <button type="button" className={`toggle ${poolOn ? 'on' : ''}`} role="switch" aria-label={`Let ${nouns} use skills`} aria-checked={poolOn} disabled={!connected || busy} onClick={() => void run(async () => { await rpc('settings.set', { key: 'skills.enabled', value: !poolOn }); setPoolOn(!poolOn) }, 'That setting could not be saved.')}><i /></button>
          </span>
        </div>
      </div>
    </section>

    <section className="skills-import" aria-label="Import skills">
      <div className="skills-import-head">
        <span className="skills-import-copy"><strong>Import skills</strong><small>Copies are kept in Bitbots. The originals are never changed.</small></span>
        <span className="skills-import-actions">
          <button type="button" className="secondary-button small" disabled={!connected || scanning || busy} onClick={() => void scan()}><RefreshCw size={13} aria-hidden="true" className={scanning ? 'skills-spin' : undefined} />{candidates ? 'Look again' : 'From your coding agents'}</button>
          <button type="button" className="secondary-button small" disabled={!connected || busy} onClick={() => void importFolder()}><FolderOpen size={13} aria-hidden="true" />A folder</button>
        </span>
      </div>
      {scanning && !candidates && <Skeleton lines={3} />}
      {candidates && <div className="skills-candidates">
        {candidates.length === 0
          ? <p className="skills-empty-inline">No skills found in Claude Code, Codex or OpenCode.</p>
          : <ul className="skills-candidate-list">
            {candidates.map((candidate) => {
              const key = candidateKey(candidate)
              const same = candidate.status === 'same'
              return <li key={key} className={`skills-candidate${same ? ' same' : ''}`}>
                <label>
                  <input type="checkbox" checked={picks.has(key)} disabled={same || busy} onChange={(event) => setPicks((current) => { const next = new Set(current); if (event.target.checked) next.add(key); else next.delete(key); return next })} />
                  <span className="skills-candidate-copy">
                    <span className="skill-title"><strong>{candidate.name}</strong><SourceBadge source={candidate.source} /><span className={`skills-status ${candidate.status}`}>{candidate.status === 'new' ? 'New' : candidate.status === 'changed' ? 'Changed' : 'Already in the pool'}</span></span>
                    <small>{candidate.description}</small>
                  </span>
                </label>
              </li>
            })}
          </ul>}
        <div className="skills-candidate-actions">
          <button type="button" className="ghost-button small" onClick={() => setCandidates(null)}>Cancel</button>
          {candidates.length > 0 && <button type="button" className="primary-button small" disabled={!pickedCount || busy} onClick={importPicked}><Check size={13} aria-hidden="true" />{pickedCount ? `Import ${pickedCount}` : 'Import'}</button>}
        </div>
      </div>}
    </section>

    <section aria-label="Skills in the pool" className="skills-pool">
      <div className="memory-toolbar">
        <input className="memory-search" type="search" aria-label="Search skills" placeholder="Search skills" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {notice && <p className="skills-notice" role="status">{notice}<button type="button" className="queue-icon" aria-label="Dismiss" onClick={() => setNotice(null)}><X size={13} /></button></p>}
      {problem && <p className="memory-problem" role="alert">{problem}</p>}
      {skills === null && <Skeleton lines={3} />}
      {skills !== null && skills.length === 0 && !problem && <p className="memory-empty">No skills yet. Import the ones your coding agents already have, or a folder with a SKILL.md.</p>}
      {visible.length > 0 && <ul className={`skills-list${poolOn ? '' : ' paused'}`}>{visible.map(row)}</ul>}
      {skills !== null && skills.length > 0 && visible.length === 0 && <p className="memory-empty">No skills match that search.</p>}
    </section>

    {viewing && <SkillViewer name={viewing} onClose={() => setViewing(null)} />}
    {deleting && <ConfirmDialog title={`Delete “${deleting.name}”?`} body={`${Nouns} will no longer see this skill. The original folder it came from is not touched.`} confirmLabel="Delete" cancelLabel="Keep" tone="danger" onCancel={() => setDeleting(null)} onConfirm={async () => {
      const target = deleting
      setDeleting(null)
      await run(() => rpc('skills.delete', { name: target.name }), 'That skill could not be deleted.')
    }} />}
  </div>
}

function SkillViewer({ name, onClose }: { name: string; onClose: () => void }) {
  const entered = useDialogEntered()
  const { ref, close } = useDialogAccessibility(onClose)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    rpc<SkillDetail>('skills.get', { name })
      .then((result) => { if (!cancelled) setDetail(result) })
      .catch((reason) => { if (!cancelled) setProblem(messageOf(reason, 'This skill could not be read.')) })
    return () => { cancelled = true }
  }, [name])
  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog skill-viewer" role="dialog" aria-modal="true" aria-labelledby="skill-viewer-title" tabIndex={-1}>
      <header className="skill-viewer-head">
        <h2 id="skill-viewer-title">{name}</h2>
        <button type="button" className="queue-icon" aria-label="Close" data-dialog-initial-focus onClick={close}><X size={15} /></button>
      </header>
      {problem && <p className="memory-problem" role="alert">{problem}</p>}
      {!detail && !problem && <Skeleton lines={6} />}
      {detail && <>
        <p className="skill-viewer-description">{detail.description}</p>
        <pre className="skill-viewer-body">{detail.body}</pre>
        {detail.files.length > 0 && <div className="skill-viewer-files">
          <h3>Files</h3>
          <ul>{detail.files.map((file) => <li key={file.path}><span>{file.path}</span><small>{formatBytes(file.bytes)}</small></li>)}</ul>
        </div>}
      </>}
    </section>
  </div>
}
