import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { placeTooltip } from './tooltipPosition'
import './providerBrand.css'

const providerAssets = import.meta.glob('../assets/providers/*.{svg,png,webp}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const brands = {
  claude: { name: 'Claude Code', mark: 'C', file: 'claude' },
  codex: { name: 'Codex', mark: 'O', file: 'codex' },
  openai: { name: 'Codex', mark: 'O', file: 'codex' },
  opencode: { name: 'OpenCode', mark: 'O', file: 'opencode' },
  'opencode-go': { name: 'OpenCode', mark: 'O', file: 'opencode' },
  'opencode-zen': { name: 'OpenCode', mark: 'O', file: 'opencode' },
  anthropic: { name: 'Claude Code', mark: 'C', file: 'claude' },
} as const

export function providerBrand(provider: string) {
  const key = provider.toLowerCase()
  return brands[key as keyof typeof brands] ?? { name: provider || 'Coding agent', mark: (provider || '?').slice(0, 1).toUpperCase(), file: '' }
}

export function ProviderLogo({ provider, size = 18 }: { provider: string; size?: number }) {
  const brand = providerBrand(provider)
  const light = document.documentElement.dataset.theme === 'light'
  const entries = Object.entries(providerAssets)
  const themed = entries.find(([path]) => path.toLowerCase().endsWith(`/providers/${brand.file}-${light ? 'light' : 'dark'}.svg`))?.[1]
  const entry = themed ?? entries.find(([path]) => path.toLowerCase().endsWith(`/providers/${brand.file}.svg`))?.[1]
  const style = { width: size, height: size, '--provider-logo-size': `${size}px` } as CSSProperties
  return <span className={`provider-logo${entry ? ' has-image' : ''}`} style={style} aria-hidden="true">{entry ? <img className="provider-logo-image" src={entry} width={size} height={size} alt="" /> : <span>{brand.mark}</span>}</span>
}

/** A blob's coding-agent logo before its name, with a tooltip naming the runtime (experimental). */
export function RuntimeMark({ provider, size = 14 }: { provider: string | null | undefined; size?: number }) {
  if (!provider) return null
  const name = providerBrand(provider).name
  return <RuntimeMarkTip provider={provider} name={name} size={size} />
}

function RuntimeMarkTip({ provider, name, size }: { provider: string; name: string; size: number }) {
  const id = useId()
  const root = useRef<HTMLSpanElement>(null)
  const tooltip = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [point, setPoint] = useState({ left: 0, top: 0 })
  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = root.current?.getBoundingClientRect()
      if (!rect) return
      const box = tooltip.current?.getBoundingClientRect()
      const next = placeTooltip(rect, { width: box?.width || 160, height: box?.height || 28 }, 'bottom')
      setPoint({ left: next.left, top: next.top })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  return <span ref={root} className="runtime-mark-tip" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false) }}>
    <span className="runtime-mark" role="img" aria-label={`Runs on ${name}`} aria-describedby={open ? id : undefined} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); event.currentTarget.blur() } }}><ProviderLogo provider={provider} size={size} /></span>
    {open && createPortal(<span ref={tooltip} id={id} className="runtime-mark-tooltip-portal" role="tooltip" style={{ left: point.left, top: point.top }}>Runs on {name}</span>, document.body)}
  </span>
}
