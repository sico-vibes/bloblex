// Development-only character sheet at /preview.html: every art style in every
// art mood at three sizes, plus all twelve painted bodies. `?art=painted`
// narrows it to one art.
import ReactDOM from 'react-dom/client'
import { BlobCanvas } from '../blob/BlobCanvas'
import {
  ART_LABELS, ART_MOODS, ART_MOOD_SAMPLE, BOT_ARTS, PAINTED_LABELS, PAINTED_SHAPES, isBotArt,
  type BotArt,
} from '../blob/art/art'
import { MASCOT_LOOK } from '../blob/look'
import '../ui/theme.css'
import '../ui/styles.css'

const query = new URLSearchParams(location.search)
const requested = query.get('art')
const arts: BotArt[] = requested && isBotArt(requested) ? [requested] : [...BOT_ARTS]
const sizes = [22, 44, 96]
const colors = ['#7db6ff', '#ff9bd0', '#9be7c4']
document.documentElement.dataset.theme = query.get('theme') === 'light' ? 'light' : 'dark'

function CharacterSheet() {
  return <main style={{ padding: 24, color: 'var(--text-1)', background: 'var(--bg-1)', minHeight: '100vh' }}>
    <p style={{ margin: '0 0 4px', color: 'var(--text-3)', fontSize: 'var(--fs-xs)' }}>Bitbots · art renderer</p>
    <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl)', fontWeight: 600 }}>Every art, every mood</h1>
    {arts.map((art) => <section key={art} aria-label={ART_LABELS[art]} style={{ marginTop: 22 }}>
      <h2 style={{ fontSize: 'var(--fs-md)', margin: '0 0 8px' }}>{ART_LABELS[art]}</h2>
      {sizes.map((size) => <div key={size} style={{ display: 'flex', alignItems: 'flex-end', gap: 18, padding: '10px 0', borderTop: '1px solid var(--line)' }}>
        <span style={{ width: 40, flex: 'none', color: 'var(--text-3)', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{size}px</span>
        {ART_MOODS.map((mood) => <div key={mood} role="group" aria-label={`${art} ${mood}`} style={{ display: 'grid', justifyItems: 'center', gap: 4 }}>
          <BlobCanvas art={art} color={colors[0]} size={size} mood={ART_MOOD_SAMPLE[mood]} look={{ ...MASCOT_LOOK }} label={`${art} ${mood}`} />
          <span style={{ color: 'var(--text-3)', fontSize: 10 }}>{mood}</span>
        </div>)}
      </div>)}
    </section>)}
    <section aria-label="Painted shapes" style={{ marginTop: 22 }}>
      <h2 style={{ fontSize: 'var(--fs-md)', margin: '0 0 8px' }}>Hand-painted bodies</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}>
        {PAINTED_SHAPES.map((paint, index) => <div key={paint} role="group" aria-label={PAINTED_LABELS[paint]} style={{ display: 'grid', justifyItems: 'center', gap: 4 }}>
          <BlobCanvas art="painted" color={colors[index % colors.length]} size={64} mood="idle" look={{ ...MASCOT_LOOK, art: 'painted', paint }} label={PAINTED_LABELS[paint]} />
          <span style={{ color: 'var(--text-3)', fontSize: 10 }}>{PAINTED_LABELS[paint]}</span>
        </div>)}
      </div>
    </section>
  </main>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<CharacterSheet />)
