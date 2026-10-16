// Backup: bots, their memory, skills, automations and app settings in one
// checksummed file. The native shell picks and reads the file and the daemon
// validates it, so the file's contents never reach this page; it sees counts,
// conflicts and warnings, and answers each conflict before the import runs.
import { useState } from 'react'
import { AlertTriangle, Check, FileDown, FileUp } from 'lucide-react'
import { previewBackupImport, rpc, selectBackupExportPath, selectBackupImportPath, writeBackupExport, type BackupInclude, type BackupStats } from '../tauri'
import { Select } from './Select'
import { SettingsGroup } from './SettingsParts'
import { useEntityNoun } from './vocabulary'
import './backup.css'

export type BackupPreview = Awaited<ReturnType<typeof previewBackupImport>>
type BotChoice = 'rename' | 'replace' | 'skip'
type SkillChoice = 'replace' | 'skip'
export interface BackupImportResult { imported?: Partial<BackupStats>; skipped?: Partial<BackupStats>; renamed?: Array<{ from: string; to: string }> }

const OPTIONAL: Array<{ key: keyof BackupInclude; label: string }> = [
  { key: 'memory', label: 'Memory notes' },
  { key: 'skills', label: 'Skills' },
  { key: 'automations', label: 'Automations' },
  { key: 'settings', label: 'App settings' },
]

/** "3 bots, 12 notes and 2 skills": only the parts that are there. */
export function statsSentence(stats: Partial<BackupStats> | undefined, botWord: [string, string]): string {
  if (!stats) return ''
  const parts: string[] = []
  const add = (count: number | undefined, one: string, many: string) => { if (count) parts.push(`${count} ${count === 1 ? one : many}`) }
  add(stats.bots, botWord[0], botWord[1])
  add(stats.memory, 'note', 'notes')
  add(stats.skills, 'skill', 'skills')
  add(stats.automations, 'automation', 'automations')
  add(stats.settings, 'setting', 'settings')
  if (!parts.length) return 'nothing'
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The resolutions payload `backup.import` takes, from the choices on screen. */
export function importResolutions(bots: Record<string, BotChoice>, skills: Record<string, SkillChoice>) {
  return { bots, skills, default: 'rename' as const }
}

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : fallback

export function BackupPage({ connected }: { connected: boolean }) {
  const noun = useEntityNoun()
  const nouns = useEntityNoun({ plural: true })
  const Nouns = useEntityNoun({ plural: true, capital: true })
  const botWord: [string, string] = [noun, nouns]
  const [include, setInclude] = useState<Required<BackupInclude>>({ memory: true, skills: true, automations: true, settings: true })
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<string | null>(null)
  const [exportProblem, setExportProblem] = useState<string | null>(null)
  const [preview, setPreview] = useState<BackupPreview | null>(null)
  const [reading, setReading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProblem, setImportProblem] = useState<string | null>(null)
  const [imported, setImported] = useState<string | null>(null)
  const [botChoices, setBotChoices] = useState<Record<string, BotChoice>>({})
  const [skillChoices, setSkillChoices] = useState<Record<string, SkillChoice>>({})

  const exportNow = async () => {
    setExportProblem(null)
    setExported(null)
    const token = await selectBackupExportPath().catch((reason) => { setExportProblem(messageOf(reason, 'The save dialog could not open.')); return null })
    if (!token) return
    setExporting(true)
    try {
      const result = await writeBackupExport(token, include)
      setExported(`Saved ${statsSentence(result.stats, botWord)} to ${result.path}.`)
    } catch (reason) {
      setExportProblem(messageOf(reason, 'The backup could not be saved.'))
    } finally { setExporting(false) }
  }

  const chooseFile = async () => {
    setImportProblem(null)
    setImported(null)
    const token = await selectBackupImportPath().catch((reason) => { setImportProblem(messageOf(reason, 'The file dialog could not open.')); return null })
    if (!token) return
    setReading(true)
    try {
      const next = await previewBackupImport(token)
      setPreview(next)
      setBotChoices(Object.fromEntries(next.conflicts.bots.map((bot) => [bot.exportId, 'rename' as BotChoice])))
      setSkillChoices(Object.fromEntries(next.conflicts.skills.filter((skill) => !skill.same).map((skill) => [skill.name, 'skip' as SkillChoice])))
    } catch (reason) {
      setPreview(null)
      setImportProblem(messageOf(reason, 'That file could not be read as a Bitbots backup.'))
    } finally { setReading(false) }
  }

  const importNow = async () => {
    if (!preview) return
    setImporting(true)
    setImportProblem(null)
    try {
      const result = await rpc<BackupImportResult>('backup.import', { previewId: preview.previewId, resolutions: importResolutions(botChoices, skillChoices) })
      const renamed = result.renamed ?? []
      const skipped = statsSentence(result.skipped, botWord)
      setImported([
        `Restored ${statsSentence(result.imported, botWord)}.`,
        renamed.length ? `Renamed ${renamed.map((item) => `${item.from} to ${item.to}`).join(', ')}.` : '',
        skipped !== 'nothing' ? `Skipped ${skipped}.` : '',
      ].filter(Boolean).join(' '))
      setPreview(null)
    } catch (reason) {
      setImportProblem(messageOf(reason, 'The backup could not be restored.'))
      // An expired preview cannot be retried; the file has to be chosen again.
      if (/expired|not_found/i.test(messageOf(reason, ''))) setPreview(null)
    } finally { setImporting(false) }
  }

  const changedSkills = preview?.conflicts.skills.filter((skill) => !skill.same) ?? []
  const settingChanges = preview?.conflicts.settings ?? []

  return <div className="backup-page">
    <p className="settings-intro">A backup keeps your {nouns}, what they remember, your skills, automations and app settings in one file. Conversations, projects and sign-ins are not included, and restored {nouns} start without a project.</p>

    <SettingsGroup title="Export">
      <div className="backup-section">
        <ul className="backup-checks">
          <li><label><input type="checkbox" checked disabled /><span>{Nouns}</span><small>Always included</small></label></li>
          {OPTIONAL.map((item) => <li key={item.key}><label>
            <input type="checkbox" checked={include[item.key]} disabled={exporting} onChange={(event) => setInclude((current) => ({ ...current, [item.key]: event.target.checked }))} />
            <span>{item.label}</span>
          </label></li>)}
        </ul>
        <p className="backup-note">Environment values, passwords and keys are never written to the file. Automations come back paused.</p>
        <div className="backup-actions">
          <button type="button" className="primary-button small" disabled={!connected || exporting} onClick={() => void exportNow()}><FileDown size={13} aria-hidden="true" />{exporting ? 'Saving…' : 'Export a backup…'}</button>
        </div>
        {exported && <p className="backup-done" role="status"><Check size={14} aria-hidden="true" />{exported}</p>}
        {exportProblem && <p className="memory-problem" role="alert">{exportProblem}</p>}
      </div>
    </SettingsGroup>

    <SettingsGroup title="Restore">
      <div className="backup-section">
        {!preview && <>
          <p className="backup-note">Choose a <code>.bitbots-backup.json</code> file. You will see what it holds before anything changes.</p>
          <div className="backup-actions">
            <button type="button" className="secondary-button small" disabled={!connected || reading} onClick={() => void chooseFile()}><FileUp size={13} aria-hidden="true" />{reading ? 'Reading…' : 'Choose a backup…'}</button>
          </div>
        </>}
        {preview && <div className="backup-preview" aria-label="What this backup holds">
          <p className="backup-summary">This backup holds {statsSentence(preview.counts, botWord)}.</p>
          {preview.warnings.length > 0 && <ul className="backup-warnings">
            {preview.warnings.map((warning) => <li key={warning}><AlertTriangle size={13} aria-hidden="true" />{warning}</li>)}
          </ul>}
          {preview.conflicts.bots.length > 0 && <div className="backup-conflicts">
            <h4>{Nouns} with the same name</h4>
            {preview.conflicts.bots.map((bot) => <div key={bot.exportId} className="backup-conflict">
              <span>{bot.name}</span>
              <Select ariaLabel={`What to do with ${bot.name}`} variant="field" value={botChoices[bot.exportId] ?? 'rename'} onChange={(value) => setBotChoices((current) => ({ ...current, [bot.exportId]: value as BotChoice }))} options={[
                { value: 'rename', label: 'Keep both' },
                { value: 'replace', label: `Replace this ${noun}` },
                { value: 'skip', label: 'Skip' },
              ]} />
            </div>)}
            <p className="backup-note">Replacing keeps the {noun}’s conversations and memory and updates its look, role, instructions and model.</p>
          </div>}
          {changedSkills.length > 0 && <div className="backup-conflicts">
            <h4>Skills that differ from yours</h4>
            {changedSkills.map((skill) => <div key={skill.name} className="backup-conflict">
              <span className="mono">{skill.name}</span>
              <Select ariaLabel={`What to do with ${skill.name}`} variant="field" value={skillChoices[skill.name] ?? 'skip'} onChange={(value) => setSkillChoices((current) => ({ ...current, [skill.name]: value as SkillChoice }))} options={[
                { value: 'skip', label: 'Keep mine' },
                { value: 'replace', label: 'Use the backup’s' },
              ]} />
            </div>)}
          </div>}
          {settingChanges.length > 0 && <p className="backup-note">{settingChanges.length} app setting{settingChanges.length === 1 ? '' : 's'} will change to the backup’s value.</p>}
          <div className="backup-actions">
            <button type="button" className="ghost-button small" disabled={importing} onClick={() => setPreview(null)}>Cancel</button>
            <button type="button" className="primary-button small" disabled={!connected || importing} onClick={() => void importNow()}>{importing ? 'Restoring…' : 'Restore'}</button>
          </div>
        </div>}
        {imported && <p className="backup-done" role="status"><Check size={14} aria-hidden="true" />{imported}</p>}
        {importProblem && <p className="memory-problem" role="alert">{importProblem}</p>}
      </div>
    </SettingsGroup>
  </div>
}
