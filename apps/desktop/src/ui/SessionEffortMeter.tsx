import { useEffect, useRef } from 'react'
import type { ChangeEvent, PointerEvent, KeyboardEvent, CSSProperties } from 'react'
import { codexGradientAt, codexRgb } from './meterMotion'

export type EffortMeterStyle = 'claude' | 'magnetic' | 'neutral'
type State = { style: EffortMeterStyle; position: number; highest: boolean; count: number; burstKey: number }
type Particle = { x: number; y: number; r: number; phase: number; twinkle: number; flow: number }
type Confetti = { x:number; y:number; vx:number; vy:number; size:number; life:number; ttl:number; color:string }

export function SessionEffortMeter({ style, count, position, selectedLabel, defaultLabel, highest, snapping, burstKey, onChange, onPointerMove, onPointerDown, onPointerUp, onPointerCancel, onLostPointerCapture, onKeyDown, onKeyUp, disabled }: {
  style: EffortMeterStyle; count: number; position: number; selectedLabel: string; defaultLabel: string; highest: boolean; snapping: boolean; burstKey: number
  onChange: (value: number) => void; onPointerMove: (event: PointerEvent<HTMLInputElement>) => void; onPointerDown: (event: PointerEvent<HTMLInputElement>) => void; onPointerUp: (event: PointerEvent<HTMLInputElement>) => void
  onPointerCancel: () => void; onLostPointerCapture: () => void; onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void; onKeyUp: (event: KeyboardEvent<HTMLInputElement>) => void; disabled: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const confettiRef = useRef<HTMLCanvasElement>(null)
  const redrawRef = useRef<(time:number)=>void>(()=>undefined)
  const stateRef = useRef<State>({ style, position, highest, count, burstKey })
  stateRef.current = { style, position, highest, count, burstKey }
  useEffect(() => {
    const canvas = canvasRef.current, confettiCanvas = confettiRef.current, host = canvas?.parentElement, ctx = canvas?.getContext('2d'), confettiCtx = confettiCanvas?.getContext('2d')
    if (!canvas || !confettiCanvas || !host || !ctx || !confettiCtx) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let raf = 0, confettiRaf = 0, width = 0, height = 0, dpr = 1, last = 0, confettiLast = 0, revealStarted = performance.now(), seenBurst = stateRef.current.burstKey, refresh=()=>undefined
    let previousHighest = stateRef.current.highest
    let particles: Particle[] = [], confetti: Confetti[] = []
    const seed = () => { particles = Array.from({ length:Math.max(6, Math.round(width / 24)) }, () => ({ x:Math.random()*width, y:4+Math.random()*Math.max(1,height-8), r:.8+Math.random()*.9, phase:Math.random()*Math.PI*2, twinkle:2.5+Math.random()*4.5, flow:85+Math.random()*50 })) }
    const resize = () => {
      const rect = host.getBoundingClientRect(); if (!rect.width || !rect.height) return
      const nextDpr=Math.min(window.devicePixelRatio||1,2)
      if(width===rect.width&&height===rect.height&&dpr===nextDpr)return
      width = rect.width; height = rect.height; dpr = nextDpr
      canvas.width = Math.round(width*dpr); canvas.height = Math.round(height*dpr); canvas.style.width = `${width}px`; canvas.style.height = `${height}px`
      confettiCanvas.width=Math.round((width+64)*dpr);confettiCanvas.height=Math.round((height+80)*dpr)
      confettiCanvas.style.width=`${width+64}px`;confettiCanvas.style.height=`${height+80}px`
      if (stateRef.current.style === 'magnetic') seed()
      refresh()
    }
    const drawClaude = (time: number, state: State) => {
      if (!state.highest || !width || !height) return
      const elapsed = Math.max(0, time-revealStarted), reveal = motion.matches ? 1 : smoothstep(0,1,elapsed/1000), frontier = 1-reveal
      const cell = width < 280 ? 5 : 6, gap = 1.1, columns = Math.ceil(width/cell), rows = Math.ceil(height/cell)
      const left:[number,number,number]=[210,206,214], peak:[number,number,number]=[232,224,242], highlight:[number,number,number]=[216,204,228]
      const tones:[[number,number,number],...[number,number,number][]]=[[156,120,192],[156,120,192],[156,132,192],[156,132,192],[168,144,204],[168,144,204],[168,144,204],[168,156,204],[168,156,204],[180,168,204],[192,180,204]]
      const rawFlow=elapsed/4000, flowCycle=Math.floor(rawFlow), easedFlow=flowCycle+smoothstep(0,1,rawFlow-flowCycle)
      ctx.save(); ctx.beginPath(); ctx.roundRect(0,0,width,height,10); ctx.clip()
      for(let row=0;row<rows;row++) for(let col=0;col<columns;col++) {
        const x=col*cell,y=row*cell,nx=(x+cell*.5)/width, revealAlpha=smoothstep(frontier-.1,frontier+.07,nx); if(revealAlpha<=.002) continue
        const purple=smoothstep(.1,.88,nx), intensity=smoothstep(.04,.38,nx), depth=smoothstep(.35,.95,nx)
        const bh=hash(col*12.9898+row*78.233,43758.5453), th=hash(col*7.13+row*19.41,19341.731), ph=hash(col*31.17+row*11.93,28437.123), ch=hash(col*9.47+row*67.13,15823.917)
        const period=500+th*1500, local=elapsed+ph*period, cycle=Math.floor(local/period), progress=(local%period)/period
        const cycleHash=hash(col*17.17+row*41.73+cycle*13.11,24634.6345), widthHash=hash(col*5.37+row*29.11+cycle*7.43,17391.443)
        const center=.2+cycleHash*.55,pulseWidth=.09+widthHash*.08,pulse=Math.exp(-(((progress-center)/pulseWidth)**2)*1.45), irregular=pulse*(cycleHash>.12?1:.26)
        const flowCoord=(nx+easedFlow)*9, flowIndex=Math.floor(flowCoord), flowProgress=smoothstep(0,1,flowCoord-flowIndex)
        const flowA=hash(flowIndex*18.31+row*37.17,19283.173),flowB=hash((flowIndex+1)*18.31+row*37.17,19283.173)
        const cluster=smoothstep(.46,.84,mix(flowA,flowB,flowProgress)), phase=(nx+easedFlow+row*.06+bh*.02)*Math.PI*2
        const direction=Math.max(cluster,Math.pow(.5+.5*Math.cos(phase),5)*.62), flowing=Math.max(irregular*(.48+direction*.58),direction*(.38+bh*.28))
        const glow=reveal<.995?Math.exp(-((nx-frontier)**2)/.012)*(1-smoothstep(.7,1,reveal)):0, light=Math.max(flowing,glow*(.4+bh*.4))
        const peakOn=light>.4&&irregular>.16&&cycleHash>.26&&cluster>.04, hottest=light>.68&&irregular>.3&&cycleHash>.48&&cluster>.12
        const hi=peakOn?.97:clamp(light*(.44+cycleHash*.3),0,.64)
        const drift=bh*.28+depth*.28+progress*.38+easedFlow*.18+cycleHash*.2+Math.sin(elapsed*.00135+ph*Math.PI*2)*.14
        const tonePos=((drift%1)+1)%1*tones.length, ti=Math.floor(tonePos), tm=tonePos-ti, a=tones[ti],b=tones[(ti+1)%tones.length]
        const nudge=(ch-.5)*10+depth*12, varied=[clamp(mix(a[0],b[0],tm)+nudge*.35-depth*8,140,196),clamp(mix(a[1],b[1],tm)-depth*16+(bh-.5)*8,104,168),clamp(mix(a[2],b[2],tm)+depth*6+(cycleHash-.5)*6,182,216)]
        const base=[mix(left[0],varied[0],purple),mix(left[1],varied[1],purple),mix(left[2],varied[2],purple)], color=hottest?mixColor(base,peak,.95):mixColor(base,highlight,hi)
        ctx.globalAlpha=(peakOn||hottest?revealAlpha*intensity:revealAlpha*intensity*clamp(.7+bh*.2+flowing*.12,0,1)); ctx.fillStyle=`rgb(${color[0]} ${color[1]} ${color[2]})`; ctx.fillRect(x+gap*.5,y+gap*.5,cell-gap,cell-gap)
      }
      ctx.restore();ctx.globalAlpha=1
    }
    const drawCodex = (time: number, staticFrame: boolean) => {
      const dt=staticFrame?0:Math.min(.032,Math.max(0,(time-(last||time))/1000));last=time;const sec=time/1000
      ctx.fillStyle='#fff'
      for(const p of particles){p.x-=p.flow*dt;if(p.x < -3)p.x+=width+6;const s=.5+.5*Math.sin(staticFrame?p.phase*3:sec*p.twinkle+p.phase);ctx.globalAlpha=.06+.74*s*s;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fill()}
      ctx.globalAlpha=1
    }
    const paint = (time:number, staticFrame=false) => {
      const state=stateRef.current
      if(state.highest!==previousHighest){previousHighest=state.highest;revealStarted=time}
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);confettiCtx.setTransform(dpr,0,0,dpr,0,0);confettiCtx.clearRect(0,0,width+64,height+80)
      if(state.style==='claude')drawClaude(time,state)
      if(state.style==='magnetic')drawCodex(time,staticFrame)
      if(state.burstKey!==seenBurst){seenBurst=state.burstKey;if(!motion.matches&&width){confettiLast=time;const ratio=state.count<2?0:state.position/(state.count-1),x=16+ratio*(width-32)+32,y=height/2+40;const colors=['#C9B0F0','#BFA5F2','#D4C3F7','#B79EF5'];for(let i=0;i<14;i++){const angle=i/14*Math.PI*2+(Math.random()-.5)*.35,speed=105+Math.random()*45;confetti.push({x:x+Math.cos(angle)*17,y:y+Math.sin(angle)*17,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed-25,size:4.5+Math.random(),life:0,ttl:.2+Math.random()*.08,color:colors[i%4]})}}}
      if(confetti.length){const dt=Math.min(.032,Math.max(0,(time-confettiLast)/1000));confettiLast=time;for(const p of confetti){p.life+=dt;if(p.life>=p.ttl)continue;const damp=Math.exp(-6*dt);p.vx*=damp;p.vy=p.vy*damp-20*dt;p.x+=p.vx*dt;p.y+=p.vy*dt;confettiCtx.globalAlpha=Math.pow(1-p.life/p.ttl,1.5);confettiCtx.fillStyle=p.color;confettiCtx.beginPath();confettiCtx.arc(p.x,p.y,p.size/2,0,Math.PI*2);confettiCtx.fill()}confetti=confetti.filter(p=>p.life<p.ttl);confettiCtx.globalAlpha=1}
      if(!staticFrame&&!motion.matches&&!document.hidden&&(state.style==='magnetic'||(state.style==='claude'&&state.highest)))raf=requestAnimationFrame((t)=>paint(t))
      else if(!staticFrame&&confetti.length&&!motion.matches&&!document.hidden)confettiRaf=requestAnimationFrame((t)=>paint(t))
    }
    const draw = (time:number, staticFrame=false) => { cancelAnimationFrame(raf);raf=0;cancelAnimationFrame(confettiRaf);confettiRaf=0;paint(time,staticFrame) }
    redrawRef.current = (time) => draw(time, true)
    const start=()=>{cancelAnimationFrame(raf);cancelAnimationFrame(confettiRaf);raf=0;confettiRaf=0;last=0;draw(performance.now())}
    refresh=()=>{const state=stateRef.current;if(motion.matches){draw(performance.now(),true);return}if(state.style==='magnetic'||(state.style==='claude'&&state.highest)){if(!raf)start();return}cancelAnimationFrame(raf);raf=0;draw(performance.now(),true)}
    const visibility=()=>{if(document.hidden){cancelAnimationFrame(raf);cancelAnimationFrame(confettiRaf);raf=confettiRaf=0}else start()}
    const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(resize):null
    observer?.observe(host);if(!observer)window.addEventListener('resize',resize);document.addEventListener('visibilitychange',visibility);motion.addEventListener?.('change',start)
    resize();refresh()
    redrawRef.current=refresh
    return()=>{cancelAnimationFrame(raf);cancelAnimationFrame(confettiRaf);redrawRef.current=()=>undefined;observer?.disconnect();if(!observer)window.removeEventListener('resize',resize);document.removeEventListener('visibilitychange',visibility);motion.removeEventListener?.('change',start)}
  },[style])
  useEffect(()=>{redrawRef.current(performance.now())},[position,highest,count,burstKey])

  const fraction=count<2?0:position/(count-1)
  const codexColors=codexGradientAt(Math.round(position),count)
  const stopPosition=(ratio:number)=>style==='magnetic'?`calc(${ratio*100}% + ${16-ratio*32}px)`:`${ratio*100}%`
  const fillWidth=style==='magnetic'?`calc(${fraction*100}% + ${32-fraction*32}px)`:`${fraction*100}%`
  return <div className={`session-effort-track ${style} ${highest?'highest':''} ${snapping?(style==='claude'?'springing':'snapping'):''}`} style={{'--effort-position':`${fraction*100}%`,'--effort-fill-width':fillWidth,'--meter-codex-start':codexRgb(codexColors[0]),'--meter-codex-middle':codexRgb(codexColors[1]),'--meter-codex-end':codexRgb(codexColors[2])} as CSSProperties}>
    <canvas ref={canvasRef} className="session-effort-canvas" aria-hidden="true"/><canvas ref={confettiRef} className="session-effort-confetti" aria-hidden="true"/><span className="session-effort-fill" aria-hidden="true"/>
    {Array.from({length:count},(_,index)=><i key={index} className="session-effort-tick" style={{left:stopPosition(count<2?0:index/(count-1))}} aria-hidden="true"/>)}
    <span className="session-effort-knob" style={{left:stopPosition(fraction)}} aria-hidden="true"/>
    <input className="session-effort-range" type="range" min={0} max={Math.max(0,count-1)} step="any" value={position} aria-label="Conversation effort" aria-valuemin={0} aria-valuemax={Math.max(0,count-1)} aria-valuenow={Math.round(position)} aria-valuetext={selectedLabel||defaultLabel} disabled={disabled} onChange={(event:ChangeEvent<HTMLInputElement>)=>onChange(Number(event.currentTarget.value))} onPointerMove={onPointerMove} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onLostPointerCapture={onLostPointerCapture} onKeyDown={onKeyDown} onKeyUp={onKeyUp}/>
  </div>
}
function clamp(n:number,a:number,b:number){return Math.min(b,Math.max(a,n))}
function smoothstep(a:number,b:number,x:number){const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t)}
function hash(value:number,scale:number){return Math.abs(Math.sin(value)*scale)%1}
function mix(a:number,b:number,t:number){return a+(b-a)*t}
function mixColor(a:number[],b:number[],t:number){return [mix(a[0],b[0],t),mix(a[1],b[1],t),mix(a[2],b[2],t)].map(Math.round)}
