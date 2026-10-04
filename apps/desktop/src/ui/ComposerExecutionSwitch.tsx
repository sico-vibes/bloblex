import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Cpu } from 'lucide-react'
import type { Agent } from '../types'
import { rpc } from '../tauri'
import {
  capabilityState, parseCapabilities, parseModelCatalog, selectionAfterModelChange, sendGateFor,
  type ModelCatalog, type RuntimeCapabilities,
} from '../executionContract'

export function ComposerExecutionSwitch({ agent, onAgentUpdated, onError }: { agent: Agent; onAgentUpdated: (agent: Agent) => void; onError: (reason: unknown) => void }) {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities | null>(null)
  const [loading, setLoading] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeMenu = (restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const update = async (field: 'model' | 'thinking', value: string | null) => {
    closeMenu()
    try {
      const params: Record<string, unknown> = { agentId: agent.id, [field]: value }
      if (field === 'model') {
        const next = selectionAfterModelChange(value, catalog, false)
        const gates = sendGateFor(capabilities, false)
        if (gates.thinking) params.thinking = next.thinking
        if (gates.serviceTier) params.serviceTier = next.serviceTier
      }
      const result = await rpc<{ agent?: Agent }>('agent.update', params)
      if (result.agent?.id) onAgentUpdated(result.agent)
    } catch (reason) { onError(reason) }
  }
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([rpc('runtime.models', { runtimeId: agent.runtimeId }), rpc('runtime.capabilities', { runtimeId: agent.runtimeId, agentId: agent.id })]).then(([models, caps]) => {
      if (!cancelled) { setCatalog(parseModelCatalog(models)); setCapabilities(parseCapabilities(caps)); setLoading(false) }
    }).catch(() => { if (!cancelled) { setCatalog(null); setCapabilities(null); setLoading(false) } })
    return () => { cancelled = true }
  }, [agent.runtimeId, agent.id])
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus())
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) closeMenu(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('pointerdown', onPointerDown) }
  }, [open])
  const modelEnabled = capabilityState(capabilities?.settings.model ?? null) === 'supported'
  const thinkingEnabled = capabilityState(capabilities?.settings.thinking ?? null) === 'supported'
  const selected = useMemo(() => catalog?.models.find((model) => model.id === agent.model) ?? (!agent.model ? catalog?.models.find((model) => model.isDefault) ?? null : null), [catalog, agent.model])
  const choices = selected?.supportedThinking ?? []
  if (loading || (!modelEnabled && !thinkingEnabled)) return null
  const modelLabel = catalog?.models.find((model) => model.id === agent.model)?.displayName ?? (agent.model || 'Default model')
  return <div ref={rootRef} className="composer-execution-wrap" onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); closeMenu() } }}>
    <button ref={triggerRef} type="button" className="composer-execution-pill" aria-label={`Model and thinking: ${modelLabel}${agent.thinking ? `, ${agent.thinking}` : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Cpu size={13} /><span>{modelLabel}{agent.thinking ? ` · ${agent.thinking}` : ''}</span><ChevronDown size={12} /></button>
    {open && <div ref={menuRef} className="menu-surface composer-execution-menu" role="menu" aria-label="Model and thinking">
      {modelEnabled && <><div className="select-group-label">Model</div><button type="button" role="menuitemradio" aria-checked={!agent.model} className="menu-item" onClick={() => void update('model', null)}>Default model</button>{(catalog?.models ?? []).map((model, index, all) => <span key={model.id}>{model.group && model.group !== all[index - 1]?.group && <div className="select-group-label">{model.group}</div>}<button type="button" role="menuitemradio" aria-checked={agent.model === model.id} className="menu-item" onClick={() => void update('model', model.id)}>{model.displayName}{model.isDefault ? <small className="menu-item-trail">Default</small> : null}</button></span>)}</>}
      {thinkingEnabled && choices.length > 0 && <><span className="menu-separator" /><div className="select-group-label">Thinking</div><button type="button" role="menuitemradio" aria-checked={!agent.thinking} className="menu-item" onClick={() => void update('thinking', null)}>Default</button>{choices.map((level) => <button type="button" role="menuitemradio" aria-checked={agent.thinking === level} className="menu-item" key={level} onClick={() => void update('thinking', level)}>{level}</button>)}</>}
    </div>}
  </div>
}
