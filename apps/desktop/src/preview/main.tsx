// Development-only character sheet: `npm run dev`, then open /preview.html.
// Not referenced by index.html, so it is never part of the production bundle.
import { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { BlobCanvas, type BlobMood } from '../blob/BlobCanvas'
import { hexToRGB } from '../blob/blobEngine'
import { drawGreetingScene } from '../blob/greetingScene'
import { AGENT_SWATCHES, agentColorHex, swatchLabel } from '../ui/agentColor'

const moods: BlobMood[] = ['idle', 'online', 'listening', 'thinking', 'working', 'tool_activity', 'permission', 'success', 'error', 'rate_limited', 'budget_warning', 'sleeping', 'offline', 'file_drop', 'file_preparing', 'file_ready', 'file_sending', 'file_error']
const palette = [
  { name: 'Soft white', color: '#e6e9ee' },
  ...AGENT_SWATCHES.map((swatch) => ({ name: swatchLabel(swatch.key), color: agentColorHex(swatch.key) })),
]

function GreetingFrame({ seconds, color }: { seconds: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    canvas.width = 320 * 2
    canvas.height = 75 * 2
    ctx.setTransform(2, 0, 0, 2, 0, 0)
    drawGreetingScene(ctx, 320, 75, seconds * 1000, hexToRGB(color))
  }, [seconds, color])
  return <figure style={{ margin: 0 }}><canvas ref={ref} style={{ width: 320, height: 75, background: '#000', borderRadius: 12 }} /><figcaption style={{ color: '#fcfcfc99', fontSize: 11 }}>{seconds.toFixed(2)} s</figcaption></figure>
}

function Preview() {
  const [color, setColor] = useState(palette[0].color)
  const [mood, setMood] = useState<BlobMood>('idle')
  const [greetKey, setGreetKey] = useState(0)
  return <main style={{ minHeight: '100vh', margin: 0, padding: 24, background: '#070707', color: '#fcfcfc', font: '13px system-ui, Segoe UI, sans-serif' }}>
    <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
      {palette.map((item) => <button key={item.name} onClick={() => setColor(item.color)} style={{ padding: '6px 12px', borderRadius: 999, border: '1px solid #333', background: item.color === color ? '#2f2f2f' : 'transparent', color: 'inherit' }}>{item.name}</button>)}
      <button onClick={() => setGreetKey((key) => key + 1)} style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 999, border: '1px solid #333', background: 'transparent', color: 'inherit' }}>Replay welcome</button>
    </div>
    <section style={{ width: 640, padding: 0, borderRadius: 22, background: '#000', marginBottom: 24 }}>
      <BlobCanvas key={greetKey} color={color} size={100} greeting label="Welcome" onGreetingComplete={() => undefined} />
    </section>
    <section style={{ display: 'flex', alignItems: 'center', gap: 28, marginBottom: 24 }}>
      <BlobCanvas color={color} size={160} mood={mood} label="Focus" />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxWidth: 640 }}>
        {moods.map((item) => <button key={item} onClick={() => setMood(item)} style={{ padding: '5px 10px', borderRadius: 999, border: '1px solid #333', background: item === mood ? '#1084fe' : '#111', color: 'inherit' }}>{item}</button>)}
      </div>
    </section>
    <section style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 110px)', gap: 14 }}>
      {moods.map((item) => <figure key={item} style={{ margin: 0, display: 'grid', justifyItems: 'center', gap: 6 }}>
        <BlobCanvas color={color} size={72} mood={item} label={item} />
        <figcaption style={{ color: '#fcfcfc99', fontSize: 11 }}>{item}</figcaption>
      </figure>)}
    </section>
    <section style={{ display: 'flex', gap: 10, marginTop: 24 }}>
      {palette.slice(1).map((item) => <BlobCanvas key={item.name} color={item.color} size={28} mini mood="idle" label={item.name} />)}
    </section>
    <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 320px)', gap: 12, marginTop: 24 }}>
      {[0.2, 0.7, 1.1, 1.385, 1.7, 2.2, 2.5, 2.75, 4.6].map((seconds) => <GreetingFrame key={seconds} seconds={seconds} color={color} />)}
    </section>
  </main>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Preview />)
