// Development-only comparison sheet at /preview.html.
import { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { BlobEngine, hexToRGB } from '../blob/blobEngine'
import { OUTFITS, OUTFIT_LABELS, resolveOutfit, type Outfit } from '../blob/outfit'
import '../ui/theme.css'
import '../ui/styles.css'

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark'

const colors = [
  { name: 'Pearl', value: '#e6e9ee' },
  { name: 'Sky', value: '#7db6ff' },
  { name: 'Rose', value: '#ff9bd0' },
]
const orientations = [
  { label: 'Left', yaw: -0.58, pitch: 0, dx: 0.6, dy: 0, tilt: 0 },
  { label: 'Front', yaw: 0, pitch: 0, dx: 0, dy: 0, tilt: 0 },
  { label: 'Right', yaw: 0.58, pitch: 0, dx: -0.6, dy: 0, tilt: 0 },
]
const sizes = [64, 96, 144, 192]

function PreviewBlob({ color, outfit, orientation, size, badgeActive }: {
  color: string
  outfit: Outfit
  orientation: typeof orientations[number]
  size: number
  badgeActive: boolean
}) {
  return <canvas ref={(canvas) => {
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size * ratio
    canvas.height = size * ratio
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    const engine = new BlobEngine()
    engine.bodyColor = hexToRGB(color)
    engine.outfit = outfit === 'auto' ? resolveOutfit('auto') : outfit
    if (badgeActive) engine.setState('approval', { silent: true })
    engine.yaw = orientation.yaw
    engine.pitch = orientation.pitch
    engine.hatLagX = orientation.dx
    engine.hatLagY = orientation.dy
    engine.tilt = orientation.tilt
    engine.draw(ctx, size, size)
  }} width={size} height={size} style={{ width: size, height: size, display: 'block' }} aria-hidden="true" />
}

function OutfitSheet() {
  const query = new URLSearchParams(location.search)
  const initialOrientation = query.get('view')
  const focusOutfit = query.get('outfit')
  const badgeActive = query.get('badge') === 'approval'
  const outfitChoices = OUTFITS.filter((outfit) => !focusOutfit || outfit === focusOutfit)
  const [view, setView] = useState(() => orientations.find((orientation) => orientation.label.toLowerCase() === initialOrientation) ?? orientations[1])
  const setOrientation = (orientation: typeof orientations[number]) => {
    setView(orientation)
    query.set('view', orientation.label.toLowerCase())
    history.replaceState(null, '', `?${query.toString()}`)
  }
  const columns = `94px ${sizes.map((size) => `${size}px`).join(' ')}`
  return <main style={{ minHeight: '100vh', padding: 24, color: 'var(--text-1)', background: 'var(--surface-app)', fontFamily: 'system-ui, sans-serif' }}>
    <header style={{ maxWidth: 940, margin: '0 auto 20px' }}>
      <p style={{ margin: '0 0 4px', color: 'var(--text-3)', fontSize: 'var(--fs-xs)' }}>Bloblex · outfit renderer</p>
      <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl)', fontWeight: 600 }}>Wardrobe comparison</h1>
      <p style={{ margin: '6px 0 12px', color: 'var(--text-2)', fontSize: 'var(--fs-sm)' }}>Every outfit in three blob colours and four rendered sizes. Change the view to inspect the 3D projection.</p>
      <div role="group" aria-label="Blob rotation" style={{ display: 'flex', gap: 8 }}>
        {orientations.map((orientation) => <button key={orientation.label} type="button" className="secondary-button small" aria-pressed={view.label === orientation.label} onClick={() => setOrientation(orientation)}>{orientation.label}</button>)}
      </div>
    </header>
    {colors.map((color) => <section key={color.value} aria-label={`${color.name} outfits`} style={{ maxWidth: 940, margin: '0 auto 26px' }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 'var(--fs-md)', fontWeight: 600 }}>{color.name}</h2>
      <div style={{ width: '100%', overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: columns, gap: 8, marginBottom: 5, alignItems: 'end' }}>
          <span />{sizes.map((size) => <span key={size} style={{ color: 'var(--text-3)', fontSize: 'var(--fs-2xs)', textAlign: 'center' }}>{size}px</span>)}
        </div>
        {outfitChoices.map((choice) => {
          const outfit = choice === 'auto' ? resolveOutfit('auto') : choice
          return <div key={`${color.value}:${choice}`} style={{ display: 'grid', gridTemplateColumns: columns, gap: 8, margin: '5px 0', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-2)', fontSize: 'var(--fs-xs)', textAlign: 'right' }}>{choice === 'auto' ? `Auto · ${OUTFIT_LABELS[outfit]}` : OUTFIT_LABELS[choice]}</span>
            {sizes.map((size) => <div key={size} style={{ display: 'grid', placeItems: 'center', width: size, height: size, border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-panel)' }}>
              <PreviewBlob color={color.value} outfit={outfit} orientation={view} size={size} badgeActive={badgeActive} />
            </div>)}
          </div>
        })}
      </div>
    </section>)}
  </main>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<OutfitSheet />)
