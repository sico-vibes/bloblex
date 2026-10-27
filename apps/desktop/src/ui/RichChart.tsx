import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Table2 } from 'lucide-react'
import { formatNumber, niceTicks, type ChartSpec } from './richData'
import './richBlocks.css'

const W = 640
const LEFT = 48
const RIGHT = 14
const TOP = 12
const BOTTOM = 30
const MAX_THICKNESS = 24
const FOCUSABLE_LIMIT = 24
const ROW_LIMIT = 40

/** A column or bar with a 4px rounded data end and a square baseline. */
function barPath(x: number, base: number, tip: number, width: number, horizontal: boolean): string {
  const r = Math.min(4, width / 2, Math.abs(tip - base))
  if (!horizontal) {
    const up = tip < base
    const sign = up ? 1 : -1
    return `M${x},${base} L${x},${tip + sign * r} Q${x},${tip} ${x + r},${tip} L${x + width - r},${tip} Q${x + width},${tip} ${x + width},${tip + sign * r} L${x + width},${base} Z`
  }
  const right = tip > base
  const sign = right ? -1 : 1
  return `M${base},${x} L${tip + sign * r},${x} Q${tip},${x} ${tip},${x + r} L${tip},${x + width - r} Q${tip},${x + width} ${tip + sign * r},${x + width} L${base},${x + width} Z`
}

/**
 * A declarative chart drawn as plain SVG from validated data. Hover or focus any category for every series' value;
 * "Data" shows the same numbers as a table, so nothing depends on seeing colour or using a pointer.
 */
export function RichChart({ spec, label, embedded = false }: { spec: ChartSpec; label: string; embedded?: boolean }) {
  const id = useId()
  const wrapper = useRef<HTMLDivElement | null>(null)
  const [active, setActive] = useState<number | null>(null)
  const [data, setData] = useState(false)
  const horizontal = spec.kind === 'bar' && spec.categories.length > 12
  const shown = horizontal ? Math.min(spec.categories.length, ROW_LIMIT) : spec.categories.length
  const multi = spec.series.length > 1

  const geometry = useMemo(() => {
    const values = spec.series.flatMap((series) => series.values.slice(0, shown).filter((value): value is number => value !== null))
    const pool = values.length ? values : [0]
    const lo = Math.min(...pool)
    const hi = Math.max(...pool)
    const ticks = niceTicks(spec.kind === 'bar' ? Math.min(0, lo) : lo, spec.kind === 'bar' ? Math.max(0, hi) : hi)
    const min = ticks[0]!
    const max = ticks[ticks.length - 1]!
    const labelLeft = horizontal ? 96 : LEFT
    const height = horizontal ? TOP + shown * 26 + 28 : 252
    const plotW = W - labelLeft - RIGHT
    const plotH = height - TOP - BOTTOM
    const scale = (value: number) => (horizontal ? labelLeft + ((value - min) / (max - min || 1)) * plotW : TOP + plotH - ((value - min) / (max - min || 1)) * plotH)
    return { ticks, min, max, labelLeft, height, plotW, plotH, scale }
  }, [spec, shown, horizontal])
  const { ticks, min, labelLeft, height, plotW, plotH, scale } = geometry
  const band = horizontal ? plotH / shown : plotW / shown
  const centre = (index: number) => (horizontal ? TOP + band * (index + 0.5) : labelLeft + band * (index + 0.5))
  const zero = scale(Math.max(min, Math.min(0, geometry.max)))
  const thickness = Math.min(MAX_THICKNESS, (band * 0.72 - (spec.series.length - 1) * 2) / spec.series.length)
  const every = Math.max(1, Math.ceil(56 / Math.max(band, 1)))
  const unit = spec.unit

  const summary = useMemo(() => {
    const first = spec.series.find((series) => series.values.some((value) => value !== null)) ?? spec.series[0]!
    const pairs = first.values.map((value, index) => ({ value, name: spec.categories[index] ?? '' })).filter((pair): pair is { value: number; name: string } => pair.value !== null)
    const top = pairs.reduce<{ value: number; name: string } | null>((best, pair) => (!best || pair.value > best.value ? pair : best), null)
    return `${spec.kind === 'line' ? 'Line' : 'Bar'} chart${spec.title ? ` of ${spec.title}` : ''}, ${spec.categories.length} categories, ${spec.series.length} series.${top ? ` ${first.name} peaks at ${formatNumber(top.value, { unit })} for ${top.name}.` : ''}`
  }, [spec])

  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (!box.width) return
    const fraction = horizontal ? (event.clientY - box.top) / box.height : (event.clientX - box.left) / box.width
    const position = horizontal ? fraction * height : fraction * W
    const index = Math.floor((position - (horizontal ? TOP : labelLeft)) / band)
    setActive(index >= 0 && index < shown ? index : null)
  }
  const onKey = (event: KeyboardEvent, index: number) => {
    if (event.key === 'Escape') setActive(null)
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = Math.max(0, Math.min(shown - 1, index + step))
    setActive(next)
    wrapper.current?.querySelector<SVGElement>(`[data-index="${next}"]`)?.focus()
  }
  const focusable = shown <= FOCUSABLE_LIMIT
  const rowLabel = (index: number) => `${spec.categories[index]}: ${spec.series.map((series) => `${series.name} ${series.values[index] === null ? 'no value' : formatNumber(series.values[index]!, { unit })}`).join(', ')}`

  const tipLeft = active === null ? 0 : horizontal ? 50 : (centre(active) / W) * 100
  const tipTop = active === null ? 0 : horizontal ? (centre(active) / height) * 100 : 8
  const flip = tipLeft > 62

  return <figure className={`rich-block rich-chart${embedded ? ' embedded' : ''}`} aria-label={label}>
    {!embedded && <header className="rich-head">
      <div className="rich-title">{spec.title ? <strong>{spec.title}</strong> : <span>Chart</span>}<small>{spec.categories.length} {spec.categories.length === 1 ? 'category' : 'categories'}{spec.truncated ? ' (first 200)' : ''}</small></div>
      <div className="rich-tools"><button type="button" className="rich-tool" aria-pressed={data} onClick={() => setData((value) => !value)}><Table2 size={13} aria-hidden="true" />{data ? 'Chart' : 'Data'}</button></div>
    </header>}
    {multi && <ul className="rich-legend" aria-label="Series">{spec.series.map((series, index) => <li key={index}><i className={`rich-key s${index + 1} ${spec.kind}`} aria-hidden="true" />{series.name}</li>)}</ul>}
    {data && !embedded ? <div className="rich-scroll" tabIndex={0} role="region" aria-label={`${label}, data`}><table>
      <thead><tr><th scope="col">{spec.title ?? 'Category'}</th>{spec.series.map((series, index) => <th key={index} scope="col" className="rich-num">{series.name}</th>)}</tr></thead>
      <tbody>{spec.categories.map((category, row) => <tr key={row}><th scope="row">{category}</th>{spec.series.map((series, index) => <td key={index} className="rich-num">{series.values[row] === null ? <span className="rich-empty" aria-label="no value">–</span> : formatNumber(series.values[row]!, { unit })}</td>)}</tr>)}</tbody>
    </table></div> : <div className="rich-plot" ref={wrapper} onPointerLeave={() => setActive(null)}>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-labelledby={`${id}-summary`} onPointerMove={pick} onPointerDown={pick}>
        <title id={`${id}-summary`}>{summary}</title>
        {ticks.map((tick) => {
          const at = scale(tick)
          return horizontal
            ? <g key={tick}><line className="rich-grid" x1={at} x2={at} y1={TOP} y2={TOP + plotH} /><text className="rich-axis" x={at} y={height - 10} textAnchor="middle">{formatNumber(tick, { compact: true })}</text></g>
            : <g key={tick}><line className="rich-grid" x1={labelLeft} x2={W - RIGHT} y1={at} y2={at} /><text className="rich-axis" x={labelLeft - 8} y={at + 4} textAnchor="end">{formatNumber(tick, { compact: true })}</text></g>
        })}
        {Array.from({ length: shown }, (_, index) => {
          const name = spec.categories[index] ?? ''
          if (horizontal) return <text key={index} className="rich-axis" x={labelLeft - 8} y={centre(index) + 4} textAnchor="end">{name.length > 14 ? `${name.slice(0, 13)}…` : name}</text>
          return index % every === 0 ? <text key={index} className="rich-axis" x={centre(index)} y={height - 10} textAnchor="middle">{name.length > 10 ? `${name.slice(0, 9)}…` : name}</text> : null
        })}
        {active !== null && spec.kind === 'line' && <line className="rich-cross" x1={centre(active)} x2={centre(active)} y1={TOP} y2={TOP + plotH} />}
        {active !== null && spec.kind === 'bar' && <rect className="rich-band" x={horizontal ? labelLeft : centre(active) - band / 2} y={horizontal ? centre(active) - band / 2 : TOP} width={horizontal ? plotW : band} height={horizontal ? band : plotH} />}
        {spec.kind === 'bar' && spec.series.map((series, s) => series.values.slice(0, shown).map((value, index) => {
          if (value === null) return null
          const offset = (s - (spec.series.length - 1) / 2) * (thickness + 2) - thickness / 2
          const start = centre(index) + offset
          return <g key={`${s}-${index}`}>
            <path className={`rich-mark s${s + 1}${active === index ? ' on' : ''}`} d={barPath(start, zero, scale(value), thickness, horizontal)} />
            {!multi && shown <= 8 && !horizontal && <text className="rich-value" x={start + thickness / 2} y={value >= 0 ? scale(value) - 5 : scale(value) + 13} textAnchor="middle">{formatNumber(value, { compact: true })}</text>}
          </g>
        }))}
        {spec.kind === 'line' && spec.series.map((series, s) => {
          const points = series.values.slice(0, shown).map((value, index) => (value === null ? null : [centre(index), scale(value)] as const))
          const segments: string[] = []
          let current = ''
          for (const point of points) {
            if (!point) { if (current) segments.push(current); current = ''; continue }
            current += `${current ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)} `
          }
          if (current) segments.push(current)
          return <g key={s}>
            {segments.map((d, index) => <path key={index} className={`rich-line s${s + 1}`} d={d} />)}
            {points.map((point, index) => (point && (active === index || shown <= 24) ? <circle key={index} className={`rich-dot s${s + 1}${active === index ? ' on' : ''}`} cx={point[0]} cy={point[1]} r={active === index ? 5 : 4} /> : null))}
          </g>
        })}
        {Array.from({ length: shown }, (_, index) => <rect
          key={index} data-index={index} className="rich-hit"
          x={horizontal ? labelLeft : centre(index) - band / 2} y={horizontal ? centre(index) - band / 2 : TOP}
          width={horizontal ? plotW : band} height={horizontal ? band : plotH}
          {...(focusable ? { tabIndex: index === 0 || active === index ? 0 : -1, role: 'img', 'aria-label': rowLabel(index), onFocus: () => setActive(index), onBlur: () => setActive((value) => (value === index ? null : value)), onKeyDown: (event: KeyboardEvent) => onKey(event, index) } : { 'aria-hidden': true })} />)}
      </svg>
      {active !== null && <div className={`rich-tip${flip ? ' flip' : ''}`} style={{ left: `${tipLeft}%`, top: `${tipTop}%` }} role="status">
        <small>{spec.categories[active]}</small>
        {spec.series.map((series, index) => <div key={index}><i className={`rich-key s${index + 1} ${spec.kind}`} aria-hidden="true" /><strong>{series.values[active] === null ? 'No value' : formatNumber(series.values[active]!, { unit })}</strong>{multi && <span>{series.name}</span>}</div>)}
      </div>}
    </div>}
    {spec.caption && <figcaption>{spec.caption}</figcaption>}
    {spec.truncated && <p className="rich-note">Only the first 200 categories are drawn.</p>}
    {horizontal && spec.categories.length > ROW_LIMIT && <p className="rich-note">Showing the first {ROW_LIMIT} of {spec.categories.length} bars. The table view lists every row.</p>}
  </figure>
}
