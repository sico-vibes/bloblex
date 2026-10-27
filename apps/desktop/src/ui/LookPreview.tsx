import { useEffect, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import type { ThemeStyle } from './appearance'
import { LookAvatar, LOOKS } from './LookPicker'
import './lookPicker.css'

const ROSTER = ['Atlas', 'Pixel', 'Nova'] as const

/**
 * A miniature app window in one look. It is self-contained (its own tokens,
 * scoped to `.sp-window`) so both looks can be on screen at once, whatever the
 * document is currently wearing. The avatar is the real character renderer.
 */
function PreviewWindow({ look, active }: { look: ThemeStyle; active: boolean }) {
  const [phase, setPhase] = useState<0 | 1>(0)
  useEffect(() => {
    if (!active) { setPhase(0); return }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setPhase(1); return }
    let next: 0 | 1 = 0
    setPhase(0)
    const timer = window.setInterval(() => { next = next === 0 ? 1 : 0; setPhase(next) }, 2400)
    return () => window.clearInterval(timer)
  }, [active])
  const name = LOOKS.find((item) => item.id === look)?.name ?? look
  return <div className="sp-window" data-look={look} data-active={active ? 'true' : 'false'} aria-hidden={!active}>
    <div className="sp-titlebar"><i /><i /><i /><span>{name}</span></div>
    <div className="sp-body">
      <aside className="sp-side">
        <span className="sp-label">Your agents</span>
        {ROSTER.map((item, index) => <div key={item} className={`sp-row ${index === 0 ? 'on' : ''}`}>
          <span className="sp-row-avatar"><LookAvatar look={look} size={22} mini mood={index === 0 && phase === 0 ? 'thinking' : 'idle'} /></span><span>{item}</span>
        </div>)}
      </aside>
      <section className="sp-main">
        <div className="sp-bubble user">Fix the failing test in the parser</div>
        <div className="sp-reply">
          <span className="sp-reply-avatar"><LookAvatar look={look} size={34} mood={phase === 0 ? 'thinking' : 'success'} /></span>
          <div className={`sp-bubble bot ${phase === 0 ? 'typing' : 'done'}`}>
            {phase === 0
              ? <span className="sp-dots"><b /><b /><b /></span>
              : <span>Found it. The tokenizer skipped a closing quote, so I fixed it and the suite passes.</span>}
          </div>
        </div>
        <div className="sp-composer"><span>Ask anything</span><b className="sp-send"><ArrowUp size={12} /></b></div>
      </section>
    </div>
  </div>
}

/** The preview that opens when a look is chosen. Both windows stay mounted so switching cross-fades. */
export function LookPreview({ look }: { look: ThemeStyle | null }) {
  const previewName = look ? LOOKS.find((item) => item.id === look)?.name : undefined
  return <div className="look-preview" data-open={look ? 'true' : 'false'} role="img" aria-label={previewName ? `Preview of the ${previewName} look` : undefined} aria-hidden={look ? undefined : true}>
    <div className="look-preview-inner">
      <div className="look-preview-stage">
        <PreviewWindow look="haze" active={look === 'haze'} />
        <PreviewWindow look="blobots" active={look === 'blobots'} />
      </div>
    </div>
  </div>
}
