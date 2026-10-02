import type { Runtime } from '../types'
import type { AgentDraft, FieldErrors, StoredExecution } from './agentForm'
import { runtimeDotClass, runtimeOptionLabel, scalarLength } from './rosterSelectors'
import { SwatchGrid } from './SwatchGrid'

const LATER = 'Available in a later update.'

export function BlobSettings({ draft, runtimes, errors, execution, onDraftChange, onArchive }: {
  draft: AgentDraft
  runtimes: Runtime[]
  errors: FieldErrors
  execution: StoredExecution
  onDraftChange: (draft: AgentDraft) => void
  onArchive?: () => void
}) {
  const descriptionCount = scalarLength(draft.description)
  const runtime = runtimes.find((item) => item.id === draft.runtimeId) ?? null
  const described = (id: string, errorId?: string) => errorId ? `${id} ${errorId}` : id
  return <>
    <section className="blob-card">
      <h3>Profile</h3>
      <SwatchGrid value={draft.color} onChange={(color) => onDraftChange({ ...draft, color })} />
      <label className="blob-field">Name
        <input aria-label="Blob name" aria-invalid={!!errors.name} aria-describedby={errors.name ? 'blob-name-error' : undefined} value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} />
      </label>
      {errors.name && <p className="blob-error" id="blob-name-error">{errors.name}</p>}
      <label className="blob-field">Description
        <textarea aria-label="Description" aria-invalid={!!errors.description} aria-describedby={described('blob-description-count', errors.description ? 'blob-description-error' : undefined)} value={draft.description} onChange={(event) => onDraftChange({ ...draft, description: event.target.value })} />
      </label>
      <p id="blob-description-count" className="blob-counter" style={{ color: descriptionCount > 255 ? 'var(--bad)' : 'var(--ink-3)' }}>{descriptionCount} / 255</p>
      {errors.description && <p className="blob-error" id="blob-description-error">{errors.description}</p>}
      <label className="blob-field">Instructions
        <textarea aria-label="Instructions" aria-invalid={!!errors.instructions} aria-describedby={described('blob-instructions-help', errors.instructions ? 'blob-instructions-error' : undefined)} value={draft.instructions} onChange={(event) => onDraftChange({ ...draft, instructions: event.target.value })} />
      </label>
      <p id="blob-instructions-help" className="blob-help">Saved with this blob. Bloblex does not send instructions to the CLI until a later update.</p>
      {errors.instructions && <p className="blob-error" id="blob-instructions-error">{errors.instructions}</p>}
    </section>
    <section className="blob-card">
      <h3>Execution</h3>
      <p className="blob-help">These options apply to new sessions in a later update. This update only saves the runtime and the default project.</p>
      <label className="blob-field">Runtime
        <span className="blob-runtime-picker">
          <i className={`status-dot ${runtimeDotClass(runtime?.status)}`} />
          <select aria-label="Runtime" value={draft.runtimeId} onChange={(event) => onDraftChange({ ...draft, runtimeId: event.target.value })}>
            {runtimes.map((item) => <option key={item.id} value={item.id}>{runtimeOptionLabel(item, runtimes)}</option>)}
          </select>
        </span>
      </label>
      {errors.runtimeId && <p className="blob-error">{errors.runtimeId}</p>}
      <p className="blob-help">New sessions use this runtime. Existing conversations stay on the runtime that started them.</p>
      <label className="blob-field">Model
        <input disabled aria-describedby="execution-later" value={execution.model?.trim() ? execution.model : 'CLI default'} />
      </label>
      <label className="blob-field">Thinking
        <input disabled aria-describedby="execution-later" value={execution.thinking?.trim() ? execution.thinking : 'Runtime default'} />
      </label>
      <label className="blob-field">Speed
        <input disabled aria-describedby="execution-later" value={execution.serviceTier?.trim() ? execution.serviceTier : 'Runtime default'} />
      </label>
      <label className="blob-field">Concurrency
        <input disabled type="number" aria-describedby="execution-later" value={execution.maxConcurrency ?? 1} />
      </label>
      <p id="execution-later" className="blob-help">{LATER}</p>
      <label className="blob-field">Default project
        <input aria-label="Default project" aria-describedby="blob-project-help" value={draft.defaultProject ?? ''} onChange={(event) => onDraftChange({ ...draft, defaultProject: event.target.value })} />
      </label>
      <p id="blob-project-help" className="blob-help">New sessions start in this folder when it exists. Leave blank to choose a folder each time.</p>
      <p className="blob-help">Custom arguments and environment are not available yet.</p>
      {onArchive && <button type="button" className="secondary-button" onClick={onArchive}>Archive blob</button>}
    </section>
  </>
}
