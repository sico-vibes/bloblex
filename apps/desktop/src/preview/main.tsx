// Development-only character sheet at /preview.html: every look silhouette in
// several colours and states, animated by the real engine.
import { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { BlobCanvas, type BlobMood } from '../blob/BlobCanvas'
import { BLOB_SHAPES, MASCOT_LOOK, SHAPE_LABELS, type BlobLook } from '../blob/look'
import '../ui/theme.css'
import '../ui/styles.css'

const query = new URLSearchParams(location.search)
// The shape sheet defaults to the classic renderer, independent of saved app preferences.
const style = query.get('style') === 'bitbots' ? 'bitbots' : 'blobots'
document.documentElement.dataset.theme = query.get('theme') === 'light' ? 'light' : 'dark'
document.documentElement.dataset.style = style
if (style === 'bitbots') document.documentElement.dataset.bitbots = 'on'
else delete document.documentElement.dataset.bitbots

const colors = ['#e6e9ee', '#7db6ff', '#ff9bd0', '#9be7c4', '#f6c26b', '#2b2f3a']
const moods: BlobMood[] = ['idle', 'working', 'thinking', 'permission', 'success', 'sleeping', 'file_drop', 'error']
const seeds = ['ada', 'grace', 'linus', 'margaret']

function LookSheet() {
  const [mood, setMood] = useState<BlobMood>((query.get('mood') as BlobMood | null) ?? 'idle')
  const size = Number(query.get('size')) || 88
  return <main style={{ padding: 24, color: 'var(--text-1)', background: 'var(--bg-1)', minHeight: '100vh' }}>
    <p style={{ margin: '0 0 4px', color: 'var(--text-3)', fontSize: 'var(--fs-xs)' }}>Bitbots · look renderer</p>
    <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl)', fontWeight: 600 }}>Eight symmetric shapes</h1>
    <div style={{ display: 'flex', gap: 6, margin: '12px 0 20px', flexWrap: 'wrap' }}>
      {moods.map((item) => <button key={item} type="button" className={`ghost-button small${item === mood ? ' active' : ''}`} aria-pressed={item === mood} onClick={() => setMood(item)}>{item}</button>)}
    </div>
    <section aria-label="Mascot" style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 'var(--fs-md)', margin: '0 0 8px' }}>Mascot</h2>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>{colors.map((color) => <BlobCanvas key={color} style={style} color={color} size={size} mood={mood} look={MASCOT_LOOK} label="Mascot" />)}</div>
    </section>
    {BLOB_SHAPES.filter((shape) => !query.get('shape') || query.get('shape') === shape).map((shape, row) => <section key={shape} aria-label={SHAPE_LABELS[shape]} style={{ marginBottom: 18 }}>
      <h2 style={{ fontSize: 'var(--fs-md)', margin: '0 0 8px' }}>{SHAPE_LABELS[shape]}</h2>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {seeds.map((seed, index) => {
          const look: BlobLook = { shape, seed }
          return <BlobCanvas key={seed} style={style} color={colors[(row + index) % colors.length]} size={size} mood={mood} look={look} label={`${shape} ${seed}`} />
        })}
      </div>
    </section>)}
  </main>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<LookSheet />)
