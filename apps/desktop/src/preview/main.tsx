// Development-only wardrobe comparison sheet at /preview.html.
import { useEffect, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { BlobEngine, hexToRGB } from '../blob/blobEngine'
import { OUTFITS, OUTFIT_LABELS, resolveOutfit, type Outfit } from '../blob/outfit'
import '../ui/theme.css'

const colors = [
  { name: 'Pearl', value: '#e6e9ee' },
  { name: 'Sky', value: '#7db6ff' },
  { name: 'Rose', value: '#ff9bd0' },
]
const orientations = [
  { label: 'Left', yaw: -0.5, pitch: 0, dx: 0.6, dy: 0, tilt: 0 },
  { label: 'Front', yaw: 0, pitch: 0, dx: 0, dy: 0, tilt: 0 },
  { label: 'Right', yaw: 0.5, pitch: 0, dx: -0.6, dy: 0, tilt: 0 },
  { label: 'Up', yaw: 0.15, pitch: 0.4, dx: 0, dy: 0.4, tilt: 0 },
  { label: 'Down', yaw: -0.2, pitch: -0.5, dx: 0, dy: -0.4, tilt: 0 },
  { label: 'Tilt', yaw: 0.3, pitch: -0.25, dx: -0.3, dy: 0, tilt: 0.12 },
]
const sheetSize = 190
const smallSize = 64
const renderScale = 0.46

function PreviewBlob({ color, outfit, orientation, size }: {
  color: string
  outfit: Outfit
  orientation: typeof orientations[number]
  size: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size * ratio
    canvas.height = size * ratio
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.translate(size / 2, size / 2)
    ctx.scale(renderScale, renderScale)
    ctx.translate(-size / 2, -size / 2)
    const engine = new BlobEngine()
    engine.bodyColor = hexToRGB(color)
    engine.outfit = outfit === 'auto' ? resolveOutfit('auto') : outfit
    engine.yaw = orientation.yaw
    engine.pitch = orientation.pitch
    engine.hatLagX = orientation.dx
    engine.hatLagY = orientation.dy
    engine.tilt = orientation.tilt
    engine.draw(ctx, size, size)
  }, [color, outfit, orientation, size])
  return <canvas ref={ref} width={size} height={size} style={{ width: size, height: size }} aria-hidden="true" />
}

function OutfitSheet() {
  return <main style={{ minHeight: '100vh', padding: 20, color: 'var(--text-1)', background: 'var(--surface-app)', fontFamily: 'system-ui, sans-serif' }}>
    <header style={{ marginBottom: 18 }}>
      <p style={{ margin: '0 0 4px', color: 'var(--text-3)', fontSize: 'var(--fs-xs)' }}>Bloblex · outfit renderer</p>
      <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl)', fontWeight: 600 }}>Wardrobe sheet</h1>
      <p style={{ margin: '6px 0 0', color: 'var(--text-2)', fontSize: 'var(--fs-sm)' }}>Left, front, right, up, down and tilt. Auto today: {OUTFIT_LABELS[resolveOutfit('auto')]}. Last column uses the small reference scale.</p>
    </header>
    {colors.map((color) => <section key={color.value} aria-label={`${color.name} wardrobe`} style={{ marginBottom: 30 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 'var(--fs-md)', fontWeight: 600 }}>{color.name}</h2>
      <div style={{ width: 'min(100%, 1360px)', overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `94px repeat(${orientations.length}, ${sheetSize}px) ${smallSize}px`, gap: 6, marginBottom: 4, alignItems: 'end' }}>
          <span />
          {orientations.map((item) => <span key={item.label} style={{ color: 'var(--text-3)', fontSize: 'var(--fs-2xs)', textAlign: 'center' }}>{item.label}</span>)}
          <span style={{ color: 'var(--text-3)', fontSize: 'var(--fs-2xs)', textAlign: 'center' }}>Small</span>
        </div>
        {OUTFITS.map((choice) => {
          const outfit = choice === 'auto' ? resolveOutfit('auto') : choice
          return <div key={choice} style={{ display: 'grid', gridTemplateColumns: `94px repeat(${orientations.length}, ${sheetSize}px) ${smallSize}px`, gap: 6, margin: '5px 0', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-2)', fontSize: 'var(--fs-xs)', textAlign: 'right' }}>{choice === 'auto' ? `Auto · ${OUTFIT_LABELS[outfit]}` : OUTFIT_LABELS[choice]}</span>
            {orientations.map((orientation) => <div key={orientation.label} style={{ display: 'grid', placeItems: 'center', width: sheetSize, height: sheetSize, border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-panel)' }}>
              <PreviewBlob color={color.value} outfit={outfit} orientation={orientation} size={sheetSize} />
            </div>)}
            <div style={{ display: 'grid', placeItems: 'center', width: smallSize, height: smallSize, border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-panel)' }}>
              <PreviewBlob color={color.value} outfit={outfit} orientation={orientations[1]} size={smallSize} />
            </div>
          </div>
        })}
      </div>
    </section>)}
  </main>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<OutfitSheet />)
