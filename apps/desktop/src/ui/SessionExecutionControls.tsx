import { useEffect, useMemo, useState } from 'react'
import type { Agent, Session } from '../types'
import { rpc } from '../tauri'
import { parseModelCatalog, type ModelCatalog } from '../executionContract'
import { ConfirmDialog } from './BlobPage'

type Lock = { model?: string | null; thinking?: string | null }

export function SessionExecutionControls({ session, agent, onSessionUpdated, onError }: {
  session: Session
  agent: Agent
  onSessionUpdated: (session: Session) => void
  onError: (reason: unknown) => void
}) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [pendingModel, setPendingModel] = useState<string | null | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let cancelled = false
    void rpc('runtime.models', { runtimeId: session.runtimeId }).then((value) => {
      if (!cancelled) setCatalog(parseModelCatalog(value))
    }).catch(() => { if (!cancelled) setCatalog(null) })
    return () => { cancelled = true }
  }, [session.runtimeId])

  const lock = (session.modelLock && typeof session.modelLock === 'object' ? session.modelLock : {}) as Lock
  const model = lock.model === undefined ? agent.model : lock.model
  const thinking = lock.thinking === undefined ? agent.thinking : lock.thinking
  const selectedModel = useMemo(() => catalog?.models.find((item) => item.id === model) ?? null, [catalog, model])
  const efforts = selectedModel?.supportedThinking ?? []
  const save = async (nextModel: string | null, nextThinking: string | null, confirmModelChange = false) => {
    setSaving(true)
    try {
      const result = await rpc<{ session?: Session }>('session.model.update', {
        sessionId: session.id, model: nextModel, thinking: nextThinking, confirmModelChange,
      })
      if (result.session) onSessionUpdated(result.session)
    } catch (reason) { onError(reason) }
    finally { setSaving(false); setPendingModel(undefined) }
  }
  if (!catalog || catalog.models.length === 0) return null
  return <div className="session-execution-controls" aria-label="Conversation model controls">
    <label className="session-model-control"><span>Model</span><select aria-label="Conversation model" disabled={saving} value={model ?? ''} onChange={(event) => {
      const next = event.target.value || null
      if (next !== model) setPendingModel(next)
    }}><option value="">Provider default</option>{catalog.models.map((item) => <option key={item.id} value={item.id}>{item.displayName}{item.isDefault ? ' · Default' : ''}</option>)}</select></label>
    {efforts.length > 0 && <label className="session-effort-control"><span>Effort <b>{thinking ?? selectedModel?.defaultThinking ?? 'Provider default'}</b></span><input aria-label="Conversation effort" type="range" min={-1} max={efforts.length - 1} step={1} value={thinking ? Math.max(0, efforts.indexOf(thinking)) : -1} disabled={saving} onChange={(event) => { const index = Number(event.target.value); void save(model ?? null, index < 0 ? null : efforts[index] ?? null) }} /><span className="session-effort-ticks" aria-hidden="true"><i>Default</i>{efforts.map((item) => <i key={item}>{item}</i>)}</span></label>}
    {pendingModel !== undefined && <ConfirmDialog title="Change this conversation's model?" body="The provider may start a new context. Responses can change in quality and speed. Your saved messages stay in Bloblex." confirmLabel="Change model" cancelLabel="Keep current model" confirmDisabled={saving} onConfirm={() => void save(pendingModel, pendingModel === model ? thinking ?? null : null, true)} onCancel={() => setPendingModel(undefined)} />}
  </div>
}
