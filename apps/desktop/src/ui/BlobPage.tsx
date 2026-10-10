import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { AutoResolvedAction, BypassNotice } from '../approvalContract'
import { visibleApprovalMode } from '../approvalContract'
import type { Agent, Project, Runtime, Session } from '../types'
import type { AgentDraft, FieldErrors, StoredExecution } from './agentForm'
import type { ExecutionSendGate } from '../executionContract'
import { Archive, Check, ChevronLeft, Trash2 } from 'lucide-react'
import { BlobOverview } from './BlobOverview'
import { BlobSessions } from './BlobSessions'
import { BlobSettings } from './BlobSettings'
import { useDialogAccessibility } from './dialogFocus'

type MorphPairSnapshot = { rect: DOMRect; fontSize: number; ghost: HTMLElement }
type MorphSnapshot = { surface: DOMRect; radius: string; shadow: string; pairs: Map<string, MorphPairSnapshot> }

export function BlobPage({ mode, agent, draft, runtime, session, runtimes, projects = [], sessions, legacyCount, connected, saving, dirty, ready, canStartSession, error, remoteNotice, errors, execution, autoApprovals = [], bypassNotices = [], onDraftChange, onExecutionGate, onBack, onSave, onCancel, onArchive, onNewSession, onOpenSession }: {
  mode: 'create' | 'edit'
  agent: Agent | null
  draft: AgentDraft
  runtime: Runtime | null
  session: Session | null
  runtimes: Runtime[]
  projects?: Project[]
  sessions: Session[]
  legacyCount: number
  connected: boolean
  saving: boolean
  dirty: boolean
  ready: boolean
  canStartSession: boolean
  error: string | null
  remoteNotice: string | null
  errors: FieldErrors
  execution: StoredExecution
  autoApprovals?: readonly AutoResolvedAction[]
  bypassNotices?: readonly BypassNotice[]
  onDraftChange: (draft: AgentDraft) => void
  onExecutionGate?: (gate: ExecutionSendGate) => void
  onBack: () => void
  onSave: () => void
  onCancel: () => void
  onArchive: () => void
  onNewSession: () => void
  onOpenSession: (session: Session) => void
}) {
  const [discardOpen, setDiscardOpen] = useState(false)
  const backRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { backRef.current?.focus() }, [])
  const title = mode === 'create' ? 'New blob' : agent?.name || draft.name || 'Blob'
  const badgeMode = visibleApprovalMode(draft.approvalMode, agent)
  const latestSessionId = [...sessions].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0]?.id ?? session?.id ?? null
  const blobActions = agent
    ? autoApprovals.filter((action) => action.agentId === agent.id || (!action.agentId && !!latestSessionId && action.sessionId === latestSessionId))
    : []
  const bypassLine = bypassNotices.some((notice) => agent && (notice.agentId === agent.id || (latestSessionId && notice.sessionId === latestSessionId)))
  const leave = () => { setDiscardOpen(false); onBack() }
  const requestBack = () => { if (dirty) setDiscardOpen(true); else onBack() }
  const requestCancel = () => {
    if (mode === 'create') { if (dirty) setDiscardOpen(true); else onBack(); return }
    if (dirty) onCancel()
  }
  const fieldErrors = Object.values(errors).filter((message): message is string => !!message)
  return <div className="blob-page">
    <header className="blob-page-header">
      <button ref={backRef} type="button" className="icon-button" aria-label="Back" title="Back" onClick={requestBack}><ChevronLeft size={18} aria-hidden="true" /></button>
      <strong className="blob-page-heading">{title}</strong>
      <div className="blob-page-actions">
        {dirty && <button type="button" className="ghost-button small" onClick={requestCancel}>Cancel</button>}
        <button type="button" className="primary-button small" disabled={!ready || saving || (mode === 'edit' && !dirty)} onClick={onSave}>{saving ? 'Saving…' : mode === 'create' ? 'Create blob' : 'Save'}</button>
      </div>
    </header>
    <div className="blob-page-scroll">
      <div className="blob-page-column">
        <BlobOverview draft={draft} runtime={runtime} session={session} connected={connected} model={execution.model} mode={mode} approvalMode={badgeMode} agentId={agent?.id ?? null} />
        {error && <p className="blob-page-notice error" role="alert">{error}</p>}
        {remoteNotice && <p className="blob-page-notice" role="status">{remoteNotice}</p>}
        {fieldErrors.map((message) => <p className="blob-page-notice error" role="alert" key={message}>{message}</p>)}
        {bypassLine && <p className="blob-page-notice warning" role="status">Bypass is active for this blob. New requests are approved without asking.</p>}
        <BlobSettings draft={draft} runtimes={runtimes} projects={projects} errors={errors} execution={execution} agentId={agent?.id ?? null} sessionId={latestSessionId} autoApprovals={mode === 'edit' ? blobActions : undefined} onDraftChange={onDraftChange} onExecutionGate={onExecutionGate} />
        {mode === 'edit' && <BlobSessions agent={agent} sessions={sessions} legacyCount={legacyCount} canCreate={canStartSession} onOpenSession={onOpenSession} onNewSession={onNewSession} />}
        {mode === 'edit' && <section className="settings-group blob-group" aria-label="Archive">
          <div className="settings-card blob-archive-card">
            <span className="blob-archive-icon" aria-hidden="true"><Archive size={17} /></span>
            <span className="blob-archive-copy"><strong>Archive {draft.name.trim() || 'this blob'}</strong><small>It leaves the sidebar and companion. Its conversations stay saved.</small></span>
            <button type="button" className="secondary-button small blob-archive-button" onClick={onArchive}>Archive</button>
          </div>
        </section>}
      </div>
    </div>
    {discardOpen && <ConfirmDialog title="Discard unsaved changes?" confirmLabel="Discard" cancelLabel="Keep editing" onConfirm={leave} onCancel={() => setDiscardOpen(false)} />}
  </div>
}

export function ConfirmDialog({ title, body, confirmLabel, cancelLabel, confirmDisabled = false, holdToConfirm = false, tone, icon, successTitle = 'Completed', successBody = 'The action completed successfully.', onConfirm, onCancel, onComplete }: {
  title: string
  body?: string
  /** Destructive dialogs tint the icon and confirm button. Hold-to-confirm implies danger. */
  tone?: 'danger' | 'warning'
  icon?: ReactNode
  confirmLabel: string
  cancelLabel: string
  confirmDisabled?: boolean
  holdToConfirm?: boolean
  successTitle?: string
  successBody?: string
  onConfirm: () => void | Promise<void>
  onCancel: () => void
  onComplete?: () => void
}) {
  const [holding, setHolding] = useState(false)
  const [holdProgress, setHoldProgress] = useState(0)
  const [pending, setPending] = useState(false)
  const [success, setSuccess] = useState(false)
  const [morphFinished, setMorphFinished] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const holdStarted = useRef<number | null>(null)
  const completed = useRef(false)
  const holdArmed = useRef(false)
  const holdArmTimer = useRef<number | null>(null)
  const holdSource = useRef<'pointer' | 'keyboard' | null>(null)
  const pointerId = useRef<number | null>(null)
  const activeKey = useRef<string | null>(null)
  const pendingRef = useRef(false)
  const successRef = useRef(false)
  const doneRef = useRef<HTMLButtonElement>(null)
  const dialogNode = useRef<HTMLElement>(null)
  const preMorph = useRef<MorphSnapshot | null>(null)
  const morphAnimations = useRef<Animation[]>([])
  const morphRun = useRef(0)
  const morphGhosts = useRef<HTMLElement[]>([])
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  const clearMorphGhosts = (snapshot?:MorphSnapshot | null) => {
    if(snapshot)for(const pair of snapshot.pairs.values())pair.ghost.remove()
    for(const ghost of morphGhosts.current)ghost.remove()
    morphGhosts.current=[]
  }
  const finishMorph = () => {
    morphRun.current+=1
    for(const animation of morphAnimations.current)animation.cancel()
    morphAnimations.current=[]
    const dialog=dialogNode.current
    if(dialog){for(const property of ['position','inset','margin','max-width','box-sizing','left','top','width','height','will-change'])dialog.style.removeProperty(property);for(const element of dialog.querySelectorAll<HTMLElement>('[data-morph]')){element.style.removeProperty('transform-origin');element.style.removeProperty('will-change')}}
    clearMorphGhosts(preMorph.current);preMorph.current=null
    setMorphFinished(true)
  }
  useLayoutEffect(() => {
    if (!success || !preMorph.current) return
    const dialog = dialogNode.current ?? ref.current
    const before = preMorph.current
    preMorph.current = null
    if (!dialog) { finishMorph(); return }
    const after = dialog.getBoundingClientRect()
    const afterStyle = getComputedStyle(dialog)
    const targets = new Map<string,{ element:HTMLElement; rect:DOMRect; fontSize:number }>()
    for(const [sourceKey,targetKey] of [['title','title'],['body','body'],['cancel','done']] as const){
      const element=dialog.querySelector<HTMLElement>(`[data-morph="${targetKey}"]`)
      if(element)targets.set(sourceKey,{element,rect:element.getBoundingClientRect(),fontSize:parseFloat(getComputedStyle(element).fontSize)||16})
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || typeof dialog.animate !== 'function') {
      clearMorphGhosts(before);preMorph.current=null;setMorphFinished(true);return
    }
    dialog.focus({preventScroll:true})
    const run=++morphRun.current
    const duration=readCssDuration(dialog,'--shared-dialog-panel-duration',300)
    const textDuration=readCssDuration(dialog,'--shared-dialog-content-duration',150)
    const fadeDuration=readCssDuration(dialog,'--success-content-duration',80)
    const easing=getComputedStyle(dialog).getPropertyValue('--shared-dialog-ease').trim()||'cubic-bezier(0.22, 1, 0.36, 1)'
    dialog.style.position='fixed';dialog.style.inset='auto';dialog.style.margin='0';dialog.style.maxWidth='none';dialog.style.boxSizing='border-box'
    dialog.style.left=`${after.left}px`;dialog.style.top=`${after.top}px`;dialog.style.width=`${after.width}px`;dialog.style.height=`${after.height}px`;dialog.style.willChange='left, top, width, height, border-radius, box-shadow'
    const panel=dialog.animate([
      {left:`${before.surface.left}px`,top:`${before.surface.top}px`,width:`${before.surface.width}px`,height:`${before.surface.height}px`,borderRadius:before.radius,boxShadow:before.shadow},
      {left:`${after.left}px`,top:`${after.top}px`,width:`${after.width}px`,height:`${after.height}px`,borderRadius:afterStyle.borderTopLeftRadius,boxShadow:afterStyle.boxShadow},
    ],{duration,easing,fill:'both'})
    panel.pause();panel.currentTime=0;morphAnimations.current=[panel]
    for(const [sourceKey,target] of targets){
      const source=before.pairs.get(sourceKey);if(!source)continue
      const sourceCenterX=source.rect.left+source.rect.width/2,sourceCenterY=source.rect.top+source.rect.height/2
      const targetCenterX=target.rect.left+target.rect.width/2,targetCenterY=target.rect.top+target.rect.height/2
      const isButton=sourceKey==='cancel'
      const sx=isButton?source.rect.width/Math.max(target.rect.width,1):source.fontSize/target.fontSize
      const sy=isButton?source.rect.height/Math.max(target.rect.height,1):sx
      const tx=target.rect.width/Math.max(source.rect.width,1),ty=isButton?target.rect.height/Math.max(source.rect.height,1):target.fontSize/source.fontSize
      target.element.style.transformOrigin='center center';target.element.style.willChange='transform'
      source.ghost.style.opacity='1'
      const targetAnimation=target.element.animate([
        {transform:`translate(${sourceCenterX-targetCenterX}px, ${sourceCenterY-targetCenterY}px) scale(${sx}, ${sy})`},
        {transform:'translate(0, 0) scale(1, 1)'},
      ],{duration:textDuration,easing,fill:'both'})
      targetAnimation.pause();targetAnimation.currentTime=0;morphAnimations.current.push(targetAnimation)
      source.ghost.style.transformOrigin='center center';source.ghost.style.willChange='transform, opacity'
      const sourceAnimation=source.ghost.animate([
        {transform:'translate(0, 0) scale(1, 1)'},
        {transform:`translate(${targetCenterX-sourceCenterX}px, ${targetCenterY-sourceCenterY}px) scale(${tx}, ${ty})`},
      ],{duration:textDuration,easing,fill:'both'})
      const fade=source.ghost.animate([{opacity:1},{opacity:0}],{duration:fadeDuration,easing,fill:'both'})
      sourceAnimation.pause();sourceAnimation.currentTime=0;fade.pause();fade.currentTime=0;morphAnimations.current.push(sourceAnimation,fade)
    }
    for(const animation of morphAnimations.current)void animation.finished.catch(()=>undefined)
    panel.play();for(const animation of morphAnimations.current.slice(1))animation.play()
    panel.finished.then(()=>{if(run!==morphRun.current)return;finishMorph()}).catch(()=>undefined)
  }, [success])
  useLayoutEffect(()=>{if(holdToConfirm&&success&&morphFinished)doneRef.current?.focus()},[holdToConfirm,success,morphFinished])
  useEffect(() => {
    if (!holding || !holdToConfirm || confirmDisabled) return
    const timer = window.setInterval(() => {
      const started = holdStarted.current
      if (started === null || holdArmed.current) return
      const progress = Math.min(1, (performance.now() - started) / 1000)
      setHoldProgress(progress)
    }, 24)
    return () => window.clearInterval(timer)
  }, [holding, holdToConfirm, confirmDisabled])
  const beginHold = (source: 'pointer' | 'keyboard') => {
    if (confirmDisabled || completed.current || holdStarted.current !== null) return
    holdSource.current = source
    holdArmed.current = false
    holdStarted.current = performance.now()
    setHoldProgress(0)
    setHolding(true)
    holdArmTimer.current = window.setTimeout(() => { holdArmed.current = true; setHoldProgress(1) }, 1000)
  }
  const cancelHold = () => {
    if (holdArmTimer.current !== null) window.clearTimeout(holdArmTimer.current)
    holdArmTimer.current = null
    holdStarted.current = null
    holdArmed.current = false
    holdSource.current = null
    pointerId.current = null
    activeKey.current = null
    setHolding(false)
    setHoldProgress(0)
  }
  const finishHold = () => {
    if (holdArmed.current && !completed.current && !confirmDisabled) {
      if (holdArmTimer.current !== null) window.clearTimeout(holdArmTimer.current)
      holdArmTimer.current = null
      completed.current = true
      holdStarted.current = null
      holdArmed.current = false
      holdSource.current = null
      pointerId.current = null
      activeKey.current = null
      setHolding(false)
      setHoldProgress(1)
      void runHoldAction()
    }
    else cancelHold()
  }
  const runHoldAction = async () => {
    if (pendingRef.current || successRef.current) return
    const morphDialog = dialogNode.current ?? ref.current
    if (holdToConfirm && morphDialog) {
      const computed=getComputedStyle(morphDialog),pairs=new Map<string,MorphPairSnapshot>()
      for(const key of ['title','body','cancel']){
        const source=morphDialog.querySelector<HTMLElement>(`[data-morph="${key}"]`)
        if(!source)continue
        const rect=source.getBoundingClientRect(),style=getComputedStyle(source),ghost=source.cloneNode(true) as HTMLElement
        ghost.removeAttribute('id');ghost.removeAttribute('aria-describedby');ghost.removeAttribute('aria-labelledby');ghost.setAttribute('aria-hidden','true');ghost.dataset.morphGhost=key
        if(ghost instanceof HTMLButtonElement){ghost.disabled=true;ghost.tabIndex=-1}
        for(const property of ['font-family','font-size','font-weight','line-height','letter-spacing','color','text-align','background-color','border','border-radius','box-shadow','padding','min-height','display','align-items','justify-content'])ghost.style.setProperty(property,style.getPropertyValue(property))
        Object.assign(ghost.style,{position:'fixed',left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`,margin:'0',zIndex:'41',pointerEvents:'none',boxSizing:'border-box',transformOrigin:'center center',opacity:'0'})
        document.body.append(ghost);morphGhosts.current.push(ghost)
        pairs.set(key,{rect,fontSize:parseFloat(style.fontSize)||16,ghost})
      }
      preMorph.current={surface:morphDialog.getBoundingClientRect(),radius:computed.borderTopLeftRadius,shadow:computed.boxShadow,pairs}
    }
    pendingRef.current = true
    setPending(true)
    setFailure(null)
    try {
      await onConfirm()
      successRef.current = true
      setSuccess(true)
    } catch (reason) {
      clearMorphGhosts(preMorph.current);preMorph.current=null
      const message = reason instanceof Error && reason.message.trim() ? reason.message.trim() : 'The action could not be completed. Try again.'
      setFailure(message.slice(0, 200))
      completed.current = false
      setHoldProgress(0)
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }
  const cancel = () => {
    if (pendingRef.current || (successRef.current && !morphFinished)) return
    cancelHold()
    if (successRef.current) {
      if (onComplete) onComplete()
      else onCancel()
    }
    else onCancel()
  }
  useEffect(() => {
    if (!holding || !holdToConfirm) return
    const onBlur = () => cancelHold()
    const onVisibility = () => { if (document.hidden) cancelHold() }
    const onKeyUp = (event: KeyboardEvent) => {
      if (holdSource.current === 'keyboard' && activeKey.current && event.key === activeKey.current) {
        event.preventDefault()
        finishHold()
      }
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('pagehide', onBlur)
    window.addEventListener('keyup', onKeyUp, true)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pagehide', onBlur)
      window.removeEventListener('keyup', onKeyUp, true)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [holding, holdToConfirm])
  useEffect(() => () => {
    morphRun.current+=1
    for(const animation of morphAnimations.current)animation.cancel()
    morphAnimations.current=[]
    clearMorphGhosts(preMorph.current);preMorph.current=null
    if (holdArmTimer.current !== null) window.clearTimeout(holdArmTimer.current)
    holdStarted.current = null
    holdArmed.current = false
    holdSource.current = null
    pointerId.current = null
    activeKey.current = null
  }, [])
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pointerId.current !== event.pointerId || !holding) return
    const rect = event.currentTarget.getBoundingClientRect()
    const tolerance = 12
    if (event.clientX < rect.left - tolerance || event.clientX > rect.right + tolerance || event.clientY < rect.top - tolerance || event.clientY > rect.bottom + tolerance) cancelHold()
  }
  const { ref, close } = useDialogAccessibility(cancel, () => !pendingRef.current && (!successRef.current || morphFinished))
  const dialogTone = tone ?? (holdToConfirm ? 'danger' : undefined)
  const dialogIcon = icon ?? (holdToConfirm ? <Trash2 size={18} /> : null)
  useLayoutEffect(() => { dialogNode.current = ref.current }, [ref])
  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className={`blob-dialog ${holdToConfirm && success ? 'is-success' : ''}`} role="dialog" aria-modal="true" aria-labelledby="blob-dialog-title" tabIndex={-1} aria-busy={pending || (holdToConfirm && success && !morphFinished) || undefined}>
      {holdToConfirm && success ? <div className="hold-confirm-success" aria-live="polite">
        <span className="hold-confirm-success-icon" aria-hidden="true"><Check size={20} /></span>
        <h2 id="blob-dialog-title" data-morph="title">{successTitle}</h2>
        <p data-morph="body">{successBody}</p>
        <button ref={doneRef} type="button" className="primary-button" data-morph="done" data-dialog-initial-focus disabled={!morphFinished} onClick={close}>Done</button>
      </div> : <>
        {dialogIcon && <span className={`blob-dialog-icon ${dialogTone ?? ''}`} aria-hidden="true">{dialogIcon}</span>}
        <h2 id="blob-dialog-title" data-morph="title">{title}</h2>
        {body && <p data-morph="body">{body}</p>}
        {failure && <p className="hold-confirm-error" role="alert">{failure}</p>}
        <div className="blob-dialog-actions">
          {holdToConfirm
            ? <button type="button" className="secondary-button" data-morph="cancel" data-dialog-initial-focus disabled={pending} onClick={close}>{cancelLabel}</button>
            : <button type="button" className="secondary-button" data-dialog-initial-focus onClick={close}>{cancelLabel}</button>}
          <button type="button" className={holdToConfirm ? `hold-confirm-button ${holding ? 'holding' : ''} ${holding && holdArmed.current ? 'armed' : ''}` : `primary-button ${dialogTone === 'danger' ? 'danger-confirm-button' : ''}`} disabled={confirmDisabled || pending || (holdToConfirm && completed.current)} aria-label={holdToConfirm ? (pending ? 'Action in progress' : holdArmed.current ? `Release to ${confirmLabel.toLowerCase()}` : `Press and hold to ${confirmLabel.toLowerCase()}`) : undefined} aria-describedby={holdToConfirm ? 'hold-confirm-hint' : undefined} aria-busy={holdToConfirm && (holding || pending) ? 'true' : undefined} style={holdToConfirm ? { '--hold-progress': `${holdProgress * 100}%` } as CSSProperties : undefined} onClick={holdToConfirm ? (event) => { event.preventDefault(); event.stopPropagation() } : () => { void onConfirm() }} onContextMenu={holdToConfirm ? (event) => event.preventDefault() : undefined} onPointerDown={holdToConfirm ? (event) => { if (event.button !== undefined && event.button !== 0) return; event.preventDefault(); pointerId.current = event.pointerId; try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* capture is optional */ } beginHold('pointer') } : undefined} onPointerMove={holdToConfirm ? onPointerMove : undefined} onPointerUp={holdToConfirm ? (event) => { if (pointerId.current === event.pointerId) finishHold() } : undefined} onPointerCancel={holdToConfirm ? cancelHold : undefined} onLostPointerCapture={holdToConfirm ? () => { if (holdSource.current === 'pointer') cancelHold() } : undefined} onKeyDown={holdToConfirm ? (event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (!event.repeat && holdStarted.current === null) { activeKey.current = event.key; beginHold('keyboard') } } } : undefined}>{holdToConfirm && <span className="hold-confirm-fill" aria-hidden="true" />}<span className={holdToConfirm ? 'hold-confirm-label' : undefined}>{holdToConfirm ? (pending ? 'Working…' : holding ? holdArmed.current ? `Release to ${confirmLabel.toLowerCase()}` : 'Keep holding…' : `Hold to ${confirmLabel.toLowerCase()}`) : confirmLabel}</span></button>
        </div>
        {holdToConfirm && <><p id="hold-confirm-hint" className="sr-only">{pending ? 'Please wait for the action to finish.' : holding ? holdArmed.current ? '' : 'Keep holding for one second. Releasing early cancels.' : 'Press and hold for one second. Releasing early cancels.'}</p><span className="sr-only" role="progressbar" aria-label="Hold to confirm progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(holdProgress * 100)} /></>}
      </>}
    </section>
  </div>
}

function readCssDuration(element:HTMLElement, property:string, fallback:number) {
  const value=getComputedStyle(element).getPropertyValue(property).trim()
  const number=parseFloat(value)
  if(!Number.isFinite(number))return fallback
  return value.endsWith('s')&&!value.endsWith('ms')?number*1000:number
}
