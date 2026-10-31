// Development-only inspector at /inspector.html: every screen and state of the frontend, opened in the real
// app with fixture data. Pick a look, a theme and a window size, compare side by side, and leave a note on
// any state; Copy notes gives them back as one list.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../../ui/theme.css'
import './inspector.css'
import { GROUPS, SCENARIOS, type Scenario, type Step } from './scenarios'

type Look = { style: 'haze' | 'blobots'; theme: 'dark' | 'light' }
type Compare = 'off' | 'looks' | 'themes'
type Note = { text?: string; reviewed?: boolean }
type CheckResult = { id: string; ok: boolean; detail: string }

const NOTES_KEY = 'bitbots.inspector.notes'
const PREFS_KEY = 'bitbots.inspector.prefs'
const SIZES = { fit: 'Fit the pane', 1600: '1600 wide', 1280: '1280 wide', 1024: '1024 wide', 800: '800 wide', 600: '600 wide', 390: 'Phone, 390' } as const
type SizeId = keyof typeof SIZES

function load<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? { ...fallback, ...JSON.parse(raw) as T } : fallback } catch { return fallback }
}
function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Notes need browser storage; Copy notes still shows them. */ }
}

function scenarioUrl(scenario: Scenario, look: Look, extra = ''): string {
  const [path, hash] = scenario.url.split('#')
  const joiner = path.includes('?') ? '&' : '?'
  const app = /^\/(\?|$)/.test(path)
  const clean = !app ? '' : scenario.raw ? '&no-intro' : '&no-intro&clean'
  return `${path}${joiner}style=${look.style}&theme=${look.theme}${clean}${extra}${hash ? `#${hash}` : ''}`
}

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
async function until<T>(read: () => T | null | undefined | false, ms: number): Promise<T | null> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > end) return null
    await wait(120)
  }
}
const byText = (doc: Document, text: string) => {
  const shown = [...doc.querySelectorAll<HTMLElement>('button, [role="button"], [role="menuitem"], a, summary')].filter((element) => element.getClientRects().length > 0)
  return shown.find((element) => element.textContent?.trim().startsWith(text)) ?? shown.find((element) => element.textContent?.includes(text))
}

/** Clicks and typing inside a scenario's frame, so a state only a person's action reaches opens by itself. */
async function runSteps(frame: HTMLIFrameElement, steps: readonly Step[]): Promise<string | null> {
  const doc = () => frame.contentDocument
  for (const step of steps) {
    if ('click' in step) {
      const element = await until(() => doc()?.querySelector<HTMLElement>(step.click), 8000)
      if (!element) return `no element ${step.click}`
      element.click()
    } else if ('clickText' in step) {
      const element = await until(() => { const current = doc(); return current ? byText(current, step.clickText) : null }, 8000)
      if (!element) return `nothing to click called "${step.clickText}"`
      element.click()
    } else if ('hover' in step) {
      const element = await until(() => doc()?.querySelector<HTMLElement>(step.hover), 8000)
      if (!element) return `no element ${step.hover}`
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    } else {
      const [selector, text] = step.type
      const element = await until(() => doc()?.querySelector<HTMLTextAreaElement>(selector), 8000)
      if (!element) return `no field ${selector}`
      const win = frame.contentWindow as (Window & typeof globalThis) | null
      const proto = win?.HTMLTextAreaElement.prototype ?? HTMLTextAreaElement.prototype
      element.focus()
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, text)
      element.setSelectionRange(text.length, text.length)
      element.dispatchEvent(new (win?.Event ?? Event)('input', { bubbles: true }))
    }
    await wait(250)
  }
  return null
}

function Frame({ scenario, look, width, label, reloadKey }: { scenario: Scenario; look: Look; width: SizeId; label?: string; reloadKey: number }) {
  const host = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [box, setBox] = useState({ width: 1000, height: 700 })
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    const element = host.current
    if (!element) return
    const observer = new ResizeObserver(() => setBox({ width: element.clientWidth, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const own = scenario.size
  const frameWidth = width === 'fit' ? (own?.[0] ?? Math.max(box.width, 1100)) : Number(width)
  // Fit fills the pane; a chosen width keeps the pane's shape, so the window is as tall as it can be.
  const frameHeight = own && width === 'fit' ? own[1] : Number(width) === 390 ? 844 : Math.round(frameWidth * Math.max(box.height, 200) / Math.max(box.width, 200))
  const scale = Math.min(1, box.width / frameWidth, box.height / frameHeight)
  const src = scenarioUrl(scenario, look)
  return <div className="ins-frame-cell">
    {label && <div className="ins-frame-label">{label}</div>}
    <div className="ins-frame-host" ref={host}>
      {problem && <p className="ins-step-problem" role="alert">This state didn't open by itself: {problem}</p>}
      <div className="ins-frame-box" style={{ width: frameWidth * scale, height: frameHeight * scale }}>
        <iframe key={`${src}|${reloadKey}`} ref={frame} title={label ? `${scenario.title}, ${label}` : scenario.title} src={src} width={frameWidth} height={frameHeight} style={{ transform: scale < 1 ? `scale(${scale})` : undefined }}
          onLoad={() => { setProblem(null); if (scenario.steps && frame.current) void runSteps(frame.current, scenario.steps).then(setProblem) }} />
      </div>
    </div>
  </div>
}

/** Opens every scenario, runs its steps and looks for its text. It proves each one really reaches its state. */
async function checkAll(look: Look, onResult: (result: CheckResult) => void, stop: () => boolean) {
  const queue = [...SCENARIOS]
  const worker = async () => {
    for (;;) {
      const scenario = queue.shift()
      if (!scenario || stop()) return
      const frame = document.createElement('iframe')
      const size = scenario.size ?? [1280, 800]
      frame.width = String(size[0]); frame.height = String(size[1])
      frame.className = 'ins-check-frame'
      const errors: string[] = []
      await new Promise<void>((resolve) => { frame.onload = () => resolve(); window.setTimeout(resolve, 25_000); frame.src = scenarioUrl(scenario, look); document.body.append(frame) })
      const win = frame.contentWindow as (Window & typeof globalThis) | null
      win?.addEventListener('error', (event) => errors.push(event.message))
      win?.addEventListener('unhandledrejection', (event) => errors.push(String((event as PromiseRejectionEvent).reason)))
      const rendered = await until(() => { const body = frame.contentDocument?.body; return body && (body.innerText ?? '').trim().length > 0 }, 15_000)
      const stepProblem = scenario.steps ? await runSteps(frame, scenario.steps) : null
      const wanted = scenario.expect
      const found = wanted ? await until(() => (frame.contentDocument?.body?.innerText ?? '').includes(wanted), 8000) : true
      await wait(300)
      const crashed = !!frame.contentDocument?.querySelector('[data-error-boundary], .error-boundary')
      const detail = [!rendered && 'blank page', stepProblem, wanted && !found && `no "${wanted}"`, crashed && 'an error screen', ...errors.slice(0, 2)].filter(Boolean).join('; ')
      onResult({ id: scenario.id, ok: !detail, detail })
      frame.remove()
    }
  }
  await Promise.all([worker(), worker(), worker()])
}

function Inspector() {
  const [prefs, setPrefs] = useState(() => load(PREFS_KEY, { style: 'haze' as Look['style'], theme: 'dark' as Look['theme'], width: 'fit' as SizeId, compare: 'off' as Compare }))
  const [notes, setNotes] = useState<Record<string, Note>>(() => load(NOTES_KEY, {}))
  const [query, setQuery] = useState('')
  const [currentId, setCurrentId] = useState(() => { const id = location.hash.slice(1); return SCENARIOS.some((item) => item.id === id) ? id : SCENARIOS[0].id })
  const [reloadKey, setReloadKey] = useState(0)
  const [copied, setCopied] = useState<string | null>(null)
  const [checks, setChecks] = useState<Record<string, CheckResult>>({})
  const [checking, setChecking] = useState(false)
  const stopCheck = useRef(false)
  const list = useRef<HTMLElement>(null)

  const updatePrefs = (next: Partial<typeof prefs>) => setPrefs((current) => { const merged = { ...current, ...next }; save(PREFS_KEY, merged); return merged })
  const updateNote = (id: string, next: Note) => setNotes((current) => { const merged = { ...current, [id]: { ...current[id], ...next } }; save(NOTES_KEY, merged); return merged })

  const needle = query.trim().toLowerCase()
  const groups = useMemo(() => GROUPS.map((group) => ({ ...group, scenarios: group.scenarios.filter((item) => !needle || `${group.title} ${item.title} ${item.note ?? ''}`.toLowerCase().includes(needle)) })).filter((group) => group.scenarios.length), [needle])
  const flat = useMemo(() => groups.flatMap((group) => group.scenarios), [groups])
  const current = SCENARIOS.find((item) => item.id === currentId) ?? SCENARIOS[0]
  const reviewed = SCENARIOS.filter((item) => notes[item.id]?.reviewed).length
  const noted = SCENARIOS.filter((item) => notes[item.id]?.text?.trim()).length

  const go = useCallback((id: string) => { setCurrentId(id); history.replaceState(null, '', `#${id}`) }, [])
  const step = useCallback((by: number) => {
    const index = flat.findIndex((item) => item.id === currentId)
    const next = flat[Math.min(flat.length - 1, Math.max(0, index + by))]
    if (next) go(next.id)
  }, [flat, currentId, go])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.key === 'ArrowDown' || event.key === 'j') { event.preventDefault(); step(1) }
      if (event.key === 'ArrowUp' || event.key === 'k') { event.preventDefault(); step(-1) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [step])
  useEffect(() => { list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' }) }, [currentId])
  useEffect(() => {
    const follow = () => { const id = location.hash.slice(1); if (SCENARIOS.some((item) => item.id === id)) setCurrentId(id) }
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])

  const look: Look = { style: prefs.style, theme: prefs.theme }
  const frames: Array<{ look: Look; label?: string }> = prefs.compare === 'looks'
    ? [{ look: { ...look, style: 'haze' }, label: 'Haze' }, { look: { ...look, style: 'blobots' }, label: 'Stone' }]
    : prefs.compare === 'themes'
      ? [{ look: { ...look, theme: 'dark' }, label: 'Dark' }, { look: { ...look, theme: 'light' }, label: 'Light' }]
      : [{ look }]

  const notesText = () => {
    const rows = SCENARIOS.filter((item) => notes[item.id]?.text?.trim()).map((item) => `- **${item.group.title} › ${item.title}** (\`${item.id}\`): ${notes[item.id].text!.trim()}`)
    return rows.length ? `# Frontend notes\n\n${rows.join('\n')}\n` : ''
  }
  const copyNotes = async () => {
    const text = notesText()
    if (!text) { setCopied('No notes yet.'); return }
    try { await navigator.clipboard.writeText(text); setCopied(`Copied ${noted} note${noted === 1 ? '' : 's'}.`) } catch { setCopied(text) }
  }
  const runCheck = async () => {
    setChecks({}); setChecking(true); stopCheck.current = false
    await checkAll(look, (result) => setChecks((value) => ({ ...value, [result.id]: result })), () => stopCheck.current)
    setChecking(false)
  }
  const checkCount = Object.keys(checks).length
  const failed = Object.values(checks).filter((item) => !item.ok)
  useEffect(() => { (window as unknown as { __inspector?: unknown }).__inspector = { checks, checking, total: SCENARIOS.length, run: runCheck } })

  return <div className="ins-app" data-theme={prefs.theme}>
    <nav className="ins-index" aria-label="Screens and states" ref={list}>
      <header>
        <h1>Bitbots inspector</h1>
        <p>{SCENARIOS.length} states · {reviewed} reviewed · {noted} noted</p>
        <input type="search" value={query} placeholder="Search" aria-label="Search states" onChange={(event) => setQuery(event.target.value)} />
      </header>
      {groups.map((group) => <section key={group.id} aria-label={group.title}>
        <h2>{group.title}<span>{group.scenarios.filter((item) => notes[item.id]?.reviewed).length}/{group.scenarios.length}</span></h2>
        <ul>{group.scenarios.map((item) => {
          const result = checks[item.id]
          return <li key={item.id}><button type="button" aria-current={item.id === current.id ? 'true' : undefined} onClick={() => go(item.id)}>
            <i className={notes[item.id]?.reviewed ? 'done' : ''} aria-hidden="true" />
            <span>{item.title}</span>
            {notes[item.id]?.text?.trim() && <em title="Has a note">note</em>}
            {result && !result.ok && <b title={result.detail}>!</b>}
          </button></li>
        })}</ul>
      </section>)}
      {!groups.length && <p className="ins-none">Nothing matches that.</p>}
    </nav>

    <main className="ins-main">
      <div className="ins-bar" role="toolbar" aria-label="How to show this state">
        <Choice label="Look" value={prefs.style} options={[['haze', 'Haze'], ['blobots', 'Stone']]} onChange={(style) => updatePrefs({ style: style as Look['style'] })} disabled={prefs.compare === 'looks'} />
        <Choice label="Theme" value={prefs.theme} options={[['dark', 'Dark'], ['light', 'Light']]} onChange={(theme) => updatePrefs({ theme: theme as Look['theme'] })} disabled={prefs.compare === 'themes'} />
        <Choice label="Side by side" value={prefs.compare} options={[['off', 'Off'], ['looks', 'Looks'], ['themes', 'Themes']]} onChange={(compare) => updatePrefs({ compare: compare as Compare })} />
        <label className="ins-size">Window
          <select value={String(prefs.width)} onChange={(event) => updatePrefs({ width: event.target.value as SizeId })}>{Object.entries(SIZES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        </label>
        <span className="ins-spacer" />
        <button type="button" onClick={() => setReloadKey((value) => value + 1)}>Reload</button>
        <a href={scenarioUrl(current, look)} target="_blank" rel="noreferrer">Open alone</a>
        <button type="button" disabled={checking} onClick={() => void runCheck()}>{checking ? `Checking ${checkCount}/${SCENARIOS.length}` : checkCount ? `${checkCount - failed.length}/${checkCount} pass · Check all` : 'Check all'}</button>
      </div>

      <div className={`ins-stage${frames.length > 1 ? ' two' : ''}`}>
        {frames.map((frame) => <Frame key={frame.label ?? 'one'} scenario={current} look={frame.look} width={prefs.width} label={frame.label} reloadKey={reloadKey} />)}
      </div>

      <footer className="ins-foot">
        <div className="ins-about">
          <small>{current.group.title}</small>
          <strong>{current.title}</strong>
          <p>{current.note ?? current.group.description}</p>
          {checks[current.id] && !checks[current.id].ok && <p className="ins-step-problem">Check: {checks[current.id].detail}</p>}
        </div>
        <label className="ins-note">Your note on this state
          <textarea rows={3} value={notes[current.id]?.text ?? ''} placeholder="What's wrong, or what you'd change" onChange={(event) => updateNote(current.id, { text: event.target.value })} />
        </label>
        <div className="ins-actions">
          <button type="button" aria-pressed={!!notes[current.id]?.reviewed} onClick={() => updateNote(current.id, { reviewed: !notes[current.id]?.reviewed })}>{notes[current.id]?.reviewed ? 'Reviewed ✓' : 'Mark reviewed'}</button>
          <button type="button" onClick={() => step(1)}>Next ↓</button>
          <button type="button" className="primary" onClick={() => void copyNotes()}>Copy all notes</button>
          {copied && (copied.length > 60 ? <textarea className="ins-copy-fallback" readOnly value={copied} aria-label="Your notes, to copy" /> : <span role="status">{copied}</span>)}
        </div>
      </footer>
    </main>
  </div>
}

function Choice({ label, value, options, onChange, disabled }: { label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void; disabled?: boolean }) {
  return <div className="ins-choice" role="group" aria-label={label}>
    <span>{label}</span>
    {options.map(([id, text]) => <button key={id} type="button" disabled={disabled} aria-pressed={value === id} onClick={() => onChange(id)}>{text}</button>)}
  </div>
}

document.documentElement.dataset.theme = 'dark'
ReactDOM.createRoot(document.getElementById('root')!).render(<Inspector />)
