import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Check, ChevronDown, Flame, Gauge, LoaderCircle, Search, Signal, SignalHigh, SignalLow, SignalMedium, SignalZero, Zap, type LucideIcon } from 'lucide-react'
import type { Agent, Session, SessionModelLock } from '../types'
import { rpc } from '../tauri'
import { parseModelCatalog, type CatalogModel, type ModelCatalog, type ServiceTierOption } from '../executionContract'
import { ConfirmDialog } from './BlobPage'
import { useCachedRpc } from './catalogCache'
import { moveMenuFocus, usePopoverDismiss } from './ComposerControls'
import { ProviderLogo, providerBrand } from './providerBrand'
import { positionFromPointer, SessionEffortMeter, type EffortMeterStyle } from './SessionEffortMeter'
import { Tip } from './Tip'
import { labelizeEffort, effortIconName, type EffortIconName } from './effortLabels'
import { concreteModelForSelection } from './modelPreferences'
import { organizeModels, presentedModelName } from './modelPresentation'
import { Skeleton } from './Skeleton'
export { labelizeEffort } from './effortLabels'

type Lock = SessionModelLock
type PendingModel = { sessionId: string; model: string | null }
type EffortDraft = { sessionId: string; model: string | null; value: string | null }

/** The label and greying reason while the conversation has no model yet. */
export const MODEL_FIRST_REASON = 'Available after you pick a model'
export const PICK_MODEL_LABEL = 'Pick a model'

export function SessionExecutionControls({ session, agent, onSessionUpdated, onError }: {
  session: Session
  agent: Agent
  onSessionUpdated: (session: Session) => void
  onError: (reason: unknown) => void
}) {
  const [pendingModel, setPendingModel] = useState<PendingModel | null>(null)
  const [effortDraft, setEffortDraft] = useState<EffortDraft | null>(null)
  const [savingSessionIds, setSavingSessionIds] = useState<Set<string>>(() => new Set())
  const savingRef = useRef(new Set<string>())
  const sessionGeneration = useRef(0)
  const currentSessionId = useRef(session.id)
  currentSessionId.current = session.id
  const mounted = useRef(false)
  const rawSessionLock = (session.modelLock && typeof session.modelLock === 'object' ? session.modelLock : {}) as Lock
  const model = rawSessionLock.model === undefined ? agent.model : rawSessionLock.model
  const thinking = rawSessionLock.thinking === undefined ? agent.thinking : rawSessionLock.thinking
  const serviceTier = rawSessionLock.serviceTier === undefined ? agent.serviceTier : rawSessionLock.serviceTier
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  // The catalog comes from the shared cache: the runtime-wide list (warmed at
  // boot) shows at once, and this conversation's own list replaces it when it
  // arrives. A model or workflows change refreshes it in the background.
  const modelsQuery = useCachedRpc('runtime.models', { runtimeId: session.runtimeId, sessionId: session.id }, { fallback: { runtimeId: session.runtimeId }, revalidate: [model, rawSessionLock.enableWorkflows] })
  const catalog = useMemo<ModelCatalog | null>(() => modelsQuery.value === undefined ? null : parseModelCatalog(modelsQuery.value), [modelsQuery.value])
  const catalogUnavailable = (modelsQuery.value === undefined && !!modelsQuery.error) || (modelsQuery.value !== undefined && (!catalog || catalog.models.length === 0))

  // When the daemon says effort cannot be chosen (this model has no levels, or
  // the runtime does not allow it) the pill is shown greyed out with the reason
  // instead of failing on use. The answer is per model for OpenCode.
  const capsQuery = useCachedRpc<{ settings?: { thinking?: { supported?: boolean; enabled?: boolean; reason?: string } } }>('runtime.capabilities', { runtimeId: session.runtimeId, sessionId: session.id, ...(model ? { model } : {}) }, { fallback: { runtimeId: session.runtimeId } })
  const thinkingGate = capsQuery.value?.settings?.thinking
  const thinkingLocked: 'unsupported' | 'gated' | 'no-levels' | null = !thinkingGate ? null
    : thinkingGate.supported === false ? (thinkingGate.reason === 'model_has_no_effort_levels' ? 'no-levels' : 'unsupported')
      : thinkingGate.enabled === false ? 'gated' : null

  useEffect(() => {
    sessionGeneration.current += 1
    setPendingModel(null)
    setEffortDraft(null)
  }, [session.id])

  const selectedModel = useMemo(() => catalog ? concreteModelForSelection(catalog.provider, catalog.models, model) : null, [catalog, model])
  const efforts = selectedModel?.supportedThinking ?? []
  const activeDraft = effortDraft?.sessionId === session.id && effortDraft.model === model ? effortDraft.value : undefined
  const saving = savingSessionIds.has(session.id)
  const sessionBusy = ['starting', 'working', 'cancelling', 'waiting_permission'].includes(String(session.state ?? '').toLowerCase())
  const controlsDisabled = saving || sessionBusy

  const save = async (sessionId: string, nextModel: string | null, nextThinking: string | null, confirmModelChange = false): Promise<boolean> => {
    if (savingRef.current.has(sessionId)) return false
    savingRef.current.add(sessionId)
    const generation = sessionGeneration.current
    setSavingSessionIds((current) => new Set(current).add(sessionId))
    try {
      const result = await rpc<{ session?: Session }>('session.model.update', {
        sessionId, model: nextModel, thinking: nextThinking, confirmModelChange,
      })
      const current = currentSessionId.current === sessionId && sessionGeneration.current === generation && result.session?.id === sessionId
      if (current && mounted.current) onSessionUpdated(result.session!)
      return current
    } catch (reason) {
      if (mounted.current && currentSessionId.current === sessionId && sessionGeneration.current === generation) onError(reason)
      return false
    } finally {
      savingRef.current.delete(sessionId)
      if (mounted.current) setSavingSessionIds((current) => { const next = new Set(current); next.delete(sessionId); return next })
      setPendingModel((current) => current?.sessionId === sessionId && currentSessionId.current === sessionId && sessionGeneration.current === generation ? null : current)
    }
  }

  const requestEffort = async (next: string | null) => {
    setEffortDraft(null)
    if (next === thinking) return true
    return save(session.id, model ?? null, next, false)
  }
  const providerStyle = resolveProviderStyle(catalog?.provider ?? '', selectedModel?.providerId, selectedModel?.id ?? model, selectedModel?.displayName)
  const pendingForSession = pendingModel?.sessionId === session.id ? pendingModel : null
  const catalogProvider = catalog?.provider ?? ''
  const modelLabel = model ? presentedModelName(catalogProvider, selectedModel ?? { id: model, displayName: model }) : PICK_MODEL_LABEL
  const modelAriaLabel = modelLabel
  const fastTier = fastTierFor(selectedModel)
  const fastOn = !!fastTier && serviceTier === fastTier.id
  const setFast = async (enabled: boolean) => {
    if (!fastTier || savingRef.current.has(session.id)) return
    const sessionId = session.id
    savingRef.current.add(sessionId)
    setSavingSessionIds((current) => new Set(current).add(sessionId))
    try {
      const result = await rpc<{ session?: Session }>('session.model.update', { sessionId, serviceTier: enabled ? fastTier.id : null })
      if (mounted.current && currentSessionId.current === sessionId && result.session?.id === sessionId) onSessionUpdated(result.session)
    } catch (reason) { if (mounted.current && currentSessionId.current === sessionId) onError(reason) } finally {
      savingRef.current.delete(sessionId)
      if (mounted.current) setSavingSessionIds((current) => { const next = new Set(current); next.delete(sessionId); return next })
    }
  }

  return <div className="session-execution-controls" aria-label="Conversation model controls">
    {catalog && catalog.models.length > 0
      ? <ModelMenu provider={catalog.provider} models={catalog.models} model={model ?? null} label={modelLabel} ariaLabel={modelAriaLabel} fastTier={fastTier} fastOn={fastOn} disabled={sessionBusy} saving={saving} onSelect={(next) => {
        if (next !== model) { setEffortDraft(null); setPendingModel({ sessionId:session.id, model:next }) }
      }} onFast={(enabled) => void setFast(enabled)} />
      : catalogUnavailable
        ? <button type="button" className="composer-pill model-pill unavailable" aria-label={`Conversation model, ${modelLabel}; model catalog unavailable`} title="Model choices are unavailable until the runtime reports a catalog." disabled><span>{modelLabel}</span></button>
        : <span className="model-pill-loading" role="status" aria-busy="true" aria-label="Loading models"><Skeleton variant="pill" /><span className="sr-only">Loading models…</span></span>}
    <EffortControl
      provider={catalog?.provider ?? ''}
      key={`${session.id}:${model ?? 'unselected'}:${pendingForSession?.model ?? 'no-pending-model'}`}
      providerStyle={providerStyle}
      modelName={modelLabel}
      efforts={efforts}
      defaultThinking={selectedModel?.defaultThinking ?? null}
      unavailableReason={catalogUnavailable ? 'Runtime model capabilities are unavailable. Bitbots cannot verify or change effort levels without a validated catalog.' : selectedModel ? null : catalog ? 'The selected model is not in the validated runtime catalog. Bitbots cannot verify selectable effort levels.' : 'Runtime model capabilities are still unavailable.'}
      lockedReason={!model ? MODEL_FIRST_REASON : thinkingLocked === 'no-levels' ? `${selectedModel?.displayName ?? 'This model'} has no effort levels, so it always runs at its own default.` : thinkingLocked ? `${providerBrand(catalog?.provider ?? "").name || "This runtime"} doesn't let Bitbots pick an effort level yet, so it uses the model's own default.` : null}
      workflowEnabled={rawSessionLock.enableWorkflows === true}
      value={thinking}
      draftValue={activeDraft}
      disabled={controlsDisabled}
      onPreview={(value) => setEffortDraft({ sessionId:session.id, model:model ?? null, value })}
      onCancel={() => setEffortDraft(null)}
      onCommit={requestEffort}
    />
    {pendingForSession && <ConfirmDialog title="Change this conversation's model?" body="Switching models mid-conversation can significantly degrade performance and continuity. The provider may reset its context. Your saved messages stay in Bitbots." confirmLabel="Change model" cancelLabel="Keep current model" confirmDisabled={controlsDisabled} onConfirm={() => { void save(session.id, pendingForSession.model, pendingForSession.model === model ? thinking ?? null : null, true) }} onCancel={() => setPendingModel(null)} />}
  </div>
}

function EffortControl({ provider, providerStyle, modelName, efforts, defaultThinking, unavailableReason, lockedReason, workflowEnabled, value, draftValue, disabled, onPreview, onCancel, onCommit }: {
  provider: string
  providerStyle: EffortMeterStyle
  modelName: string
  efforts: string[]
  defaultThinking: string | null
  unavailableReason: string | null
  /** Set when the runtime cannot change effort at all: the pill is greyed out with this tooltip. */
  lockedReason?: string | null
  workflowEnabled: boolean
  value: string | null | undefined
  draftValue: string | null | undefined
  disabled: boolean
  onPreview: (value: string | null) => void
  onCancel: () => void
  onCommit: (value: string | null) => boolean | Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(0)
  /** 'drag': the knob follows the pointer exactly. 'settle': it glides to the released stop. */
  const [mode, setMode] = useState<'rest' | 'drag' | 'settle'>('rest')
  const rootRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<{ kind: 'pointer' | 'keyboard'; pointerId?: number; left?: number; width?: number } | null>(null)
  const positionRef = useRef(0)
  const startIndex = useRef(-1)
  const settleTimer = useRef<number | null>(null)
  const currentValueIndex = value == null ? -1 : efforts.indexOf(value)
  const draftIndex = draftValue === undefined ? undefined : draftValue === null ? -1 : efforts.indexOf(draftValue)
  const visibleIndex = draftIndex ?? currentValueIndex
  // With no saved effort the knob rests on the provider's default level.
  const defaultIndex = defaultThinking ? efforts.indexOf(defaultThinking) : -1
  const restIndex = currentValueIndex >= 0 ? currentValueIndex : Math.max(0, defaultIndex)
  const displayedPosition = mode === 'rest' ? (visibleIndex < 0 ? restIndex : visibleIndex) : position
  const stop = Math.max(0, Math.min(efforts.length - 1, Math.round(displayedPosition)))
  const unlistedValue = value && !efforts.includes(value) ? value : null
  const visibleLabel = visibleIndex >= 0 && efforts[visibleIndex] ? labelizeEffort(efforts[visibleIndex], provider) : unlistedValue ? `Saved: ${labelizeEffort(unlistedValue, provider)}` : defaultThinking ? `Model default · ${labelizeEffort(defaultThinking, provider)}` : 'Model default'
  const lastIsUltra = isUltraEffort(efforts[efforts.length - 1])
  const atTop = efforts.length > 1 && stop === efforts.length - 1 && (visibleIndex >= 0 || mode !== 'rest')

  const clearSettle = () => { if (settleTimer.current !== null) window.clearTimeout(settleTimer.current); settleTimer.current = null }
  useEffect(() => () => { clearSettle(); gesture.current = null }, [])
  useEffect(() => {
    if (gesture.current) return
    positionRef.current = restIndex
    setPosition(restIndex)
  }, [currentValueIndex, restIndex, efforts.length])

  const cancelGesture = () => {
    clearSettle()
    gesture.current = null
    positionRef.current = startIndex.current < 0 ? restIndex : startIndex.current
    setPosition(positionRef.current)
    setMode('rest')
    onCancel()
  }
  const close = (restoreFocus = false) => {
    if (gesture.current) cancelGesture()
    setOpen(false)
    if (restoreFocus) rootRef.current?.querySelector<HTMLButtonElement>('.session-effort-trigger')?.focus()
  }
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: globalThis.PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) closeRef.current() }
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(true) } }
    const onWindowBlur = () => closeRef.current()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onWindowBlur)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true); document.removeEventListener('keydown', onKeyDown, true); window.removeEventListener('blur', onWindowBlur) }
  }, [open])

  const move = (next: number) => {
    const safe = Math.max(0, Math.min(Math.max(0, efforts.length - 1), next))
    positionRef.current = safe
    setPosition(safe)
    onPreview(efforts[Math.round(safe)] ?? null)
  }
  /** Saves the stop and lets the knob glide there; the save happens once, on release. */
  const commit = (index: number) => {
    const target = Math.max(0, Math.min(efforts.length - 1, index))
    positionRef.current = target
    setPosition(target)
    clearSettle()
    setMode('settle')
    settleTimer.current = window.setTimeout(() => { settleTimer.current = null; setMode('rest') }, 260)
    void onCommit(efforts[target] ?? null)
  }
  const pointerPosition = (clientX: number) => {
    const g = gesture.current
    if (!g || g.left === undefined || g.width === undefined) return positionRef.current
    return positionFromPointer(clientX, g.left, g.width, efforts.length, providerStyle)
  }
  const beginPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || (event.button !== undefined && event.button !== 0)) return
    event.preventDefault()
    clearSettle()
    const bounds = event.currentTarget.getBoundingClientRect()
    gesture.current = { kind: 'pointer', pointerId: event.pointerId, left: bounds.left, width: bounds.width }
    startIndex.current = currentValueIndex
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* capture may be unavailable */ }
    event.currentTarget.focus({ preventScroll: true })
    setMode('drag')
    move(pointerPosition(event.clientX))
  }
  const movePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gesture.current?.kind !== 'pointer' || gesture.current.pointerId !== event.pointerId) return
    move(pointerPosition(event.clientX))
  }
  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gesture.current?.kind !== 'pointer' || gesture.current.pointerId !== event.pointerId) return
    // A release reported outside the window can carry no coordinates; keep the last real position.
    if (event.clientX !== 0 || event.clientY !== 0) move(pointerPosition(event.clientX))
    gesture.current = null
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* already released */ }
    commit(Math.round(positionRef.current))
  }
  const abandonPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gesture.current?.kind === 'pointer' && gesture.current.pointerId === event.pointerId) cancelGesture()
  }
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || !keys.includes(event.key)) return
    event.preventDefault()
    if (gesture.current?.kind !== 'keyboard') {
      clearSettle()
      gesture.current = { kind: 'keyboard' }
      startIndex.current = currentValueIndex
      positionRef.current = restIndex
      setMode('drag')
    }
    const current = Math.round(positionRef.current)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? efforts.length - 1 : current + (['ArrowRight', 'ArrowUp', 'PageUp'].includes(event.key) ? 1 : -1)
    move(next)
  }
  const handleKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (gesture.current?.kind !== 'keyboard' || !keys.includes(event.key)) return
    event.preventDefault()
    gesture.current = null
    commit(Math.round(positionRef.current))
  }
  const choose = (next: string | null) => { clearSettle(); setMode('rest'); onPreview(next); void onCommit(next); setOpen(false) }
  const toggle = () => {
    if (disabled || lockedReason) return
    if (open) close()
    else { clearSettle(); setMode('rest'); setPosition(restIndex); positionRef.current = restIndex; setOpen(true) }
  }

  const triggerLabel = lockedReason === MODEL_FIRST_REASON ? 'Effort'
    : value && efforts.includes(value) ? labelizeEffort(value, provider) : unlistedValue ? labelizeEffort(unlistedValue, provider) : defaultThinking ? labelizeEffort(defaultThinking, provider) : 'Model default'
  const savedTop = efforts.length > 1 && value === efforts[efforts.length - 1]
  const trigger = <button type="button" className={`composer-pill session-effort-trigger ${savedTop ? 'highest' : ''} ${isTopTierEffort(value) ? 'max-tier' : ''} ${lockedReason ? 'locked' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-label={lockedReason ? `Effort: ${triggerLabel}. ${lockedReason}` : `Effort: ${triggerLabel}`} aria-disabled={lockedReason ? true : undefined} disabled={disabled && !lockedReason} onClick={toggle}>
    <EffortIcon value={lockedReason === MODEL_FIRST_REASON ? null : value && efforts.includes(value) ? value : unlistedValue ?? defaultThinking ?? null} />
    <span>{triggerLabel}</span>
    <ChevronDown size={12} aria-hidden="true" className="composer-pill-chevron" />
  </button>
  return <div ref={rootRef} className={`session-effort-control composer-popover-anchor ${providerStyle}`}>
    {lockedReason ? <Tip text={lockedReason}>{trigger}</Tip> : trigger}
    {open && <div className={`session-effort-popover ${providerStyle} ${lastIsUltra ? 'has-ultra' : ''}`} role="dialog" aria-label={`Effort for ${modelName}`}>
      <div className="session-effort-popover-heading">
        <span className="session-effort-title">Effort</span>
        <span className={`session-effort-value ${isTopTierEffort(visibleIndex >= 0 ? efforts[visibleIndex] : null) ? 'ultra' : ''}`} aria-live="polite"><span key={visibleLabel} className="session-effort-value-in">{visibleLabel}</span></span>
        {defaultThinking && efforts.length > 0 && !visibleLabel.startsWith('Model default') && <span className="session-effort-default-label">Model default · {labelizeEffort(defaultThinking, provider)}</span>}
      </div>
      {efforts.length > 0 ? <>
        <div className="session-effort-meter-frame">
          <div className="session-effort-caption"><span>Faster</span><span>Smarter</span></div>
          <SessionEffortMeter trackRef={trackRef} style={providerStyle} count={efforts.length} position={displayedPosition} recommendedIndex={-1} top={atTop} dragging={mode === 'drag'} settling={mode === 'settle'} valueText={mode === 'rest' && visibleIndex < 0 ? visibleLabel : labelizeEffort(efforts[stop] ?? '', provider)} disabled={disabled} onPointerDown={beginPointer} onPointerMove={movePointer} onPointerUp={finishPointer} onPointerCancel={abandonPointer} onLostPointerCapture={abandonPointer} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp} />
          <div className="session-effort-labels" role="group" aria-label="Effort levels">{efforts.map((effort, index) => <button type="button" key={`${effort}-${index}`} className={`${visibleIndex === index ? 'selected' : ''} ${isTopTierEffort(effort) ? 'ultra' : ''}`} aria-pressed={visibleIndex === index} disabled={disabled} onClick={() => choose(effort)}><EffortIcon value={effort} size={12} /><span>{labelizeEffort(effort, provider)}</span></button>)}</div>
        </div>
        {provider.toLowerCase() === 'claude' && !efforts.includes('ultracode') && <p className="session-effort-note">{workflowEnabled ? 'Claude Code did not report Ultracode for this model. The model needs catalog-reported Extra high support; managed policy may also keep it unavailable.' : 'Ultracode needs a model with catalog-reported Extra high and Claude dynamic workflows. Bitbots did not enable workflows for this conversation; its setting applies to new conversations. Claude config or managed policy may still provide it. Max remains separate.'}</p>}
        {lastIsUltra && atTop && <p className="session-effort-note">{providerStyle === 'claude' ? 'Claude Code reported Ultracode for this model. It runs at Extra high with dynamic workflows enabled for this session. Standard Max remains separate.' : 'Ultra is a separate catalog effort, distinct from Max.'}</p>}
        {unlistedValue && <div className="session-effort-recovery" role="alert"><span>Saved {labelizeEffort(unlistedValue, provider)} is not supported by {modelName}.</span><button type="button" className="ghost-button small" disabled={disabled} onClick={() => choose(defaultThinking ?? null)}>{defaultThinking ? `Use model default · ${labelizeEffort(defaultThinking, provider)}` : 'Reset to model default'}</button></div>}
      </> : <div className="session-effort-unavailable"><strong>{unlistedValue ? `Saved selection: ${labelizeEffort(unlistedValue, provider)}` : 'Model default'}</strong><p>{unavailableReason ?? 'This model does not report selectable effort levels. Bitbots cannot change effort for it.'}</p>{unlistedValue && <button type="button" className="ghost-button small" disabled={disabled} onClick={() => choose(defaultThinking ?? null)}>Reset to model default</button>}{defaultThinking && <p>Model default: {labelizeEffort(defaultThinking, provider)}.</p>}</div>}
    </div>}
  </div>
}

const EFFORT_ICONS: Record<EffortIconName, LucideIcon> = { 'signal-zero': SignalZero, 'signal-low': SignalLow, 'signal-medium': SignalMedium, 'signal-high': SignalHigh, signal: Signal, flame: Flame, gauge: Gauge }

/** The bars icon beside an effort level. */
export function EffortIcon({ value, size = 13 }: { value: string | null | undefined; size?: number }) {
  const Icon = EFFORT_ICONS[effortIconName(value)]
  return <Icon size={size} aria-hidden="true" className="effort-icon" />
}

function isUltraEffort(value: string | null | undefined) { return value === 'ultra' || value === 'ultracode' }
/** Max and the Ultra levels share one highlight, so Ultracode reads as the same tier as Max. */
function isTopTierEffort(value: string | null | undefined) { return value === 'max' || isUltraEffort(value) }

/** The catalog tier that means "fast": Claude reports `fast`, Codex names its priority tier Fast. */
export function fastTierFor(model: CatalogModel | null | undefined): ServiceTierOption | null {
  return model?.serviceTiers.find((tier) => /\bfast\b|priority/i.test(`${tier.id} ${tier.name}`)) ?? null
}

/** Compact pill label: drop a leading provider family word ("Claude Opus 5.5" -> "Opus 5.5"). */
export function shortModelName(name: string) {
  return name.replace(/^claude\s+(?=\S)/i, '')
}

function ModelMenu({ provider, models, model, label, ariaLabel, fastTier, fastOn, disabled, saving, onSelect, onFast }: {
  provider: string
  models: CatalogModel[]
  model: string | null
  label: string
  ariaLabel: string
  fastTier: ServiceTierOption | null
  fastOn: boolean
  disabled: boolean
  saving: boolean
  onSelect: (model: string) => void
  onFast: (enabled: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const close = (restoreFocus: boolean) => { setOpen(false); setQuery(''); if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus()) }
  usePopoverDismiss(open, rootRef, close)
  const brand = providerBrand(provider).name
  const ordered = useMemo(() => organizeModels(provider, models), [provider, models])
  // Long catalogs (OpenCode lists dozens) get a filter; short ones keep the plain list.
  const searchable = ordered.length > MODEL_SEARCH_THRESHOLD
  const visible = useMemo(() => filterModels(provider, ordered, query), [provider, ordered, query])
  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => {
      if (searchable) { searchRef.current?.focus(); return }
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
      ;(checked ?? menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus()
    })
  }, [open, searchable])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  const choose = (next: string) => { close(true); onSelect(next) }
  return <div ref={rootRef} className="composer-popover-anchor">
    <button ref={triggerRef} type="button" className={`composer-pill model-pill ${fastOn ? 'fast' : ''}`} title="Choose which model this conversation uses" aria-haspopup="menu" aria-expanded={open} aria-label={`Conversation model: ${ariaLabel}${fastOn ? ', fast mode on' : ''}`} disabled={disabled || (saving && !open)} onClick={() => setOpen((value) => !value)}>
      {saving ? <LoaderCircle size={13} className="spinning" aria-hidden="true" /> : fastOn ? <Zap size={13} aria-hidden="true" className="model-pill-fast" /> : null}
      <ProviderLogo provider={provider} size={14} />
      <i className="model-pill-divider" aria-hidden="true" />
      <span>{label}</span>
      <ChevronDown size={12} aria-hidden="true" className="composer-pill-chevron" />
    </button>
    {open && <div ref={menuRef} className="composer-menu model-menu align-right" role="menu" aria-label="Conversation model" onKeyDown={(event) => { if (moveMenuFocus(menuRef.current, event.key)) event.preventDefault() }}>
      {searchable
        ? <label className="composer-menu-search"><Search size={13} aria-hidden="true" /><input ref={searchRef} type="text" value={query} placeholder={`Search ${brand} models`} aria-label="Search models" spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); const first = visible[0]; if (first && !saving) choose(first.id); return }
              if (event.key === 'ArrowDown') { event.preventDefault(); menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus() }
            }} /></label>
        : <div className="composer-menu-heading">{brand} models</div>}
      <div className="composer-menu-scroll">
        {!model && <p className="composer-menu-note" role="status">Choose an explicit model for this conversation.</p>}
        {model && !models.some((item) => item.id === model) && <p className="composer-menu-note" role="status">Saved model {model} is not currently offered. Choose an available model to continue.</p>}
        {visible.length === 0 && <p className="composer-menu-note" role="status">No models match “{query.trim()}”.</p>}
        {visible.map((item, index) => <div key={item.id} role="none">
          {item.group && item.group !== visible[index - 1]?.group && <div className="composer-menu-group" role="presentation">{item.group}</div>}
          <button type="button" role="menuitemradio" aria-checked={model === item.id} className="composer-menu-item" data-value={item.id} disabled={saving} onClick={() => choose(item.id)}>
            <span className="composer-menu-text"><strong>{presentedModelName(provider, item)}</strong></span>
            {model === item.id && <Check size={14} className="composer-menu-check" aria-hidden="true" />}
          </button>
        </div>)}
      </div>
      {fastTier && <>
        <div className="composer-menu-separator" role="separator" />
        <button type="button" role="menuitemcheckbox" aria-checked={fastOn} className="composer-menu-item toggle-row" disabled={saving} onClick={() => onFast(!fastOn)}>
          <span className="composer-menu-icon"><Zap size={15} aria-hidden="true" /></span>
          <span className="composer-menu-text"><strong>Fast mode</strong><small>Quicker replies; uses your plan faster</small></span>
          <span className={`toggle ${fastOn ? 'on' : ''}`} aria-hidden="true"><i /></span>
        </button>
      </>}
    </div>}
  </div>
}

/** Model lists longer than this get a search field. */
export const MODEL_SEARCH_THRESHOLD = 8

/** Models whose name, id or group contains every word of the query, in catalog order. */
export function filterModels(provider: string, models: readonly CatalogModel[], query: string): CatalogModel[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...models]
  return models.filter((item) => {
    const haystack = `${presentedModelName(provider, item)} ${item.id} ${item.group ?? ''}`.toLocaleLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

function resolveProviderStyle(runtimeProvider: string, modelProvider: string | null | undefined, modelId: string | null | undefined, displayName?: string): EffortMeterStyle {
  const modelFamily = `${modelProvider ?? ''} ${modelId ?? ''} ${displayName ?? ''}`.toLowerCase()
  if (/claude|anthropic/.test(modelFamily) || runtimeProvider.toLowerCase() === 'claude') return 'claude'
  if (/codex|openai|\bgpt\b/.test(modelFamily) || runtimeProvider.toLowerCase() === 'codex') return 'magnetic'
  return 'neutral'
}
