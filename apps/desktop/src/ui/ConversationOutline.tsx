import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { JsonRecord } from '../types'
import { outlineTickInfluence, stepOutlineSpring, stepOutlineCardSpring } from './meterMotion'

export type ConversationOutlineItem = {
  anchor: string
  role: 'You' | string
  index: number
  userText?: string
  assistantText?: string
  assistantRole?: string
}

export function outlineItemsFromMessages(messages: Array<{ id: string; value?: JsonRecord }>, assistantName: string): ConversationOutlineItem[] {
  const source = messages.flatMap((item) => {
    const message = item.value ?? {}
    const roleValue = String(message.role ?? message.kind ?? '').toLowerCase()
    const toolName = typeof message.toolName === 'string' || typeof message.tool === 'string'
    const eventType = String(message.eventType ?? '').toLowerCase()
    if (toolName || eventType.startsWith('tool.') || eventType.startsWith('command.')) return []
    if (roleValue !== 'user' && roleValue !== 'assistant') return []
    const text = typeof message.text === 'string' ? message.text : typeof message.content === 'string' ? message.content : ''
    return [{
      id: item.id,
      anchor: `conversation-message-${encodeURIComponent(item.id)}`,
      role: roleValue as 'user' | 'assistant',
      text: outlineText(text),
      turnId: typeof message.turnId === 'string' ? message.turnId : null,
    }]
  })
  const turnUserIndexes = new Map<string, number>()
  const turnAssistantIndexes = new Map<string, number>()
  source.forEach((message, index) => {
    if (message.role === 'user' && message.turnId) turnUserIndexes.set(message.turnId, index)
    if (message.role === 'assistant' && message.turnId && !turnAssistantIndexes.has(message.turnId)) turnAssistantIndexes.set(message.turnId, index)
  })
  const precedingUserIndexes: Array<number | null> = []
  let precedingUser: number | null = null
  source.forEach((message, index) => {
    if (message.role === 'user') precedingUser = index
    precedingUserIndexes[index] = precedingUser
  })
  const assistantIndexesByUnknownTurnUser = new Map<number, number>()
  for (let index = 0; index < source.length; index += 1) {
    const message = source[index]
    if (message.role !== 'user' || message.turnId) continue
    for (let candidate = index + 1; candidate < source.length && source[candidate].role !== 'user'; candidate += 1) {
      if (source[candidate].role === 'assistant' && !source[candidate].turnId) {
        assistantIndexesByUnknownTurnUser.set(index, candidate)
        break
      }
    }
  }
  return source.map((message, index) => {
    const counterpartIndex = message.role === 'user'
      ? message.turnId
        ? ((turnAssistantIndexes.get(message.turnId) ?? -1) > index ? turnAssistantIndexes.get(message.turnId) : undefined)
        : assistantIndexesByUnknownTurnUser.get(index)
      : message.turnId
        ? turnUserIndexes.get(message.turnId)
        : precedingUserIndexes[index] !== null && !source[precedingUserIndexes[index]!].turnId
          ? precedingUserIndexes[index]!
          : undefined
    const counterpart = counterpartIndex === undefined || counterpartIndex === index ? undefined : source[counterpartIndex]
    const userText = message.role === 'user' ? message.text : counterpart?.text
    const assistantText = message.role === 'assistant' ? message.text : counterpart?.text
    return {
      anchor: message.anchor,
      role: message.role === 'user' ? 'You' : assistantName,
      index,
      userText,
      assistantText,
      assistantRole: message.role === 'assistant' || counterpart?.role === 'assistant' ? assistantName : undefined,
    }
  })
}

function outlineText(value: string) {
  return value.replace(/```[\s\S]*?```/g, ' [code] ').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim().slice(0, 180)
}

export function ConversationOutline({ items, sessionId }: { items: ConversationOutlineItem[]; sessionId: string }) {
  const [active, setActive] = useState(0)
  const [hovered, setHovered] = useState<number | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [floatIndex, setFloatIndex] = useState<number | null>(null)
  const [tickInfluence, setTickInfluence] = useState<number[]>([])
  const [cardShown,setCardShown]=useState(false)
  const [cardLayout,setCardLayout]=useState({y:18,height:0})
  const previewId = useId()
  const trackRef = useRef<HTMLDivElement>(null)
  const scrollFrame = useRef<number | null>(null)
  const activeRef = useRef(active)
  const dragPointer = useRef<number | null>(null)
  const previousSessionId = useRef(sessionId)
  const cardRef=useRef<HTMLSpanElement>(null)
  const cardMotion=useRef({y:18,yVelocity:0,targetY:18,height:0,heightVelocity:0,targetHeight:0,last:0,frame:0})
  const cardRunner=useRef<()=>void>(()=>undefined)
  const closeTimer=useRef<number|null>(null)
  activeRef.current = active
  const ids = items.map((item) => item.anchor).join('|')
  const clampIndex = (index: number) => Math.max(0, Math.min(Math.max(0, items.length - 1), index))

  useEffect(() => {
    if (previousSessionId.current !== sessionId) {
      previousSessionId.current = sessionId
      activeRef.current = 0
      setActive(0)
      setHovered(null)
      setPinned(false)
      setPreviewOpen(false)
      setFloatIndex(null)
      setCardShown(false)
      if(closeTimer.current!==null)window.clearTimeout(closeTimer.current)
    } else {
      activeRef.current = clampIndex(activeRef.current)
      setActive((current) => clampIndex(current))
    }
    setHovered((current) => current !== null && current < items.length ? current : null)
    setFloatIndex((current) => current === null ? null : Math.max(0, Math.min(Math.max(0, items.length - 1), current)))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, sessionId])

  const navigate = (index: number, immediate = false) => {
    if (!items.length) return
    const next = clampIndex(index)
    activeRef.current = next
    setActive(next)
    const target = document.getElementById(items[next]?.anchor ?? '')
    target?.scrollIntoView({ block: 'center', behavior: immediate || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }

  const sampleCount = Math.min(items.length, 64)
  const ticks = Array.from({ length: sampleCount }, (_, position) => sampleCount === 1 ? 0 : Math.round(position * (items.length - 1) / (sampleCount - 1)))
  const previewIndex = hovered ?? active
  const selected = items[previewIndex]
  const activeItem = items[active]
  const activeAssistantName = activeItem?.assistantRole ?? (activeItem?.role !== 'You' ? activeItem?.role : 'Assistant')
  const assistantName = selected?.assistantRole ?? (selected?.role !== 'You' ? selected?.role : 'Assistant')
  const activePercent = items.length > 1 ? active / (items.length - 1) * 100 : 0

  const startCardMotion=()=>{
    const motion=cardMotion.current
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){motion.y=motion.targetY;motion.yVelocity=0;motion.height=motion.targetHeight;motion.heightVelocity=0;setCardLayout({y:motion.y,height:motion.height});if(motion.targetHeight===0)setCardShown(false);return}
    if(motion.frame)return
    motion.last=performance.now()
    const step=(now:number)=>{
      const current=cardMotion.current,dt=Math.min(Math.max(0,(now-current.last)/1000),.032);current.last=now
      const next=stepOutlineCardSpring(current.y,current.yVelocity,current.targetY,current.height,current.heightVelocity,current.targetHeight,dt)
      current.y=next.y;current.yVelocity=next.yVelocity;current.height=next.height;current.heightVelocity=next.heightVelocity
      const settled=Math.abs(current.targetY-current.y)<.05&&Math.abs(current.yVelocity)<.1&&Math.abs(current.targetHeight-current.height)<.05&&Math.abs(current.heightVelocity)<.1
      if(settled){current.y=current.targetY;current.height=current.targetHeight;current.yVelocity=0;current.heightVelocity=0}
      setCardLayout({y:current.y,height:Math.max(0,current.height)})
      if(settled){current.frame=0;if(current.targetHeight===0)setCardShown(false)}else current.frame=requestAnimationFrame(step)
    }
    motion.frame=requestAnimationFrame(step)
  }
  cardRunner.current=startCardMotion
  const setCardTarget=(show:boolean,index:number)=>{
    const motion=cardMotion.current,track=trackRef.current
    if(show){
      setCardShown(true)
      const trackHeight=track?.clientHeight??0
      const measured=cardRef.current?.scrollHeight??104
      const height=Math.min(Math.max(72,measured),Math.max(72,trackHeight-36))
      const center=items.length>1?index/Math.max(1,items.length-1)*trackHeight:trackHeight/2
      motion.targetHeight=height
      motion.targetY=Math.max(18,Math.min(Math.max(18,trackHeight-height-18),center-height/2))
      if(!cardLayout.height&&motion.height===0){motion.y=motion.targetY;motion.height=height;setCardLayout({y:motion.y,height})}
    }else motion.targetHeight=0
    cardRunner.current()
  }
  const scheduleClose=(delay:number)=>{
    if(closeTimer.current!==null)window.clearTimeout(closeTimer.current)
    closeTimer.current=window.setTimeout(()=>{closeTimer.current=null;if(dragPointer.current===null&&!pinned&&document.activeElement!==trackRef.current){setPreviewOpen(false);setHovered(null);setFloatIndex(null);setCardTarget(false,activeRef.current)}},delay)
  }
  useLayoutEffect(()=>{
    if(previewOpen){
      const measured=cardRef.current?.scrollHeight??0
      if(measured>0){const m=cardMotion.current,trackHeight=trackRef.current?.clientHeight??0;m.targetHeight=Math.min(Math.max(72,measured),Math.max(72,trackHeight-36));const center=items.length>1?(floatIndex??previewIndex)/Math.max(1,items.length-1)*trackHeight:trackHeight/2;m.targetY=Math.max(18,Math.min(Math.max(18,trackHeight-m.targetHeight-18),center-m.targetHeight/2));cardRunner.current()}
    }
  },[previewOpen,cardShown,previewIndex,floatIndex,selected?.userText,selected?.assistantText])
  useEffect(()=>()=>{if(cardMotion.current.frame)cancelAnimationFrame(cardMotion.current.frame);if(closeTimer.current!==null)window.clearTimeout(closeTimer.current)},[])

  const indexAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const floating = rect.height <= 0 ? activeRef.current : Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * (items.length - 1)
    return { index:clampIndex(Math.round(floating)), floating }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = activeRef.current + 1
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = activeRef.current - 1
    else if (event.key === 'PageDown') next = activeRef.current + 10
    else if (event.key === 'PageUp') next = activeRef.current - 10
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'Escape') { event.preventDefault(); setPinned(false); setPreviewOpen(false); setHovered(null); setFloatIndex(null);setCardTarget(false,activeRef.current);return }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate(activeRef.current); setPinned((value) => !value); setPreviewOpen(true);setCardTarget(true,activeRef.current);return }
    if (next !== null) { event.preventDefault(); setHovered(null); setFloatIndex(null); setPreviewOpen(true); navigate(next);setCardTarget(true,next) }
  }

  useEffect(() => {
    if (items.length < 2) return
    const host = trackRef.current?.closest('.message-list')
    if (!host) return
    const sync = () => {
      if (scrollFrame.current !== null) return
      scrollFrame.current = requestAnimationFrame(() => {
        scrollFrame.current = null
        const bounds = host.getBoundingClientRect()
        if (bounds.height <= 0) return
        const center = bounds.top + bounds.height * 0.44
        let nearest = activeRef.current
        let nearestDistance = Number.POSITIVE_INFINITY
        for (let index = 0; index < items.length; index += 1) {
          const target = document.getElementById(items[index].anchor)
          if (!target) continue
          const rect = target.getBoundingClientRect()
          if (rect.bottom < bounds.top || rect.top > bounds.bottom) continue
          const distance = Math.abs((rect.top + Math.min(rect.height, 42) / 2) - center)
          if (distance < nearestDistance) { nearest = index; nearestDistance = distance }
        }
        activeRef.current = clampIndex(nearest)
        setActive(activeRef.current)
      })
    }
    sync()
    host.addEventListener('scroll', sync, { passive: true })
    return () => { host.removeEventListener('scroll', sync); if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); scrollFrame.current = null }
  // Scroll tracking is rebound when message anchors or the selected session changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, sessionId])

  useEffect(() => {
    const targets = ticks.map((index) => outlineTickInfluence(index, floatIndex ?? active))
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) { setTickInfluence(targets); return }
    let frame = 0, last = performance.now()
    const motion = targets.map((target, index) => ({ value:tickInfluence[index] ?? 0, velocity:0, target }))
    const animate = (now:number) => {
      const dt = Math.min((now-last)/1000,.032); last=now
      let settled = true
      for (const item of motion) {
        const next=stepOutlineSpring(item.value,item.velocity,item.target,dt);item.value=next.value;item.velocity=next.velocity
        if(Math.abs(item.target-item.value)>=.0005||Math.abs(item.velocity)>=.005)settled=false
      }
      setTickInfluence(motion.map((item)=>item.value))
      if(!settled)frame=requestAnimationFrame(animate)
    }
    frame=requestAnimationFrame(animate)
    return()=>cancelAnimationFrame(frame)
  // Tick field has at most 64 samples regardless of transcript length.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active,floatIndex,ids])

  if (items.length < 2) return null
  const sampledInfluence = (position:number) => tickInfluence[position] ?? 0
  return <nav className="conversation-outline" aria-label="Conversation message outline" onPointerEnter={() => { if(closeTimer.current!==null)window.clearTimeout(closeTimer.current);closeTimer.current=null;setPreviewOpen(true);setPinned(false);setCardTarget(true,previewIndex) }} onPointerLeave={(event) => { setHovered(null);setFloatIndex(null);if(event.pointerType==='touch'||dragging||pinned||document.activeElement===trackRef.current)return;scheduleClose(80) }}>
    <div ref={trackRef} className="conversation-outline-track" role="slider" aria-orientation="vertical" aria-label="Conversation message position" aria-valuemin={1} aria-valuemax={items.length} aria-valuenow={active + 1} aria-valuetext={`Message ${active + 1} of ${items.length}${activeItem?.userText ? ` · You: ${activeItem.userText}` : ''}${activeItem?.assistantText ? ` · ${activeAssistantName}: ${activeItem.assistantText}` : ''}${!activeItem?.userText && !activeItem?.assistantText ? ` · ${activeItem?.role ?? 'Message'} preview unavailable` : ''}`} aria-describedby={previewOpen && selected ? previewId : undefined} tabIndex={0} onFocus={() => { setPreviewOpen(true); setHovered(null);setCardTarget(true,activeRef.current) }} onBlur={() => { if (!pinned && dragPointer.current === null) {setPreviewOpen(false);setCardTarget(false,activeRef.current)} }} onKeyDown={onKeyDown} onPointerMove={(event) => {
      const {index,floating} = indexAtPointer(event)
      setHovered(index);setFloatIndex(floating)
      setPreviewOpen(true);setCardTarget(true,floating)
      if (dragPointer.current === event.pointerId) navigate(index, true)
    }} onPointerDown={(event) => {
      event.preventDefault()
      dragPointer.current = event.pointerId
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* pointer capture is optional */ }
      setDragging(true)
      const {index,floating} = indexAtPointer(event)
      setHovered(index);setFloatIndex(floating)
      setPreviewOpen(true);setCardTarget(true,floating)
      navigate(index, true)
    }} onPointerUp={(event) => { if (dragPointer.current !== event.pointerId) return;dragPointer.current=null;setDragging(false);if(event.pointerType==='touch')scheduleClose(1400);else if(!pinned&&document.activeElement!==trackRef.current)scheduleClose(80) }} onPointerCancel={() => { dragPointer.current = null; setDragging(false) }} onLostPointerCapture={() => { dragPointer.current = null; setDragging(false) }}>
      <span className="conversation-outline-line" aria-hidden="true" />
      {ticks.map((index,position) => {const influence=sampledInfluence(position);return <span key={items[index].anchor} className={`conversation-outline-tick ${index === active ? 'active' : ''} ${index === hovered ? 'hovered' : ''}`} style={{ top: `${index / Math.max(1, items.length - 1) * 100}%`, transform: `translateY(-50%) scaleX(${.5+1.75*influence})`, opacity:.19+.78*influence }} aria-hidden="true"/>})}
      <span className="conversation-outline-thumb" aria-hidden="true" style={{ top: `${activePercent}%` }} />
      {cardShown && selected && <span ref={cardRef} id={previewId} className="conversation-outline-preview" role="tooltip" style={{ top:`${cardLayout.y}px`,height:`${cardLayout.height}px` }}>
        {selected.userText && <span><b>You</b>{selected.userText}</span>}
        {selected.assistantText && <span><b>{assistantName}</b>{selected.assistantText}</span>}
        {!selected.userText && !selected.assistantText && <span><b>{selected.role}</b>Message preview unavailable</span>}
      </span>}
    </div>
  </nav>
}
