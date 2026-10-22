// Development-only design study at /redesign-preview.html: three candidate
// directions for the primary (Bitbots) look, drawn from fixtures. Nothing here
// is wired into the app; it exists so the owner can compare directions before
// one is applied.
import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import {
  ArrowUp, AtSign, Bell, Check, ChevronDown, ChevronRight, ChartColumn, Clock, Cpu, Download, Ellipsis, FileText,
  FolderGit2, GitBranch, Hourglass, Keyboard, Lock, Mic, Monitor, Moon, PanelRight, Palette, Paperclip, Pencil, Play,
  Plus, RefreshCw, Search, Settings, ShieldCheck, SlidersHorizontal, Smartphone, Square, SquarePen, Star, Sun, Terminal,
  Users, X, Zap,
} from 'lucide-react'
import { BlobCanvas, type BlobMood } from '../blob/BlobCanvas'
import type { BlobShape } from '../blob/look'
import { PAINTED_SHAPES, PaintedBot, paintedLabel, type PaintedShape } from './paintedBots'
import './redesign.css'

// BlobCanvas pulls in the app's look store, which marks <html> for the pixel
// theme; this page styles itself, so clear those markers.
delete document.documentElement.dataset.bitbots
delete document.documentElement.dataset.style

type StyleId = 'pop' | 'dot' | 'frost' | 'blob'
type Skin = 'painted' | 'glossy'
type Mode = 'light' | 'dark'
type Screen = 'chat' | 'settings' | 'usage' | 'companion' | 'characters'
type Mood = 'idle' | 'working' | 'waiting' | 'sleeping'

const STYLES: { id: StyleId; letter: string; name: string; note: string; mode: Mode }[] = [
  { id: 'pop', letter: 'A', name: 'Pop', note: 'Retro colour, outlined cards, sticker labels', mode: 'light' },
  { id: 'dot', letter: 'B', name: 'Dot', note: 'Monochrome widgets, dot-matrix numbers, one red', mode: 'dark' },
  { id: 'frost', letter: 'C', name: 'Frost', note: 'A see-through window over your desktop, flat and quiet', mode: 'dark' },
  { id: 'blob', letter: 'D', name: 'Blobots', note: 'The current alternative look, with hand-painted bots', mode: 'dark' },
]
const SCREENS: { id: Screen; label: string }[] = [
  { id: 'chat', label: 'Conversation' },
  { id: 'settings', label: 'Settings' },
  { id: 'usage', label: 'Usage' },
  { id: 'companion', label: 'Companion' },
  { id: 'characters', label: 'Characters' },
]

interface BotData { id: string; name: string; role: string; color: string; line: string; mood: Mood; time: string; group: string; paint: PaintedShape; classic: BlobShape; manager?: boolean; status?: 'waiting' | 'working' }
const BOTS: BotData[] = [
  { id: 'manager', paint: 'star', classic: 'circle', name: 'Manager', role: 'Manager', color: '#f5a25b', line: 'Runs your team and knows every bot', mood: 'idle', time: '', group: '', manager: true },
  { id: 'codex', paint: 'cube', classic: 'squircle', name: 'Codex', role: 'CTO', color: '#8db7f5', line: 'Waiting for you', mood: 'waiting', time: '10:59', group: 'Board', status: 'waiting' },
  { id: 'invoice', paint: 'pear', classic: 'droplet', name: 'Invoice helper', role: 'Finance', color: '#f4c84f', line: 'Typing…', mood: 'working', time: '10:19', group: 'Board', status: 'working' },
  { id: 'pololo', paint: 'flower', classic: 'cloud', name: 'Pololo', role: 'UI/UX Designer', color: '#7fd3ae', line: 'Sol 6.1 · High', mood: 'idle', time: '9:42', group: 'Board' },
  { id: 'claude', paint: 'ghost', classic: 'pebble', name: 'Claude', role: 'Copywriter', color: '#f2958a', line: 'Default agent for Claude', mood: 'sleeping', time: 'Yesterday', group: 'Side projects' },
  { id: 'opencode', paint: 'bunny', classic: 'capsule', name: 'OpenCode', role: 'Researcher', color: '#c2b0f0', line: 'Default agent for OpenCode', mood: 'idle', time: 'Oct 16', group: 'Side projects' },
]
const bot = (id: string) => BOTS.find((item) => item.id === id)!

const StyleContext = createContext<StyleId>('pop')
const SkinContext = createContext<{ skin: Skin; setSkin: (skin: Skin) => void }>({ skin: 'painted', setSkin: () => undefined })
const BLOB_MOOD: Record<Mood, BlobMood> = { idle: 'idle', working: 'working', waiting: 'permission', sleeping: 'sleeping' }

function readQuery() {
  const query = new URLSearchParams(location.search)
  const style = (['pop', 'dot', 'frost', 'blob'] as const).find((id) => id === query.get('style')) ?? 'pop'
  const screen = (['chat', 'settings', 'usage', 'companion', 'characters'] as const).find((id) => id === query.get('screen')) ?? 'chat'
  const mode = query.get('mode') === 'light' || query.get('mode') === 'dark' ? query.get('mode') as Mode : STYLES.find((item) => item.id === style)!.mode
  const wallpaper = (['dusk', 'lake', 'bloom', 'sand'] as const).find((id) => id === query.get('wallpaper')) ?? null
  const glass = (['clear', 'balanced', 'solid'] as const).find((id) => id === query.get('glass')) ?? 'balanced'
  const skin: Skin = query.get('bots') === 'glossy' ? 'glossy' : 'painted'
  return { style, screen, mode, wallpaper, glass, skin }
}

/* ------------------------------------------------------------------ robots */

function Bot({ data, size = 36, mood, badge = true }: { data: BotData; size?: number; mood?: Mood; badge?: boolean }) {
  const style = useContext(StyleContext)
  const { skin } = useContext(SkinContext)
  const current = mood ?? data.mood
  const Head = style === 'pop' ? PopHead : style === 'dot' ? DotHead : FrostHead
  return <span className={`rd-bot mood-${current}`} style={{ width: size, height: size, '--bot': data.color } as CSSProperties} role="img" aria-label={`${data.name}, ${current}`}>
    {style !== 'blob' ? <Head mood={current} />
      : skin === 'painted' ? <PaintedBot shape={data.paint} color={data.color} size={size} mood={current} />
      : <BlobCanvas decorative style="blobots" color={data.color} size={size} mood={BLOB_MOOD[current]} look={{ shape: data.classic, seed: data.id }} />}
    {badge && data.manager && <span className="rd-bot-badge"><Star size={Math.max(8, size * 0.2)} fill="currentColor" strokeWidth={0} /></span>}
  </span>
}

function PopHead({ mood }: { mood: Mood }) {
  return <svg viewBox="0 0 64 64" aria-hidden="true">
    <rect className="pop-shadow" x="9" y="15" width="52" height="45" rx="14" />
    <rect className="pop-ink" x="29" y="5" width="6" height="9" rx="2" />
    <rect className="pop-cap" x="25" y="2" width="14" height="7" rx="3.5" />
    <rect className="pop-ink" x="1" y="28" width="7" height="15" rx="3" />
    <rect className="pop-ink" x="56" y="28" width="7" height="15" rx="3" />
    <rect className="pop-head" x="6" y="12" width="52" height="45" rx="14" />
    <rect className="pop-visor" x="14" y="22" width="36" height="25" rx="8" />
    <rect className="pop-shine" x="18" y="25" width="10" height="3" rx="1.5" />
    <g className="rd-eyes">{mood === 'sleeping'
      ? <><rect className="pop-eye" x="20" y="34" width="9" height="3" rx="1.5" /><rect className="pop-eye" x="35" y="34" width="9" height="3" rx="1.5" /></>
      : <><rect className="pop-eye" x="21" y="28" width="7" height="14" rx="3.5" /><rect className="pop-eye" x="36" y="28" width="7" height="14" rx="3.5" /></>}</g>
  </svg>
}

const DOT_COLS = 7
const DOT_ROWS = 5
const dotX = (col: number) => 14 + col * 6
const dotY = (row: number) => 23 + row * 5.6
function eyeDots(mood: Mood): [number, number][] {
  const dots: [number, number][] = []
  for (const col of [1, 2, 4, 5]) {
    for (let row = 0; row < DOT_ROWS; row += 1) {
      if (mood === 'sleeping') { if (row === 3) dots.push([col, row]); continue }
      if (mood === 'waiting') { if (row <= 2) dots.push([col, row]); continue }
      if (row >= 1 && row <= 3) dots.push([col, row])
    }
  }
  return dots
}
function DotHead({ mood }: { mood: Mood }) {
  const grid: [number, number][] = []
  for (let row = 0; row < DOT_ROWS; row += 1) for (let col = 0; col < DOT_COLS; col += 1) grid.push([col, row])
  return <svg viewBox="0 0 64 64" aria-hidden="true">
    <rect className="dot-ear" x="1" y="28" width="6" height="14" rx="3" />
    <rect className="dot-ear" x="57" y="28" width="6" height="14" rx="3" />
    <rect className="dot-head" x="6" y="10" width="52" height="48" rx="15" />
    <rect className="dot-signal" x="27" y="13.5" width="10" height="3.2" rx="1.6" />
    <g className="dot-grid">{grid.map(([col, row]) => <circle key={`${col}-${row}`} cx={dotX(col)} cy={dotY(row)} r="1.5" />)}</g>
    <g className="rd-eyes dot-lit">{eyeDots(mood).map(([col, row]) => <circle key={`${col}-${row}`} cx={dotX(col)} cy={dotY(row)} r="2.6" />)}</g>
  </svg>
}

function FrostHead({ mood }: { mood: Mood }) {
  return <svg viewBox="0 0 64 64" aria-hidden="true">
    <rect className="frost-ear" x="2" y="28" width="6" height="14" rx="3" />
    <rect className="frost-ear" x="56" y="28" width="6" height="14" rx="3" />
    <rect className="frost-head" x="6" y="11" width="52" height="47" rx="16" />
    <rect className="frost-rim" x="6.75" y="11.75" width="50.5" height="45.5" rx="15.25" />
    <rect className="frost-visor" x="13" y="22" width="38" height="26" rx="9" />
    <g className="rd-eyes frost-eyes">{mood === 'sleeping'
      ? <><rect x="20" y="34" width="9" height="2.6" rx="1.3" /><rect x="35" y="34" width="9" height="2.6" rx="1.3" /></>
      : <><rect x="21" y="28" width="7" height="14" rx="3.5" /><rect x="36" y="28" width="7" height="14" rx="3.5" /></>}</g>
  </svg>
}

function Logo() {
  return <svg className="rd-logo" viewBox="0 0 40 40" aria-hidden="true">
    <rect className="logo-bg" x="0" y="0" width="40" height="40" rx="9" />
    <path className="logo-card" d="M7 13.5c0-3 2.2-5.4 5.2-5.8l17.6-2.4c3.4-.5 6.2 2.1 6.2 5.5V40H7z" />
    <rect className="logo-visor" x="12" y="15" width="19" height="14" rx="4.5" />
    <rect className="logo-eye" x="16" y="18.5" width="3.4" height="7" rx="1.7" />
    <rect className="logo-eye" x="23.4" y="18.5" width="3.4" height="7" rx="1.7" />
  </svg>
}

/* -------------------------------------------------------------- primitives */

function Chip({ tone = 'plain', icon, children }: { tone?: 'plain' | 'warn' | 'ok' | 'info' | 'accent' | 'danger' | 'violet'; icon?: ReactNode; children: ReactNode }) {
  return <span className={`rd-chip tone-${tone}`}>{icon}{children}</span>
}
function Toggle({ on, onChange, label }: { on: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`rd-toggle${on ? ' on' : ''}`} onClick={() => onChange(!on)}><span /></button>
}
function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string; icon?: ReactNode }[]; onChange: (value: T) => void; label: string }) {
  return <div className="rd-seg" role="radiogroup" aria-label={label}>
    {options.map((option) => <button key={option.id} type="button" role="radio" aria-checked={value === option.id} className={value === option.id ? 'on' : ''} onClick={() => onChange(option.id)}>{option.icon}{option.label}</button>)}
  </div>
}
function Meter({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'warn' | 'ok' }) {
  return <span className={`rd-meter tone-${tone}`} role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${value}%` }} /></span>
}
function Sticker({ children, tone = 'accent', tilt = -4 }: { children: ReactNode; tone?: string; tilt?: number }) {
  return <span className={`rd-sticker tone-${tone}`} style={{ '--tilt': `${tilt}deg` } as CSSProperties}>{children}</span>
}

/* ---------------------------------------------------------------- sidebar */

function Sidebar({ screen, setScreen, selected, setSelected }: { screen: Screen; setScreen: (screen: Screen) => void; selected: string; setSelected: (id: string) => void }) {
  const groups = ['Board', 'Side projects']
  const row = (data: BotData) => <button key={data.id} type="button" className={`rd-botrow${selected === data.id && screen === 'chat' ? ' selected' : ''}${data.status ? ` is-${data.status}` : ''}`} onClick={() => { setSelected(data.id); setScreen('chat') }}>
    <Bot data={data} size={38} />
    <span className="rd-botrow-text">
      <span className="rd-botrow-top"><strong>{data.name}</strong><span className="rd-role">{data.role}</span>{data.time && <time>{data.time}</time>}</span>
      <span className="rd-botrow-line">{data.status && <span className={`rd-dot ${data.status}`} />}{data.line}</span>
    </span>
  </button>
  return <aside className="rd-side">
    <div className="rd-brand">
      <Logo />
      <strong>Bitbots</strong>
      <button type="button" className="rd-icon-btn" aria-label="New bot"><Plus size={16} /></button>
    </div>
    <label className="rd-search"><Search size={15} /><input placeholder="Search bots and chats" /><kbd>Ctrl K</kbd></label>
    <div className="rd-botlist">
      {row(bot('manager'))}
      {groups.map((group) => <div key={group} className="rd-group">
        <div className="rd-group-label"><FolderGit2 size={13} />{group}</div>
        {BOTS.filter((item) => item.group === group).map(row)}
      </div>)}
    </div>
    <div className="rd-side-foot">
      <div className="rd-limit">
        <div className="rd-limit-top"><Zap size={13} /><span><b>27%</b> of 5h used</span><time>resets 2d 3h</time></div>
        <Meter value={27} />
      </div>
      <nav className="rd-sidenav" aria-label="Pages">
        <button type="button" className={screen === 'usage' ? 'on' : ''} onClick={() => setScreen('usage')}><ChartColumn size={16} />Usage</button>
        <button type="button" className={screen === 'companion' ? 'on' : ''} onClick={() => setScreen('companion')}><Monitor size={16} />Companion</button>
        <button type="button" className={screen === 'settings' ? 'on' : ''} onClick={() => setScreen('settings')}><Settings size={16} />Settings</button>
      </nav>
      <button type="button" className="rd-profile"><span className="rd-initials">BH</span><span><strong>Bassem</strong><small>Owner · 6 bots</small></span><ChevronDown size={14} /></button>
    </div>
  </aside>
}

/* ------------------------------------------------------------ conversation */

const CONVERSATIONS = [
  { day: 'Today', items: [
    { title: 'Effort picker research', meta: 'Board · 2 bots', state: 'waiting' as const, on: true },
    { title: 'Invoice parser tests', meta: 'Board', state: 'working' as const },
    { title: 'Preview: composer controls', meta: '4m' },
  ] },
  { day: 'Yesterday', items: [
    { title: 'Which model are you?', meta: 'From Pololo' },
    { title: 'Release notes for beta.34', meta: 'Board' },
    { title: 'Tidy the settings copy', meta: 'Side projects' },
  ] },
]

function ChatScreen({ selected }: { selected: string }) {
  const style = useContext(StyleContext)
  const current = bot(selected)
  const [approved, setApproved] = useState<null | 'once' | 'deny'>(null)
  const [activityOpen, setActivityOpen] = useState(true)
  return <div className="rd-chat">
    <section className="rd-convos" aria-label="Conversations">
      <header><h2>Conversations</h2><button type="button" className="rd-icon-btn" aria-label="New conversation"><SquarePen size={15} /></button></header>
      {CONVERSATIONS.map((group) => <div key={group.day} className="rd-convo-group">
        <div className="rd-eyebrow">{group.day}</div>
        {group.items.map((item) => <button key={item.title} type="button" className={`rd-convo${'on' in item && item.on ? ' on' : ''}`}>
          <span className="rd-convo-title">{item.title}</span>
          <span className="rd-convo-meta">{'state' in item && item.state && <span className={`rd-dot ${item.state}`} />}{item.meta}</span>
        </button>)}
      </div>)}
    </section>
    <section className="rd-thread">
      <header className="rd-thread-head">
        <div className="rd-thread-title">
          <strong>{current.name}</strong>
          <Chip>{current.role}</Chip>
          <span className="rd-crumb">Board <ChevronRight size={12} /> Effort picker research <ChevronDown size={13} /></span>
        </div>
        <div className="rd-thread-tools">
          <Chip icon={<ShieldCheck size={13} />}>Auto</Chip>
          <button type="button" className="rd-icon-btn" aria-label="New conversation"><SquarePen size={16} /></button>
          <button type="button" className="rd-icon-btn" aria-label="Details"><PanelRight size={16} /></button>
          <button type="button" className="rd-icon-btn" aria-label="More"><Ellipsis size={16} /></button>
        </div>
      </header>
      <div className="rd-messages">
        <div className="rd-msg user"><div className="rd-bubble">Can you research an effort picker like the one on 21st.dev? <span className="rd-mention"><AtSign size={12} />Pololo</span> is great at UI, ask him to find it.</div><time>10:41</time></div>
        <div className="rd-msg bot">
          <div className="rd-author"><Bot data={current} size={22} mood="idle" /><strong>{current.name}</strong><time>10:41</time></div>
          <div className="rd-bubble">On it. I'm sending Pololo the brief and asking him to hunt down that effort and reasoning-level picker.</div>
          <div className="rd-handoff"><Bot data={bot('pololo')} size={18} mood="working" /><span>Messaged <b>Pololo</b> · Effort picker research</span><ChevronRight size={13} /></div>
        </div>
        <div className="rd-activity">
          <button type="button" className="rd-activity-head" onClick={() => setActivityOpen(!activityOpen)} aria-expanded={activityOpen}>
            <ChevronRight size={14} className="rd-chev" /><span>Worked for 1m 12s</span><span className="rd-activity-sum">Read 4 files · Searched twice · Edited 1 file</span>
          </button>
          {activityOpen && <ul>
            <li><FileText size={13} /><span>Read</span><code>src/ui/ComposerControls.tsx</code></li>
            <li><Search size={13} /><span>Searched</span><code>"reasoning level" in 21st.dev</code></li>
            <li><Pencil size={13} /><span>Edited</span><code>src/ui/effort.tsx</code><em className="rd-diff"><ins>+48</ins><del>−12</del></em></li>
          </ul>}
        </div>
        <div className="rd-msg bot">
          <div className="rd-author"><Bot data={bot('pololo')} size={22} mood="idle" /><strong>Pololo</strong><Chip tone="violet">via Codex</Chip><time>10:43</time></div>
          <div className="rd-bubble">
            <p>Found it. Nothing is a pixel-exact drop-in, but two are close:</p>
            <ul>
              <li><b>PostHog ReasoningLevelDropdown</b> (MIT): Faster ↔ Smarter, notched snaps, a Default badge.</li>
              <li><b>AI Model Select</b> on 21st.dev: effort, context and Fast in one popover.</li>
            </ul>
            <p>My take: fork the first one and borrow the popover layout from the second.</p>
          </div>
        </div>
        <div className="rd-plan">
          {style === 'pop' && <Sticker tone="butter" tilt={-5}>PLAN</Sticker>}
          <div className="rd-plan-head"><div className="rd-eyebrow">Proposed plan</div><strong>Effort picker, three steps</strong></div>
          <ol>
            <li><span>1</span>Vendor the ReasoningLevelDropdown into <code>src/ui/effort/</code>.</li>
            <li><span>2</span>Swap the composer's effort menu for it, keeping keyboard support.</li>
            <li><span>3</span>Add the Fast toggle and a mounted test for each level.</li>
          </ol>
          <div className="rd-plan-actions"><button type="button" className="rd-btn primary"><Check size={15} />Approve plan</button><button type="button" className="rd-btn">Edit steps</button></div>
        </div>
        {approved === null ? <div className="rd-approval" role="group" aria-label="Approval request">
          <div className="rd-approval-icon"><Terminal size={17} /></div>
          <div className="rd-approval-body">
            <strong>Codex wants to run a command</strong>
            <code className="rd-cmd">npm run test -- effort</code>
            <div className="rd-approval-actions">
              <button type="button" className="rd-btn primary" onClick={() => setApproved('once')}>Allow once</button>
              <button type="button" className="rd-btn">Always allow</button>
              <button type="button" className="rd-btn ghost" onClick={() => setApproved('deny')}>Deny</button>
            </div>
          </div>
        </div> : <div className="rd-approved"><Check size={14} />{approved === 'once' ? 'Allowed once: npm run test -- effort' : 'Denied: npm run test -- effort'}<button type="button" onClick={() => setApproved(null)}>Undo</button></div>}
        <div className="rd-working"><Bot data={current} size={22} mood="working" /><span>{current.name} is thinking</span><span className="rd-loader" aria-hidden="true"><i /><i /><i /><i /><i /></span><time>14s</time></div>
      </div>
      <Composer name={current.name} />
    </section>
  </div>
}

function Composer({ name }: { name: string }) {
  const [text, setText] = useState('')
  return <div className="rd-composer-wrap">
    <div className="rd-queue"><Hourglass size={13} />1 message queued · sends after this turn</div>
    <div className="rd-composer">
      <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder={`Message ${name}`} rows={2} />
      <div className="rd-composer-row">
        <button type="button" className="rd-icon-btn" aria-label="Attach"><Paperclip size={16} /></button>
        <button type="button" className="rd-pill"><GitBranch size={14} />Plan</button>
        <button type="button" className="rd-pill"><ShieldCheck size={14} />Auto<ChevronDown size={12} /></button>
        <span className="rd-flex" />
        <button type="button" className="rd-pill model"><Cpu size={14} />Sol 6.1 · High<ChevronDown size={12} /></button>
        <button type="button" className="rd-icon-btn" aria-label="Dictate"><Mic size={16} /></button>
        <button type="button" className="rd-send" aria-label="Send" disabled={!text.trim()}><ArrowUp size={17} /></button>
      </div>
    </div>
    <p className="rd-composer-note"><FolderGit2 size={12} />Board · actions run on this device</p>
  </div>
}

/* ---------------------------------------------------------------- settings */

type SettingsPage = 'general' | 'appearance' | 'agents' | 'remote'
const SETTINGS_NAV: { id: SettingsPage; label: string; icon: ReactNode; group: string }[] = [
  { id: 'general', label: 'General', icon: <SlidersHorizontal size={15} />, group: 'App' },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={15} />, group: 'App' },
  { id: 'agents', label: 'Coding agents', icon: <Terminal size={15} />, group: 'Bots' },
  { id: 'remote', label: 'Remote', icon: <Smartphone size={15} />, group: 'Bots' },
]
const ACCENTS = ['#f2694a', '#f4c84f', '#7fd3ae', '#8db7f5', '#c2b0f0', '#f2958a', '#ececec']

function SettingsScreen({ mode, setMode }: { mode: Mode; setMode: (mode: Mode) => void }) {
  const [page, setPage] = useState<SettingsPage>('appearance')
  return <div className="rd-settings">
    <nav className="rd-settings-nav" aria-label="Settings pages">
      <div className="rd-settings-search"><Search size={14} /><input placeholder="Search settings" /></div>
      {['App', 'Bots'].map((group) => <div key={group} className="rd-settings-group">
        <div className="rd-eyebrow">{group}</div>
        {SETTINGS_NAV.filter((item) => item.group === group).map((item) => <button key={item.id} type="button" className={page === item.id ? 'on' : ''} onClick={() => setPage(item.id)}>{item.icon}{item.label}</button>)}
      </div>)}
      <div className="rd-settings-group">
        <div className="rd-eyebrow">More</div>
        <button type="button"><Bell size={15} />Notifications</button>
        <button type="button"><Keyboard size={15} />Shortcuts</button>
        <button type="button"><Download size={15} />Updates<Chip tone="accent">1</Chip></button>
      </div>
    </nav>
    <div className="rd-settings-page">
      {page === 'appearance' && <AppearancePage mode={mode} setMode={setMode} />}
      {page === 'general' && <GeneralPage />}
      {page === 'agents' && <AgentsPage />}
      {page === 'remote' && <RemotePage />}
    </div>
  </div>
}

function PageHead({ title, sub }: { title: string; sub: string }) {
  return <header className="rd-page-head"><h1>{title}</h1><p>{sub}</p></header>
}
function Row({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return <div className="rd-row"><div className="rd-row-text"><strong>{title}</strong>{sub && <span>{sub}</span>}</div><div className="rd-row-control">{children}</div></div>
}

function AppearancePage({ mode, setMode }: { mode: Mode; setMode: (mode: Mode) => void }) {
  const style = useContext(StyleContext)
  const { skin, setSkin } = useContext(SkinContext)
  const [look, setLook] = useState<'bitbots' | 'blobots'>('bitbots')
  const [accent, setAccent] = useState(ACCENTS[0])
  const [density, setDensity] = useState<'compact' | 'cozy' | 'roomy'>('cozy')
  const [text, setText] = useState(14)
  const [motion, setMotion] = useState(true)
  const [sounds, setSounds] = useState(false)
  return <>
    <PageHead title="Appearance" sub="How Bitbots looks on this device: the bots, the colours and the density." />
    <div className="rd-card-label">Look</div>
    {style === 'blob' ? <BlobLooks skin={skin} setSkin={setSkin} /> : <div className="rd-looks">
      {(['bitbots', 'blobots'] as const).map((id) => <button key={id} type="button" className={`rd-look${look === id ? ' on' : ''}`} onClick={() => setLook(id)}>
        <span className="rd-look-stage">{id === 'bitbots'
          ? <><Bot data={bot('codex')} size={46} mood="idle" /><Bot data={bot('pololo')} size={46} mood="working" /><Bot data={bot('claude')} size={46} mood="sleeping" /></>
          : <><span className="rd-blob" style={{ background: '#8db7f5' }} /><span className="rd-blob" style={{ background: '#7fd3ae' }} /><span className="rd-blob" style={{ background: '#f2958a' }} /></>}</span>
        <span className="rd-look-text"><strong>{id === 'bitbots' ? 'Bitbots' : 'Blobots'}</strong><span>{id === 'bitbots' ? 'Robot heads, this look' : 'Soft blobs, the quiet look'}</span></span>
        {look === id && <span className="rd-look-check"><Check size={13} /></span>}
      </button>)}
    </div>}
    <div className="rd-card-label">Theme</div>
    <div className="rd-card">
      <Row title="Mode" sub="System follows Windows."><Segmented label="Mode" value={mode} onChange={setMode} options={[{ id: 'light', label: 'Light', icon: <Sun size={13} /> }, { id: 'dark', label: 'Dark', icon: <Moon size={13} /> }]} /></Row>
      <Row title="Accent" sub="Send button, toggles and your messages.">
        <div className="rd-swatches" role="radiogroup" aria-label="Accent">{ACCENTS.map((color) => <button key={color} type="button" role="radio" aria-checked={accent === color} aria-label={color} className={accent === color ? 'on' : ''} style={{ '--sw': color } as CSSProperties} onClick={() => setAccent(color)} />)}</div>
      </Row>
      <Row title="Density" sub="Row height in the sidebar and lists."><Segmented label="Density" value={density} onChange={setDensity} options={[{ id: 'compact', label: 'Compact' }, { id: 'cozy', label: 'Cozy' }, { id: 'roomy', label: 'Roomy' }]} /></Row>
      <Row title="Text size" sub={`${text} px body text`}>
        <div className="rd-slider"><input type="range" min={13} max={16} step={1} value={text} onChange={(event) => setText(Number(event.target.value))} aria-label="Text size" /><span className="rd-slider-value">{text}</span></div>
      </Row>
    </div>
    <div className="rd-card-label">Motion and sound</div>
    <div className="rd-card">
      <Row title="Animate bots" sub="Blinking, looking around and the working wiggle."><Toggle label="Animate bots" on={motion} onChange={setMotion} /></Row>
      <Row title="Sound cues" sub="A short chirp when a bot finishes or needs you."><Toggle label="Sound cues" on={sounds} onChange={setSounds} /></Row>
    </div>
  </>
}

function GeneralPage() {
  const [startup, setStartup] = useState(true)
  const [awake, setAwake] = useState(false)
  const [notify, setNotify] = useState(true)
  return <>
    <PageHead title="General" sub="Your name, start-up and what Bitbots does in the background." />
    <div className="rd-card-label">You</div>
    <div className="rd-card">
      <Row title="Your name" sub="Bots use it when they talk to you."><input className="rd-input" defaultValue="Bassem" /></Row>
      <Row title="Open on start" sub="The page Bitbots shows first."><button type="button" className="rd-select">Last conversation<ChevronDown size={14} /></button></Row>
    </div>
    <div className="rd-card-label">System</div>
    <div className="rd-card">
      <Row title="Launch at sign-in"><Toggle label="Launch at sign-in" on={startup} onChange={setStartup} /></Row>
      <Row title="Keep awake while bots work" sub="Stops Windows sleeping during a long task."><Toggle label="Keep awake" on={awake} onChange={setAwake} /></Row>
      <Row title="Notifications" sub="When a bot finishes, fails or needs approval."><Toggle label="Notifications" on={notify} onChange={setNotify} /></Row>
    </div>
    <div className="rd-card-label">Danger zone</div>
    <div className="rd-card">
      <Row title="Reset onboarding" sub="Shows the first-run steps again."><button type="button" className="rd-btn">Reset</button></Row>
      <Row title="Quit Bitbots" sub="Running bots stop after their current step."><button type="button" className="rd-btn danger">Quit</button></Row>
    </div>
  </>
}

function AgentsPage() {
  const agents = [
    { name: 'Claude Code', version: '2.4.1', state: 'Ready', tone: 'ok' as const, bots: 2, icon: 'CC' },
    { name: 'Codex', version: '0.71.0', state: 'Update available', tone: 'warn' as const, bots: 2, icon: 'CX' },
    { name: 'OpenCode', version: '1.9.3', state: 'Ready', tone: 'ok' as const, bots: 1, icon: 'OC' },
    { name: 'Gemini CLI', version: '—', state: 'Not found', tone: 'plain' as const, bots: 0, icon: 'GM' },
  ]
  return <>
    <PageHead title="Coding agents" sub="Command line tools Bitbots found on this device, and the bots that use them." />
    <div className="rd-card-label rd-label-row"><span>Detected</span><button type="button" className="rd-btn small"><RefreshCw size={13} />Scan again</button></div>
    <div className="rd-card">
      {agents.map((agent) => <div key={agent.name} className="rd-agent">
        <span className="rd-agent-mark">{agent.icon}</span>
        <span className="rd-row-text"><strong>{agent.name}</strong><span>v{agent.version} · {agent.bots} {agent.bots === 1 ? 'bot' : 'bots'}</span></span>
        <Chip tone={agent.tone} icon={agent.tone === 'ok' ? <Check size={12} /> : agent.tone === 'warn' ? <Download size={12} /> : <X size={12} />}>{agent.state}</Chip>
        <ChevronRight size={15} className="rd-row-chev" />
      </div>)}
    </div>
    <div className="rd-card-label">Status chips in this look</div>
    <div className="rd-card rd-chipboard">
      <Chip tone="violet" icon={<Clock size={12} />}>Queued</Chip>
      <Chip tone="info" icon={<Play size={12} />}>Starting</Chip>
      <Chip tone="warn" icon={<RefreshCw size={12} />}>Working</Chip>
      <Chip tone="accent" icon={<Hourglass size={12} />}>Waiting for approval</Chip>
      <Chip tone="ok" icon={<Check size={12} />}>Done</Chip>
      <Chip tone="danger" icon={<X size={12} />}>Failed</Chip>
      <Chip icon={<Square size={11} />}>Cancelled</Chip>
      <Chip icon={<Lock size={12} />}>Locked</Chip>
    </div>
  </>
}

function RemotePage() {
  const [on, setOn] = useState(true)
  return <>
    <PageHead title="Remote" sub="Reach your bots from a paired phone or laptop." />
    <div className="rd-card">
      <Row title="Remote access" sub="Off by default. Each new device needs your approval."><Toggle label="Remote access" on={on} onChange={setOn} /></Row>
      <Row title="Method"><Segmented label="Method" value="tailscale" onChange={() => undefined} options={[{ id: 'tailscale', label: 'Tailscale' }, { id: 'native', label: 'Native' }]} /></Row>
    </div>
    <div className="rd-card-label">Paired devices</div>
    <div className="rd-card">
      <div className="rd-agent"><span className="rd-agent-mark"><Smartphone size={16} /></span><span className="rd-row-text"><strong>Pixel 10</strong><span>Chat · last seen 3m ago</span></span><Chip tone="ok">Online</Chip><ChevronRight size={15} className="rd-row-chev" /></div>
      <div className="rd-agent"><span className="rd-agent-mark"><Monitor size={16} /></span><span className="rd-row-text"><strong>Work laptop</strong><span>Viewer · last seen Oct 15</span></span><Chip>Offline</Chip><ChevronRight size={15} className="rd-row-chev" /></div>
    </div>
  </>
}

/* ------------------------------------------------------------------- usage */

const WEEK = [{ day: 'Mon', value: 42 }, { day: 'Tue', value: 61 }, { day: 'Wed', value: 38 }, { day: 'Thu', value: 88 }, { day: 'Fri', value: 70 }, { day: 'Sat', value: 22 }, { day: 'Sun', value: 30 }]

function UsageScreen() {
  const [range, setRange] = useState<'today' | 'week' | 'month'>('week')
  const style = useContext(StyleContext)
  return <div className="rd-usage">
    <header className="rd-usage-head">
      <div><div className="rd-eyebrow">Usage</div><h1>This week with your bots</h1></div>
      <Segmented label="Range" value={range} onChange={setRange} options={[{ id: 'today', label: 'Today' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }]} />
    </header>
    <div className="rd-tiles">
      <article className="rd-tile big tile-a">
        <div className="rd-tile-top"><span className="rd-eyebrow">Tokens</span>{style === 'pop' && <Sticker tone="mint" tilt={6}>+18%</Sticker>}</div>
        <div className="rd-num">1.59<small>M</small></div>
        <div className="rd-bars" role="img" aria-label="Tokens per day this week">{WEEK.map((item) => <span key={item.day} className={item.day === 'Thu' ? 'peak' : ''}><i style={{ height: `${item.value}%` }} /><b>{item.day.slice(0, 1)}</b></span>)}</div>
      </article>
      <article className="rd-tile tile-b">
        <div className="rd-tile-top"><span className="rd-eyebrow">Conversations</span><Users size={15} /></div>
        <div className="rd-num">24<small>/ 32</small></div>
        <span className="rd-tile-sub">finished · 3 running</span>
        <Meter value={75} tone="ok" />
      </article>
      <article className="rd-tile tile-c">
        <div className="rd-tile-top"><span className="rd-eyebrow">Active time</span><Clock size={15} /></div>
        <div className="rd-num">4<small>h</small> 20<small>m</small></div>
        <span className="rd-tile-sub">across 5 bots</span>
      </article>
      <article className="rd-tile tile-d">
        <div className="rd-tile-top"><span className="rd-eyebrow">Approvals</span><ShieldCheck size={15} /></div>
        <div className="rd-num">17</div>
        <span className="rd-tile-sub">2 waiting right now</span>
      </article>
      <article className="rd-tile wide tile-e">
        <div className="rd-tile-top"><span className="rd-eyebrow">Limits</span><span className="rd-tile-sub">Resets shown per tool</span></div>
        {[
          { name: 'Claude Code · 5 hours', value: 27, reset: '2h 10m', tone: 'accent' as const },
          { name: 'Claude Code · weekly', value: 41, reset: '2d 3h', tone: 'accent' as const },
          { name: 'Codex · 5 hours', value: 82, reset: '48m', tone: 'warn' as const },
        ].map((limit) => <div key={limit.name} className="rd-limit-row"><span className="rd-limit-name">{limit.name}</span><Meter value={limit.value} tone={limit.tone} /><b>{limit.value}%</b><time>{limit.reset}</time></div>)}
      </article>
      <article className="rd-tile tall tile-f">
        <div className="rd-tile-top"><span className="rd-eyebrow">By bot</span><ChevronRight size={15} /></div>
        {[['codex', 38], ['pololo', 26], ['invoice', 18], ['claude', 11], ['opencode', 7]].map(([id, share]) => <div key={id} className="rd-share">
          <Bot data={bot(id as string)} size={26} mood="idle" /><span className="rd-share-name">{bot(id as string).name}</span><span className="rd-share-bar"><i style={{ width: `${share}%`, background: bot(id as string).color }} /></span><b>{share}%</b>
        </div>)}
      </article>
    </div>
  </div>
}

function BlobLooks({ skin, setSkin }: { skin: Skin; setSkin: (skin: Skin) => void }) {
  const [shape, setShape] = useState<PaintedShape>('cube')
  const team = ['codex', 'pololo', 'claude']
  const options: { id: 'bitbots' | Skin; title: string; sub: string }[] = [
    { id: 'bitbots', title: 'Bitbots', sub: 'Robot heads' },
    { id: 'glossy', title: 'Blobots', sub: 'Glossy blobs, today' },
    { id: 'painted', title: 'Blobots, hand-painted', sub: 'Flat paint, twelve shapes' },
  ]
  return <>
    <div className="rd-looks three">
      {options.map((option) => <button key={option.id} type="button" className={`rd-look${skin === option.id ? ' on' : ''}`} onClick={() => option.id !== 'bitbots' && setSkin(option.id)}>
        <span className="rd-look-stage">
          {option.id === 'bitbots' ? <StyleContext.Provider value="frost">{team.map((id) => <Bot key={id} data={bot(id)} size={40} />)}</StyleContext.Provider>
            : option.id === 'glossy' ? team.map((id) => <BlobCanvas key={id} decorative style="blobots" color={bot(id).color} size={40} mood={BLOB_MOOD[bot(id).mood]} look={{ shape: bot(id).classic, seed: id }} />)
            : team.map((id) => <PaintedBot key={id} shape={bot(id).paint} color={bot(id).color} size={40} mood={bot(id).mood} />)}
        </span>
        <span className="rd-look-text"><strong>{option.title}</strong><span>{option.sub}</span></span>
        {skin === option.id && <span className="rd-look-check"><Check size={13} /></span>}
      </button>)}
    </div>
    {skin === 'painted' && <>
      <div className="rd-card-label">Shape for Codex</div>
      <div className="rd-card rd-shape-picker" role="radiogroup" aria-label="Shape">
        {PAINTED_SHAPES.map((item) => <button key={item} type="button" role="radio" aria-checked={shape === item} className={shape === item ? 'on' : ''} onClick={() => setShape(item)}>
          <PaintedBot shape={item} color={bot('codex').color} size={44} mood={shape === item ? 'working' : 'idle'} /><span>{paintedLabel(item)}</span>
        </button>)}
      </div>
    </>}
  </>
}

const PALETTE = ['#8db7f5', '#7fd3ae', '#f2958a', '#f4c84f', '#c2b0f0', '#f5a25b', '#4f86f7', '#e6e6ea']
const PAIRS: [BlobShape, PaintedShape][] = [['circle', 'classic'], ['squircle', 'cube'], ['droplet', 'pear'], ['cloud', 'flower'], ['pebble', 'ghost'], ['capsule', 'peanut']]

function CharactersScreen() {
  const [mood, setMood] = useState<Mood>('idle')
  const [colour, setColour] = useState<string>('mixed')
  const tint = (index: number) => colour === 'mixed' ? PALETTE[index % PALETTE.length] : colour
  return <div className="rd-usage rd-characters">
    <header className="rd-usage-head">
      <div><div className="rd-eyebrow">Blobots · design study</div><h1>Hand-painted bots</h1></div>
      <Segmented label="Mood" value={mood} onChange={setMood} options={[{ id: 'idle', label: 'Idle' }, { id: 'working', label: 'Working' }, { id: 'waiting', label: 'Waiting' }, { id: 'sleeping', label: 'Sleeping' }]} />
    </header>
    <div className="rd-colour-row" role="radiogroup" aria-label="Colour">
      <button type="button" role="radio" aria-checked={colour === 'mixed'} className={`rd-colour-mixed${colour === 'mixed' ? ' on' : ''}`} onClick={() => setColour('mixed')}>Mixed</button>
      {PALETTE.map((item) => <button key={item} type="button" role="radio" aria-checked={colour === item} aria-label={item} className={colour === item ? 'on' : ''} style={{ '--sw': item } as CSSProperties} onClick={() => setColour(item)} />)}
    </div>
    <div className="rd-card-label">Twelve shapes</div>
    <div className="rd-char-grid">
      {PAINTED_SHAPES.map((shape, index) => <figure key={shape} className="rd-char">
        <PaintedBot shape={shape} color={tint(index)} size={92} mood={mood} label={`${paintedLabel(shape)}, ${mood}`} />
        <figcaption>{paintedLabel(shape)}</figcaption>
      </figure>)}
    </div>
    <div className="rd-card-label">Next to the glossy bots you have now</div>
    <div className="rd-card rd-pairs">
      {PAIRS.map(([classic, painted], index) => <div key={painted} className="rd-pair">
        <BlobCanvas decorative style="blobots" color={tint(index)} size={64} mood={BLOB_MOOD[mood]} look={{ shape: classic, seed: classic }} />
        <ChevronRight size={16} />
        <PaintedBot shape={painted} color={tint(index)} size={64} mood={mood} />
      </div>)}
    </div>
    <div className="rd-card-label">At the sizes the app uses</div>
    <div className="rd-card rd-sizes">
      {[20, 28, 38, 64, 112].map((size, row) => <div key={size} className="rd-size-row">
        <span>{size} px</span>
        {(['cube', 'star', 'ghost', 'cat', 'saucer'] as const).map((shape, index) => <PaintedBot key={shape} shape={shape} color={tint(index + row)} size={size} mood={mood} />)}
      </div>)}
    </div>
  </div>
}

/* --------------------------------------------------------------- companion */

function CompanionScreen() {
  const [view, setView] = useState<'chat' | 'team'>('chat')
  return <div className="rd-desktop">
    <div className="rd-wallpaper" aria-hidden="true" />
    <div className="rd-desktop-note">Companion islands over the desktop, at their real sizes</div>
    <div className="rd-island expanded">
      <header className="rd-island-head">
        <div className="rd-island-team">{['codex', 'pololo', 'invoice', 'claude'].map((id) => <button key={id} type="button" className={id === 'codex' ? 'on' : ''} aria-label={bot(id).name}><Bot data={bot(id)} size={28} /></button>)}</div>
        <Segmented label="Island view" value={view} onChange={setView} options={[{ id: 'chat', label: 'Chat' }, { id: 'team', label: 'Team' }]} />
        <button type="button" className="rd-icon-btn" aria-label="Close"><X size={15} /></button>
      </header>
      {view === 'chat' ? <div className="rd-island-body">
        <div className="rd-msg user small"><div className="rd-bubble">Is the effort picker ready to review?</div></div>
        <div className="rd-msg bot small"><div className="rd-bubble">Nearly. Tests are running; I need your OK for <code>npm run test</code>.</div></div>
        <div className="rd-island-approval"><Terminal size={14} /><span>npm run test -- effort</span><button type="button" className="rd-btn primary small">Allow</button><button type="button" className="rd-btn ghost small">Deny</button></div>
      </div> : <div className="rd-island-body team">
        {BOTS.slice(1, 5).map((item) => <div key={item.id} className="rd-island-peer"><Bot data={item} size={30} /><span><strong>{item.name}</strong><small>{item.line}</small></span>{item.status && <span className={`rd-dot ${item.status}`} />}</div>)}
      </div>}
      <div className="rd-island-composer"><input placeholder="Message Codex" /><button type="button" className="rd-icon-btn" aria-label="Dictate"><Mic size={15} /></button><button type="button" className="rd-send small" aria-label="Send"><ArrowUp size={15} /></button></div>
    </div>
    <div className="rd-island compact">
      <Bot data={bot('codex')} size={30} mood="waiting" />
      <span className="rd-island-status"><strong>Codex needs you</strong><small>Run npm run test?</small></span>
      <span className="rd-island-faces">{['pololo', 'invoice'].map((id) => <Bot key={id} data={bot(id)} size={22} />)}</span>
      <button type="button" className="rd-icon-btn" aria-label="Dictate"><Mic size={15} /></button>
    </div>
  </div>
}

/* ------------------------------------------------------------- wallpapers */

type WallpaperId = 'dusk' | 'lake' | 'bloom' | 'sand'
type Glass = 'clear' | 'balanced' | 'solid'
const WALLPAPERS: { id: WallpaperId; label: string }[] = [
  { id: 'dusk', label: 'Dusk' }, { id: 'lake', label: 'Lake' }, { id: 'bloom', label: 'Bloom' }, { id: 'sand', label: 'Sand' },
]
const GLASS: { id: Glass; label: string }[] = [{ id: 'clear', label: 'Clear' }, { id: 'balanced', label: 'Balanced' }, { id: 'solid', label: 'Solid' }]

/** Stand-in desktop wallpapers, so the translucent window has something real to show through. */
function Wallpaper({ id }: { id: WallpaperId }) {
  const common = { className: 'rd-desk-wallpaper', viewBox: '0 0 1600 1000', preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': true } as const
  if (id === 'dusk') return <svg {...common}>
    <defs><linearGradient id="wp-dusk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#121831" /><stop offset=".45" stopColor="#372d58" /><stop offset=".72" stopColor="#9c5678" /><stop offset=".88" stopColor="#e0906f" /></linearGradient></defs>
    <rect width="1600" height="1000" fill="url(#wp-dusk)" />
    <rect x="1060" y="580" width="124" height="124" rx="62" fill="#ffd3a3" />
    <path fill="#4a3566" d="M0 640 L180 560 L320 610 L470 500 L620 590 L760 520 L900 600 L1040 540 L1200 610 L1360 530 L1600 600 V1000 H0Z" />
    <path fill="#30264d" d="M0 720 L140 650 L300 700 L460 620 L640 700 L820 640 L980 710 L1150 650 L1320 720 L1480 670 L1600 700 V1000 H0Z" />
    <path fill="#1f1a37" d="M0 800 C200 760 380 780 560 820 S 920 760 1120 800 S 1460 790 1600 770 V1000 H0Z" />
    <path fill="#121024" d="M0 900 C300 860 600 880 900 910 S 1400 870 1600 890 V1000 H0Z" />
  </svg>
  if (id === 'lake') return <svg {...common}>
    <defs><linearGradient id="wp-lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b7cfe8" /><stop offset=".55" stopColor="#e8e3ee" /><stop offset=".8" stopColor="#f6dcc8" /></linearGradient></defs>
    <rect width="1600" height="1000" fill="url(#wp-lake)" />
    <rect x="330" y="500" width="140" height="140" rx="70" fill="#fff4e4" />
    <path fill="#a9bfd3" d="M0 640 C160 560 300 520 460 580 S 760 500 920 560 S 1240 470 1600 560 V1000 H0Z" />
    <path fill="#86a3bc" d="M0 700 C200 640 360 660 520 690 S 860 620 1060 680 S 1420 640 1600 660 V1000 H0Z" />
    <path fill="#6a89a3" d="M0 760 C240 730 480 740 720 770 S 1200 720 1600 750 V1000 H0Z" />
    <rect y="790" width="1600" height="210" fill="#c3d6e6" />
    <path fill="none" stroke="#e7f0f7" strokeWidth="4" strokeLinecap="round" d="M220 840 H520 M760 870 H1180 M380 920 H640 M1040 950 H1380" />
  </svg>
  if (id === 'bloom') return <svg {...common}>
    <rect width="1600" height="1000" fill="#0a0f1f" />
    <g transform="translate(900 560)">
      {([[-28, '#17327f'], [8, '#2050c4'], [40, '#3a74f0'], [72, '#6f9cff'], [104, '#a9c4ff']] as const).map(([angle, color]) => <ellipse key={angle} rx="460" ry="140" fill={color} opacity=".85" transform={`rotate(${angle})`} />)}
    </g>
  </svg>
  return <svg {...common}>
    <rect width="1600" height="1000" fill="#efe5d8" />
    <path fill="#e6cfb3" d="M0 300 C300 220 520 380 820 320 S 1300 180 1600 260 V1000 H0Z" />
    <path fill="#d9b48f" d="M0 520 C260 440 560 600 860 520 S 1340 420 1600 500 V1000 H0Z" />
    <path fill="#c69270" d="M0 720 C320 640 640 780 980 700 S 1420 640 1600 690 V1000 H0Z" />
    <path fill="#a8735a" d="M0 880 C400 830 760 920 1120 860 S 1500 850 1600 860 V1000 H0Z" />
  </svg>
}

/* ---------------------------------------------------------------- the page */

function Preview() {
  const initial = readQuery()
  const [style, setStyle] = useState<StyleId>(initial.style)
  const [screen, setScreen] = useState<Screen>(initial.screen)
  const [mode, setMode] = useState<Mode>(initial.mode)
  const [selected, setSelected] = useState('codex')
  const [wallpaper, setWallpaper] = useState<WallpaperId | null>(initial.wallpaper)
  const [glass, setGlass] = useState<Glass>(initial.glass)
  const [skin, setSkin] = useState<Skin>(initial.skin)
  const shownWallpaper = wallpaper ?? (mode === 'dark' ? 'dusk' : 'lake')

  useEffect(() => {
    const query = new URLSearchParams({ style, screen, mode })
    if (style === 'frost') { query.set('glass', glass); if (wallpaper) query.set('wallpaper', wallpaper) }
    if (style === 'blob' && skin === 'glossy') query.set('bots', 'glossy')
    history.replaceState(null, '', `?${query}`)
  }, [style, screen, mode, glass, wallpaper, skin])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea')) return
      const next = STYLES[Number(event.key) - 1]
      if (next) { setStyle(next.id); setMode(next.mode) }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  return <StyleContext.Provider value={style}><SkinContext.Provider value={{ skin, setSkin }}>
    <div className="rd-preview">
      <div className="rd-switcher" role="toolbar" aria-label="Preview controls">
        {style !== 'frost' && <span className="rd-switcher-title">Primary look · directions</span>}
        <div className="rd-switcher-group" role="radiogroup" aria-label="Direction">
          {STYLES.map((item) => <button key={item.id} type="button" role="radio" aria-checked={style === item.id} className={style === item.id ? 'on' : ''} onClick={() => { setStyle(item.id); setMode(item.mode) }} title={item.note}>
            <b>{item.letter}</b>{item.name}
          </button>)}
        </div>
        {style === 'frost' ? <>
          <div className="rd-switcher-group" role="radiogroup" aria-label="Wallpaper">
            {WALLPAPERS.map((item) => <button key={item.id} type="button" role="radio" aria-checked={shownWallpaper === item.id} className={shownWallpaper === item.id ? 'on' : ''} onClick={() => setWallpaper(item.id)}>{item.label}</button>)}
          </div>
          <div className="rd-switcher-group" role="radiogroup" aria-label="Glass">
            {GLASS.map((item) => <button key={item.id} type="button" role="radio" aria-checked={glass === item.id} className={glass === item.id ? 'on' : ''} onClick={() => setGlass(item.id)}>{item.label}</button>)}
          </div>
        </> : style === 'blob' ? <div className="rd-switcher-group" role="radiogroup" aria-label="Bots">
          {([['painted', 'Hand-painted'], ['glossy', 'Glossy (now)']] as const).map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={skin === id} className={skin === id ? 'on' : ''} onClick={() => setSkin(id)}>{label}</button>)}
        </div> : <span className="rd-switcher-note">{STYLES.find((item) => item.id === style)!.note}</span>}
        <span className="rd-flex" />
        <div className="rd-switcher-group" role="radiogroup" aria-label="Screen">
          {SCREENS.map((item) => <button key={item.id} type="button" role="radio" aria-checked={screen === item.id} className={screen === item.id ? 'on' : ''} onClick={() => setScreen(item.id)}>{item.label}</button>)}
        </div>
        <button type="button" className="rd-switcher-mode" onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`}>{mode === 'dark' ? <Moon size={14} /> : <Sun size={14} />}{mode === 'dark' ? 'Dark' : 'Light'}</button>
      </div>
      <div className="rd-root" data-rd={style} data-mode={mode} data-glass={glass}>
        {style === 'frost' && <Wallpaper id={shownWallpaper} />}
        <div className="rd-app">
          <Sidebar screen={screen} setScreen={setScreen} selected={selected} setSelected={setSelected} />
          <main className="rd-main">
            {screen === 'chat' && <ChatScreen selected={selected} />}
            {screen === 'settings' && <SettingsScreen mode={mode} setMode={setMode} />}
            {screen === 'usage' && <UsageScreen />}
            {screen === 'companion' && <CompanionScreen />}
            {screen === 'characters' && <CharactersScreen />}
          </main>
        </div>
      </div>
    </div>
  </SkinContext.Provider></StyleContext.Provider>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Preview />)
