import { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../ui/theme.css'
import '../ui/styles.css'
import '../ui/shell.css'
import '../ui/companion.css'
import { DictationIsland, type IslandPhase } from '../ui/DictationIsland'

// Browser preview of the dictation island: a live loop that behaves like a real
// session (the model warms up, words arrive, then it transcribes and finishes),
// and every state side by side. ?state=<phase> shows one state only.

const WORDS = 'Ask Fluffy to check which model Gogo is running and report back with the effort level too'.split(' ')

function LiveIsland({ variant }: { variant: 'bubble' | 'companion' }) {
  const [tick, setTick] = useState(0)
  const [since, setSince] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => (value + 1) % 60), 160)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => { if (tick === 0) setSince(Date.now()) }, [tick])
  const warming = tick < 10
  const spoken = tick < 10 ? 0 : Math.min(WORDS.length, Math.floor((tick - 10) / 1.7))
  const phase: IslandPhase = tick < 40 ? 'listening' : tick < 48 ? 'processing' : 'done'
  const level = phase === 'listening' ? 0.02 + Math.abs(Math.sin(tick * 1.7)) * (spoken ? 0.22 : 0.05) : 0
  return <DictationIsland variant={variant} phase={phase} level={level} since={since} stoppedAt={phase === 'listening' ? null : since + 40 * 160} warming={warming} text={WORDS.slice(0, spoken).join(' ')} />
}

const STATES: Array<{ label: string; phase: IslandPhase; text?: string; warming?: boolean; errorText?: string }> = [
  { label: 'Listening, model loading', phase: 'listening', warming: true },
  { label: 'Listening', phase: 'listening' },
  { label: 'Listening with words', phase: 'listening', text: 'Ask Fluffy to check which model Gogo is running' },
  { label: 'Transcribing', phase: 'processing', text: 'Ask Fluffy to check which model Gogo is running and report back' },
  { label: 'Done', phase: 'done', text: 'Ask Fluffy to check which model Gogo is running' },
  { label: 'Nothing heard', phase: 'silent' },
  { label: 'Error', phase: 'error', errorText: 'No microphone is available. Check Windows sound settings.' },
]

function Preview() {
  const only = new URLSearchParams(location.search).get('state')
  const since = Date.now() - 7000
  if (only === 'live') return <main className="dictation-preview single"><LiveIsland variant="bubble" /></main>
  return <main className="dictation-preview">
    <h1>Dictation</h1>
    <section><h2>Live</h2><div className="dictation-preview-row"><div className="dictation-preview-desktop"><LiveIsland variant="bubble" /></div><div className="dictation-preview-companion"><LiveIsland variant="companion" /></div></div></section>
    <section><h2>Bubble states</h2><div className="dictation-preview-grid">{STATES.filter((state) => !only || state.phase === only).map((state) => <figure key={state.label}><div className="dictation-preview-desktop"><DictationIsland phase={state.phase} level={0.12} since={since} stoppedAt={state.phase === 'listening' ? null : since + 7000} text={state.text ?? ''} warming={state.warming} errorText={state.errorText} /></div><figcaption>{state.label}</figcaption></figure>)}</div></section>
    <section><h2>Companion</h2><div className="dictation-preview-grid">{STATES.slice(1, 5).map((state) => <figure key={state.label}><div className="dictation-preview-companion"><DictationIsland variant="companion" phase={state.phase} level={0.12} since={since} stoppedAt={state.phase === 'listening' ? null : since + 7000} text={state.text ?? ''} /></div><figcaption>{state.label}</figcaption></figure>)}</div></section>
  </main>
}

const style = document.createElement('style')
style.textContent = `
  body { margin: 0; background: var(--bg-app, #0d0d0d); color: var(--text-1); font-family: var(--font-ui, system-ui); }
  .dictation-preview { padding: 28px; display: grid; gap: 28px; }
  .dictation-preview.single { min-height: 100vh; padding: 0; place-items: end center; }
  .dictation-preview h1 { margin: 0; font-size: 20px; } .dictation-preview h2 { margin: 0 0 12px; color: var(--text-2); font-size: 13px; font-weight: 600; }
  .dictation-preview-row, .dictation-preview-grid { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-end; }
  .dictation-preview figure { margin: 0; display: grid; gap: 8px; } .dictation-preview figcaption { color: var(--text-3); font-size: 12px; }
  .dictation-preview-desktop { width: 480px; height: 150px; padding-bottom: 10px; display: flex; align-items: flex-end; justify-content: center; border-radius: 14px; background: radial-gradient(circle at 30% 20%, #2b3a55, #141a24 70%); }
  .dictation-preview-companion { width: 420px; padding: 12px; border-radius: 18px; background: var(--companion-surface, #101010); border: 1px solid #ffffff1a; }
`
document.head.append(style)
ReactDOM.createRoot(document.getElementById('root')!).render(<Preview />)
