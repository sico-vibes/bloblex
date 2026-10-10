import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Check, ChevronDown, LoaderCircle, Zap } from 'lucide-react'
import type { Agent, Session, SessionModelLock } from '../types'
import { rpc } from '../tauri'
import { parseModelCatalog, type CatalogModel, type ModelCatalog, type ServiceTierOption } from '../executionContract'
import { ConfirmDialog } from './BlobPage'
import { moveMenuFocus, usePopoverDismiss } from './ComposerControls'
import { providerBrand } from './providerBrand'
import { SessionEffortMeter, type EffortMeterStyle } from './SessionEffortMeter'
import { applyClaudeMagnet, claudePointerVelocity, codexDragPosition, CLAUDE_SPRING } from './meterMotion'

type Lock = SessionModelLock
type PendingModel = { sessionId: string; model: string | null }
type EffortDraft = { sessionId: string; model: string | null; value: string | null }
type Sample = { time: number; value: number }

export function SessionExecutionControls({ session, agent, onSessionUpdated, onError }: {
  session: Session
  agent: Agent
  onSessionUpdated: (session: Session) => void
  onError: (reason: unknown) => void
}) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [catalogUnavailable, setCatalogUnavailable] = useState(false)
  const [pendingModel, setPendingModel] = useState<PendingModel | null>(null)
  const [effortDraft, setEffortDraft] = useState<EffortDraft | null>(null)
  const [savingSessionIds, setSavingSessionIds] = useState<Set<string>>(() => new Set())
  const savingRef = useRef(new Set<string>())
  const sessionGeneration = useRef(0)
  const currentSessionId = useRef(session.id)
  currentSessionId.current = session.id
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    let cancelled = false
    setCatalog(null)
    setCatalogUnavailable(false)
    void rpc('runtime.models', { runtimeId: session.runtimeId }).then((value) => {
      if (!cancelled) {
        const parsed = parseModelCatalog(value)
        setCatalog(parsed)
        setCatalogUnavailable(!parsed || parsed.models.length === 0)
      }
    }).catch(() => { if (!cancelled) { setCatalog(null); setCatalogUnavailable(true) } })
    return () => { cancelled = true }
  }, [session.runtimeId])

  useEffect(() => {
    sessionGeneration.current += 1
    setPendingModel(null)
    setEffortDraft(null)
  }, [session.id])

  const lock = (session.modelLock && typeof session.modelLock === 'object' ? session.modelLock : {}) as Lock
  const model = lock.model === undefined ? agent.model : lock.model
  const thinking = lock.thinking === undefined ? agent.thinking : lock.thinking
  const serviceTier = lock.serviceTier === undefined ? agent.serviceTier : lock.serviceTier
  // "Provider default" resolves to the catalog's default model for display and
  // advertised effort levels; the saved lock still stores null.
  const selectedModel = useMemo(() => catalog?.models.find((item) => item.id === model) ?? (!model ? catalog?.models.find((item) => item.isDefault) ?? null : null), [catalog, model])
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
  const modelLabel = selectedModel?.displayName ?? (model || 'Provider default')
  const modelAriaLabel = !model && selectedModel ? `Provider default (${selectedModel.displayName})` : modelLabel
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
      : <button type="button" className="composer-pill model-pill unavailable" aria-label={`Conversation model, ${modelLabel}; model catalog unavailable`} title="Model choices are unavailable until the runtime reports a validated catalog." disabled><span>{shortModelName(modelLabel)}</span></button>}
    <EffortControl
      key={`${session.id}:${model ?? 'provider-default'}:${pendingForSession?.model ?? 'no-pending-model'}`}
      providerStyle={providerStyle}
      modelName={selectedModel?.displayName ?? modelLabel}
      efforts={efforts}
      defaultThinking={selectedModel?.defaultThinking ?? null}
      unavailableReason={catalogUnavailable ? 'Runtime model capabilities are unavailable. Bloblex cannot verify or change effort levels without a validated catalog.' : selectedModel ? null : catalog ? 'The selected model is not in the validated runtime catalog. Bloblex cannot verify selectable effort levels.' : 'Runtime model capabilities are still unavailable.'}
      value={thinking}
      draftValue={activeDraft}
      disabled={controlsDisabled}
      onPreview={(value) => setEffortDraft({ sessionId:session.id, model:model ?? null, value })}
      onCancel={() => setEffortDraft(null)}
      onCommit={requestEffort}
    />
    {pendingForSession && <ConfirmDialog title="Change this conversation's model?" body="Switching models mid-conversation can significantly degrade performance and continuity. The provider may reset its context. Your saved messages stay in Bloblex." confirmLabel="Change model" cancelLabel="Keep current model" confirmDisabled={controlsDisabled} onConfirm={() => { void save(session.id, pendingForSession.model, pendingForSession.model === model ? thinking ?? null : null, true) }} onCancel={() => setPendingModel(null)} />}
  </div>
}

function EffortControl({ providerStyle, modelName, efforts, defaultThinking, unavailableReason, value, draftValue, disabled, onPreview, onCancel, onCommit }: {
  providerStyle: EffortMeterStyle
  modelName: string
  efforts: string[]
  defaultThinking: string | null
  unavailableReason: string | null
  value: string | null | undefined
  draftValue: string | null | undefined
  disabled: boolean
  onPreview: (value: string | null) => void
  onCancel: () => void
  onCommit: (value: string | null) => boolean | Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(0)
  const [snapping, setSnapping] = useState(false)
  const [burstKey, setBurstKey] = useState(0)
  const [labelSwap, setLabelSwap] = useState<{ from:string; to:string; forward:boolean } | null>(null)
  const previousLabel = useRef('')
  const labelTimer = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<{ kind:'pointer'|'keyboard'; pointerId?: number; key?: string } | null>(null)
  const positionRef = useRef(0)
  const samples = useRef<Sample[]>([])
  const dragGeometry = useRef<{ left:number; width:number } | null>(null)
  const springFrame = useRef<number | null>(null)
  const snapTimer = useRef<number | null>(null)
  const snapHandler = useRef<((event:TransitionEvent)=>void) | null>(null)
  const startIndex = useRef(-1)
  const committedDuringGesture = useRef(false)
  const cancelRef = useRef<() => void>(() => undefined)
  const currentValueIndex = value == null ? -1 : efforts.indexOf(value)
  const draftIndex = draftValue === undefined ? undefined : draftValue === null ? -1 : efforts.indexOf(draftValue)
  const visibleIndex = draftIndex ?? currentValueIndex
  // With no saved effort the knob rests on the provider's default level.
  const defaultIndex = defaultThinking ? efforts.indexOf(defaultThinking) : -1
  const restIndex = currentValueIndex >= 0 ? currentValueIndex : Math.max(0, defaultIndex)
  const displayedPosition = snapping || gesture.current ? position : (visibleIndex < 0 ? restIndex : visibleIndex)
  const selectedTierIndex = Math.max(0, Math.min(efforts.length - 1, Math.round(displayedPosition)))
  const selectedLabel = visibleIndex >= 0 && efforts[visibleIndex] ? labelizeEffort(efforts[visibleIndex]) : ''
  const unlistedValue = value && !efforts.includes(value) ? value : null
  const visibleLabel = visibleIndex >= 0 && efforts[visibleIndex] ? labelizeEffort(efforts[visibleIndex]) : unlistedValue ? `Saved selection: ${labelizeEffort(unlistedValue)}` : defaultThinking ? `${labelizeEffort(defaultThinking)} · default` : 'Provider default'
  const defaultLabel = defaultThinking ? `Provider default (${labelizeEffort(defaultThinking)})` : 'Provider default'
  const highest = efforts.length > 0 && selectedTierIndex === efforts.length - 1 && (visibleIndex >= 0 || snapping || gesture.current !== null)

  useEffect(() => {
    const previous = previousLabel.current
    previousLabel.current = visibleLabel
    if (!previous || previous === visibleLabel) return
    setLabelSwap({ from:previous, to:visibleLabel, forward:visibleIndex > (efforts.indexOf(value ?? '') ?? -1) })
    if (labelTimer.current !== null) window.clearTimeout(labelTimer.current)
    labelTimer.current = window.setTimeout(() => { labelTimer.current = null; setLabelSwap(null) }, providerStyle === 'claude' ? 200 : 130)
  }, [visibleLabel, providerStyle])

  const stopAnimations = () => {
    const snapKnob=rootRef.current?.querySelector<HTMLElement>('.session-effort-knob')
    if(snapHandler.current&&snapKnob){snapKnob.removeEventListener('transitionend',snapHandler.current);snapHandler.current=null}
    if (providerStyle === 'magnetic' && snapping) {
      const track = rootRef.current?.querySelector<HTMLElement>('.session-effort-track')
      const knob = track?.querySelector<HTMLElement>('.session-effort-knob')
      const width = track?.getBoundingClientRect().width ?? 0
      const fill=track?.querySelector<HTMLElement>('.session-effort-fill')
      const left = Number.parseFloat(knob ? getComputedStyle(knob).left : '')
      if (Number.isFinite(left) && width > 32) {
        const normalized = Math.max(0, Math.min(1, (left - 16) / (width - 32)))
        if(knob)knob.style.left=`${left}px`
        if(fill)fill.style.width=getComputedStyle(fill).width
        positionRef.current = normalized * Math.max(0, efforts.length - 1)
        setPosition(positionRef.current)
        requestAnimationFrame(()=>{if(fill)fill.style.removeProperty('width')})
      }
    }
    if (springFrame.current !== null) cancelAnimationFrame(springFrame.current)
    if (snapTimer.current !== null) window.clearTimeout(snapTimer.current)
    springFrame.current = null
    snapTimer.current = null
    setSnapping(false)
  }
  const cancelGesture = () => {
    stopAnimations()
    gesture.current = null
    dragGeometry.current = null
    committedDuringGesture.current = false
    positionRef.current = (startIndex.current < 0 ? restIndex : startIndex.current)
    setPosition(positionRef.current)
    samples.current = []
    onCancel()
  }
  cancelRef.current = cancelGesture

  const cancelCurrent = () => {
    if (gesture.current) cancelRef.current()
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) cancelCurrentRef.current()
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelCurrentRef.current(); rootRef.current?.querySelector<HTMLButtonElement>('.session-effort-trigger')?.focus() }
    }
    const onWindowBlur = () => cancelCurrentRef.current()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onWindowBlur)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true); document.removeEventListener('keydown', onKeyDown, true); window.removeEventListener('blur', onWindowBlur) }
  }, [open])

  const cancelCurrentRef = useRef(cancelCurrent)
  cancelCurrentRef.current = cancelCurrent
  useEffect(() => () => { stopAnimations(); gesture.current = null; if(labelTimer.current!==null)window.clearTimeout(labelTimer.current) }, [])
  useEffect(() => {
    if (gesture.current) return
    const next = restIndex
    positionRef.current = next
    setPosition(next)
  }, [currentValueIndex, restIndex, efforts.length])

  const announce = (nextPosition: number) => {
    const index = Math.round(Math.max(0, Math.min(Math.max(0, efforts.length - 1), nextPosition)))
    onPreview(index < 0 ? null : efforts[index] ?? null)
  }
  const applyPosition = (raw: number) => {
    const track=rootRef.current?.querySelector<HTMLElement>('.session-effort-track')
    track?.querySelector<HTMLElement>('.session-effort-fill')?.style.removeProperty('width')
    track?.querySelector<HTMLElement>('.session-effort-knob')?.style.removeProperty('left')
    const safe = Math.max(0, Math.min(Math.max(0, efforts.length - 1), raw))
    const next = providerStyle === 'claude' ? applyClaudeMagnet(safe) : safe
    positionRef.current = next
    setPosition(next)
    announce(next)
    const now = performance.now()
    samples.current = [...samples.current, { time:now, value:next }].filter((sample) => now - sample.time < 90).slice(-5)
  }
  const applyCodexPointer = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (providerStyle !== 'magnetic' || !dragGeometry.current) return
    const {left,width}=dragGeometry.current
    const normalized=codexDragPosition(event.clientX,left,width,width,32)
    if(normalized!==null)applyPosition(normalized*Math.max(0,efforts.length-1))
  }

  const commit = (index: number, animate: boolean, velocity = 0) => {
    if (committedDuringGesture.current) return
    committedDuringGesture.current = true
    const target = Math.max(0, Math.min(efforts.length - 1, index))
    const changed = target !== currentValueIndex
    const valueToSave = efforts[target] ?? null
    const result = onCommit(valueToSave)
    const settled = async () => {
      if (changed && target === efforts.length - 1 && providerStyle === 'magnetic' && await result) setBurstKey((key) => key + 1)
    }
    if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      positionRef.current = target
      setPosition(target)
      setSnapping(false)
      void settled()
      return
    }
    if (providerStyle === 'claude') {
      stopAnimations()
      setSnapping(true)
      let current = positionRef.current
      let speed = velocity
      let previous = performance.now()
      const step = (time: number) => {
        const dt = Math.min((time - previous) / 1000, 0.032)
        previous = time
        const acceleration = -CLAUDE_SPRING.stiffness * (current - target) - CLAUDE_SPRING.damping * speed
        speed += acceleration * dt
        current = Math.max(0, Math.min(efforts.length - 1, current + speed * dt))
        positionRef.current = current
        setPosition(current)
        if (Math.abs(current - target) < 0.001 && Math.abs(speed) < 0.01) {
          positionRef.current = target
          setPosition(target)
          springFrame.current = null
          setSnapping(false)
          void settled()
          return
        }
        springFrame.current = requestAnimationFrame(step)
      }
      springFrame.current = requestAnimationFrame(step)
    } else {
      setSnapping(true)
      positionRef.current = target
      setPosition(target)
      let finished=false
      const finish=()=>{if(finished)return;finished=true;if(snapTimer.current!==null)window.clearTimeout(snapTimer.current);snapTimer.current=null;const knob=rootRef.current?.querySelector<HTMLElement>('.session-effort-knob');if(snapHandler.current&&knob)knob.removeEventListener('transitionend',snapHandler.current);snapHandler.current=null;setSnapping(false);void settled()}
      const handler=(event:TransitionEvent)=>{if(event.propertyName==='left')finish()}
      const knob=rootRef.current?.querySelector<HTMLElement>('.session-effort-knob')
      snapHandler.current=handler
      knob?.addEventListener('transitionend',handler)
      snapTimer.current = window.setTimeout(finish, 460)
    }
  }

  const finishPointer = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (gesture.current?.kind !== 'pointer' || gesture.current.pointerId !== event.pointerId) return
    applyCodexPointer(event)
    const rounded = Math.round(positionRef.current)
    const samplesNow = samples.current
    const velocity = claudePointerVelocity(samplesNow)
    gesture.current = null
    dragGeometry.current = null
    commit(rounded, true, velocity)
  }

  const beginPointer = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (disabled || (event.button !== undefined && event.button !== 0)) return
    stopAnimations()
    gesture.current = { kind:'pointer', pointerId:event.pointerId }
    const bounds=event.currentTarget.parentElement?.getBoundingClientRect()
    dragGeometry.current=providerStyle==='magnetic'&&bounds?{left:bounds.left,width:bounds.width}:null
    committedDuringGesture.current = false
    startIndex.current = currentValueIndex
    const initial = providerStyle === 'magnetic' ? positionRef.current : restIndex
    positionRef.current = initial
    setPosition(initial)
    samples.current = [{ time:performance.now(), value:initial }]
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* capture may be unavailable */ }
    if(providerStyle==='magnetic')applyCodexPointer(event)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (disabled || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) return
    event.preventDefault()
    if (!gesture.current || gesture.current.kind !== 'keyboard') {
      stopAnimations()
      gesture.current = { kind:'keyboard', key:event.key }
      committedDuringGesture.current = false
      startIndex.current = currentValueIndex
      positionRef.current = restIndex
    } else gesture.current.key = event.key
    const current = Math.round(positionRef.current)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? efforts.length - 1 : current + (['ArrowRight','ArrowUp','PageUp'].includes(event.key) ? 1 : -1)
    applyPosition(Math.max(0, Math.min(efforts.length - 1, next)))
  }
  const handleKeyUp = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (gesture.current?.kind !== 'keyboard' || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) return
    event.preventDefault()
    gesture.current = null
    commit(Math.round(positionRef.current), false)
  }
  const toggle = () => {
    if (disabled) return
    if (open) cancelCurrent()
    else { stopAnimations(); setPosition(restIndex); setOpen(true) }
  }

  const labels = efforts.map(labelizeEffort)
  const triggerLabel = value && efforts.includes(value) ? labelizeEffort(value) : unlistedValue ? labelizeEffort(unlistedValue) : defaultThinking ? labelizeEffort(defaultThinking) : 'Default'
  const highestSaved = efforts.length > 1 && value === efforts[efforts.length - 1]
  return <div ref={rootRef} className={`session-effort-control composer-popover-anchor ${providerStyle}`}>
    <button type="button" className={`composer-pill session-effort-trigger ${highestSaved ? 'highest' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-label={`Effort: ${triggerLabel}`} disabled={disabled} onClick={toggle}>
      <span>{triggerLabel}</span>
    </button>
    {open && <div className={`session-effort-popover ${providerStyle}`} role="dialog" aria-label={`Effort for ${modelName}`}>
      <div className="session-effort-popover-heading"><span className="session-effort-title">Effort</span><span className="session-effort-value" aria-live="polite">{providerStyle==='claude'&&labelSwap?.to===visibleLabel&&<span className={`session-effort-value-out ${labelSwap.forward?'forward':'backward'}`} aria-hidden="true">{labelSwap.from}</span>}<span key={visibleLabel} className={`session-effort-value-in ${labelSwap?.forward?'forward':'backward'}`}>{visibleLabel}</span></span></div>
      {efforts.length > 0 ? <>
        <div className="session-effort-meter-frame">
          <div className="session-effort-caption"><span>Faster</span><span>Smarter</span></div>
          <SessionEffortMeter style={providerStyle} count={efforts.length} position={displayedPosition} selectedLabel={selectedLabel} defaultLabel={defaultLabel} highest={highest} snapping={snapping} burstKey={burstKey} disabled={disabled} onChange={(raw) => { if (gesture.current?.kind === 'pointer' && providerStyle === 'claude') applyPosition(raw) }} onPointerMove={(event) => { if (gesture.current?.kind === 'pointer' && gesture.current.pointerId === event.pointerId) applyCodexPointer(event) }} onPointerDown={beginPointer} onPointerUp={finishPointer} onPointerCancel={() => { if (gesture.current?.kind === 'pointer') cancelGesture() }} onLostPointerCapture={() => { if (gesture.current?.kind === 'pointer') cancelGesture() }} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp} />
        </div>
        <div className="session-effort-labels" role="group" aria-label="Effort levels">{labels.map((label, index) => <button type="button" key={`${efforts[index]}-${index}`} className={`${visibleIndex === index ? 'selected' : ''} ${efforts[index] === defaultThinking ? 'default' : ''}`} aria-pressed={visibleIndex === index} disabled={disabled} onClick={() => { stopAnimations(); onPreview(efforts[index] ?? null); const result = onCommit(efforts[index] ?? null); if (index === efforts.length - 1 && providerStyle === 'magnetic') void Promise.resolve(result).then((saved) => { if (saved && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) setBurstKey((key) => key + 1) }); setOpen(false) }}>{label}</button>)}</div>
        <div className="session-effort-footer"><span>{defaultThinking ? <>Recommended: <b>{labelizeEffort(defaultThinking)}</b></> : 'The provider chooses its own default.'}</span><button type="button" className={visibleIndex < 0 ? 'selected' : ''} aria-pressed={visibleIndex < 0} disabled={disabled} onClick={() => { stopAnimations(); onPreview(null); void onCommit(null); setOpen(false) }}>Provider default</button></div>
      </> : <div className="session-effort-unavailable"><strong>{unlistedValue ? `Saved selection: ${labelizeEffort(unlistedValue)}` : 'Provider default'}</strong><p>{unavailableReason ?? 'This model does not report selectable effort levels. Bloblex cannot change effort for it.'}</p>{defaultThinking && <p>Catalog default: {labelizeEffort(defaultThinking)}.</p>}</div>}
    </div>}
  </div>
}

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
  onSelect: (model: string | null) => void
  onFast: (enabled: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const close = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus()) }
  usePopoverDismiss(open, rootRef, close)
  useEffect(() => { if (open) requestAnimationFrame(() => (menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus()) }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  const recommended = models.find((item) => item.isDefault)
  const choose = (next: string | null) => { close(true); onSelect(next) }
  const brand = providerBrand(provider).name
  return <div ref={rootRef} className="composer-popover-anchor">
    <button ref={triggerRef} type="button" className={`composer-pill model-pill ${fastOn ? 'fast' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label={`Conversation model: ${ariaLabel}${fastOn ? ', fast mode on' : ''}`} disabled={disabled || (saving && !open)} onClick={() => setOpen((value) => !value)}>
      {saving ? <LoaderCircle size={13} className="spinning" aria-hidden="true" /> : fastOn ? <Zap size={13} aria-hidden="true" className="model-pill-fast" /> : null}
      <span>{shortModelName(label)}</span>
      <ChevronDown size={12} aria-hidden="true" className="composer-pill-chevron" />
    </button>
    {open && <div ref={menuRef} className="composer-menu model-menu align-right" role="menu" aria-label="Conversation model" onKeyDown={(event) => { if (moveMenuFocus(menuRef.current, event.key)) event.preventDefault() }}>
      <div className="composer-menu-heading">{brand} models</div>
      <div className="composer-menu-scroll">
        <button type="button" role="menuitemradio" aria-checked={!model} className="composer-menu-item" data-value="" disabled={saving} onClick={() => choose(null)}><span className="composer-menu-text"><strong>Provider default</strong>{recommended && <small>Currently {recommended.displayName}</small>}</span>{!model && <Check size={14} className="composer-menu-check" aria-hidden="true" />}</button>
        {models.map((item, index) => <div key={item.id} role="none">
          {item.group && item.group !== models[index - 1]?.group && <div className="composer-menu-group" role="presentation">{item.group}</div>}
          <button type="button" role="menuitemradio" aria-checked={model === item.id} className="composer-menu-item" data-value={item.id} disabled={saving} onClick={() => choose(item.id)}>
            <span className="composer-menu-text"><strong>{item.displayName}{item.isDefault && <small className="composer-menu-tag">Recommended</small>}</strong></span>
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

function resolveProviderStyle(runtimeProvider: string, modelProvider: string | null | undefined, modelId: string | null | undefined, displayName?: string): EffortMeterStyle {
  const modelFamily = `${modelProvider ?? ''} ${modelId ?? ''} ${displayName ?? ''}`.toLowerCase()
  if (/claude|anthropic/.test(modelFamily) || runtimeProvider.toLowerCase() === 'claude') return 'claude'
  if (/codex|openai|\bgpt\b/.test(modelFamily) || runtimeProvider.toLowerCase() === 'codex') return 'magnetic'
  return 'neutral'
}

function labelizeEffort(value: string) {
  if (value.trim().toLowerCase() === 'xhigh') return 'Extra high'
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}
