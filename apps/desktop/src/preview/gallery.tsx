// Development-only gallery at /gallery.html: every surface that needs the
// desktop app (launch, companion, import, settings, characters), rendered from
// fixtures in frames sized like the real windows, so it can be reviewed in a
// browser before shipping.
import { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../ui/theme.css'
import '../ui/styles.css'

const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark'
document.documentElement.dataset.theme = theme

interface Frame { label: string; src: string; width: number; height: number; note?: string }
interface Section { id: string; title: string; description: string; frames: Frame[]; scale?: number; desktop?: boolean }

const t = theme === 'light' ? '&theme=light' : ''
const SECTIONS: Section[] = [
  {
    id: 'launch', title: 'Launch', scale: 0.62,
    description: 'Startup checks scroll inside a fixed window that fades into the background. The mascot works while Bloblex scans, then waves once everything is ready.',
    frames: [
      { label: 'Live: scan, then wave', src: `/launch-preview.html?fixture=live${t}`, width: 1100, height: 720, note: 'Replays from the start each time it finishes.' },
      { label: 'Scanning', src: `/launch-preview.html?fixture=in-progress${t}`, width: 1100, height: 720 },
      { label: 'Service down', src: `/launch-preview.html?fixture=service-down${t}`, width: 1100, height: 720 },
    ],
  },
  {
    id: 'companion', title: 'Companion',
    description: 'The floating island on a simulated desktop, at its real window sizes: the compact bar, the mini team overview, chat with team chips and mentions, team activity, and in-island settings.',
    frames: [
      { label: 'Compact bar', src: `/?companion${t}`, width: 560, height: 200 },
      { label: 'Overview', src: `/?companion&mode=home${t}`, width: 760, height: 300 },
      { label: 'Chat', src: `/?companion&mode=home&view=chat${t}`, width: 760, height: 400 },
      { label: 'Activity', src: `/?companion&mode=home&view=activity${t}`, width: 760, height: 400 },
      { label: 'Settings', src: `/?companion&mode=home&view=settings${t}`, width: 760, height: 300 },
    ],
  },
  {
    id: 'import', title: 'Import a blob', scale: 0.62,
    description: 'Importing a shared blob file: a preview of the blob in its own shape and colour, what comes with it, and which coding agent it runs on.',
    frames: [{ label: 'Import dialog', src: `/?preview-import${t}`, width: 1100, height: 760 }],
  },
  {
    id: 'settings', title: 'Settings', scale: 0.62,
    description: 'General settings, including the Experimental section with the usage bar switch and its explanation on hover.',
    frames: [{ label: 'General', src: `/?preview-settings${t}`, width: 1100, height: 760 }],
  },
  {
    id: 'characters', title: 'Characters', scale: 0.7,
    description: 'Every blob shape in every state, drawn by the same engine as the app.',
    frames: [{ label: 'Shape sheet', src: `/preview.html?size=72${t}`, width: 1000, height: 900 }],
  },
]

function FrameCard({ frame, scale = 1, desktop }: { frame: Frame; scale?: number; desktop?: boolean }) {
  const [key, setKey] = useState(0)
  return <figure className="gallery-frame">
    <figcaption>
      <strong>{frame.label}</strong>
      <span>{frame.width}×{frame.height}</span>
      <button type="button" onClick={() => setKey((value) => value + 1)}>Reload</button>
      <a href={frame.src} target="_blank" rel="noreferrer">Open</a>
    </figcaption>
    <div className={`gallery-viewport${desktop ? ' desktop' : ''}`} style={{ width: frame.width * scale + (desktop ? 48 : 0), height: frame.height * scale + (desktop ? 48 : 0) }}>
      <iframe key={key} title={frame.label} src={frame.src} width={frame.width} height={frame.height} style={{ transform: scale === 1 ? undefined : `scale(${scale})` }} />
    </div>
    {frame.note && <small>{frame.note}</small>}
  </figure>
}

function Gallery() {
  return <div className="gallery">
    <style>{`
      body { margin: 0; background: var(--surface-app); color: var(--text-1); font-family: var(--font-ui, system-ui, sans-serif); }
      .gallery { max-width: 1240px; margin: 0 auto; padding: 32px 24px 64px; }
      .gallery > header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
      .gallery h1 { margin: 0; font-size: 26px; font-weight: 600; }
      .gallery > header p { margin: 4px 0 0; color: var(--text-2); font-size: 14px; }
      .gallery nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 16px 0 8px; position: sticky; top: 0; z-index: 5; padding: 10px 0; background: var(--surface-app); }
      .gallery nav a { padding: 5px 11px; color: var(--text-2); border: 1px solid var(--line); border-radius: 999px; font-size: 13px; text-decoration: none; }
      .gallery nav a:hover { color: var(--text-1); border-color: var(--line-strong); }
      .gallery section { padding: 28px 0 8px; border-top: 1px solid var(--line); margin-top: 20px; }
      .gallery section h2 { margin: 0; font-size: 19px; font-weight: 600; }
      .gallery section > p { max-width: 720px; margin: 6px 0 18px; color: var(--text-2); font-size: 14px; line-height: 1.5; }
      .gallery-frames { display: flex; flex-wrap: wrap; gap: 22px; align-items: flex-start; }
      .gallery-frame { margin: 0; display: grid; gap: 8px; }
      .gallery-frame figcaption { display: flex; align-items: center; gap: 10px; font-size: 13px; }
      .gallery-frame figcaption span { color: var(--text-3); font-variant-numeric: tabular-nums; }
      .gallery-frame figcaption button, .gallery-frame figcaption a { padding: 2px 8px; color: var(--text-2); border: 1px solid var(--line); border-radius: 7px; background: transparent; font: inherit; font-size: 12px; text-decoration: none; cursor: pointer; }
      .gallery-frame small { color: var(--text-3); font-size: 12px; }
      .gallery-viewport { position: relative; overflow: hidden; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-app); }
      .gallery-viewport iframe { position: absolute; top: 0; left: 0; border: 0; transform-origin: 0 0; background: transparent; }
      .gallery-viewport.desktop { border-radius: 14px; background: radial-gradient(120% 120% at 20% 0%, #3b3f73 0%, #1b1d2e 55%, #0e0f16 100%); }
      .gallery-viewport.desktop iframe { top: 24px; left: 24px; }
    `}</style>
    <header>
      <div><h1>Bloblex preview gallery</h1><p>Fixture data, rendered in the browser. Nothing here talks to a daemon or a coding agent.</p></div>
      <a href={theme === 'light' ? '?' : '?theme=light'} style={{ color: 'var(--text-2)', fontSize: 13 }}>{theme === 'light' ? 'Dark theme' : 'Light theme'}</a>
    </header>
    <nav aria-label="Sections">{SECTIONS.map((section) => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}</nav>
    {SECTIONS.map((section) => <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
      <h2 id={`${section.id}-title`}>{section.title}</h2>
      <p>{section.description}</p>
      <div className="gallery-frames">{section.frames.map((frame) => <FrameCard key={frame.src} frame={frame} scale={section.scale} desktop={section.desktop} />)}</div>
    </section>)}
  </div>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Gallery />)
