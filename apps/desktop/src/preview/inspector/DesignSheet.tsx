// Development-only design sheet at /inspector-sheet.html: the parts every screen is built from, using the
// app's real components, classes and tokens, in the look and theme from the URL.
import { useEffect, useState, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import { ArrowUp, Check, Plus, Settings, Trash2 } from 'lucide-react'
import '../../ui/theme.css'
import '../../ui/styles.css'
import '../../ui/approval.css'
import '../../ui/accent.css'
import '../../ui/shell.css'
import '../../ui/density.css'
import '../../ui/skeleton.css'
import '../../ui/composer.css'
import '../../ui/usage.css'
import '../../ui/team.css'
import '../../ui/blobPage.css'
import '../../ui/companion.css'
import '../../ui/settings.css'
import '../../ui/polish.css'
import '../../ui/themes/haze.css'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { Select } from '../../ui/Select'
import { StatusDot, type BotStatus } from '../../ui/StatusDot'
import { Skeleton } from '../../ui/Skeleton'
import { Tip } from '../../ui/Tip'
import { SettingsGroup, SettingsRow, HelpTip } from '../../ui/SettingsParts'
import { ConnectionBanner } from '../../ui/ConnectionBanner'
import { UpdateAvailableBanner } from '../../ui/UpdateBanner'
import { SwatchGrid } from '../../ui/SwatchGrid'
import { AccentPicker } from '../../ui/AccentPicker'
import { SoundVolumeSlider } from '../../ui/SoundVolumeSlider'
import { ContextWindowIndicator } from '../../ui/ContextWindowIndicator'
import { FileReferenceChip } from '../../ui/FileReferenceChip'
import { ApprovalBadge, ApprovalPill } from '../../ui/approvalUi'
import { BlobCanvas } from '../../blob/BlobCanvas'
import { ART_MOOD_SAMPLE, ART_MOODS } from '../../blob/art/art'
import { MASCOT_LOOK } from '../../blob/look'
import { ProviderLogo, providerBrand } from '../../ui/providerBrand'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') === 'light' ? 'light' : 'dark'
const style = params.get('style') === 'blobots' ? 'blobots' : 'haze'
document.documentElement.dataset.theme = theme
document.documentElement.dataset.style = style

const TOKENS: Array<[string, string[]]> = [
  ['Surfaces', ['--surface-app', '--surface-sidebar', '--surface-panel', '--surface-raised', '--surface-overlay', '--surface-input', '--surface-hover', '--surface-selected', '--surface-selected-strong', '--surface-subtle', '--surface-disabled', '--surface-avatar', '--surface-danger', '--surface-warning', '--surface-permission', '--surface-error-subtle', '--surface-toggle-off', '--surface-toggle-knob']],
  ['Text', ['--text-1', '--text-2', '--text-3', '--text-inverse', '--text-avatar', '--status-danger-text', '--status-working-text', '--danger-ink']],
  ['Lines', ['--line', '--line-strong', '--warning-line', '--error-line', '--permission-line', '--tree-line', '--scroll-thumb']],
  ['Status and charts', ['--status-working', '--status-success', '--status-danger', '--meter-claude', '--meter-cyan', '--meter-blue', '--meter-violet', '--chart-bar', '--chart-bar-hover', '--chart-track', '--chart-provider', '--chart-permission', '--chart-timeout', '--chart-budget', '--chart-config', '--chart-context']],
]
const SIZES = ['--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl', '--fs-2xl']
const STATUSES: BotStatus[] = ['working', 'waiting', 'attention', 'failed', 'idle', 'offline']

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} aria-label={title} style={{ padding: '18px 0', borderTop: '1px solid var(--line)' }}>
    <h2 style={{ margin: '0 0 12px', fontSize: 'var(--fs-lg)', fontWeight: 600, color: 'var(--text-1)' }}>{title}</h2>
    {children}
  </section>
}
const Row = ({ label, children }: { label: string; children: ReactNode }) => <div style={{ display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', alignItems: 'center', gap: 12, padding: '7px 0' }}>
  <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{label}</span>
  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 }}>{children}</div>
</div>

function Swatch({ token }: { token: string }) {
  const [value, setValue] = useState('')
  useEffect(() => { setValue(getComputedStyle(document.documentElement).getPropertyValue(token).trim()) }, [token])
  return <div style={{ display: 'grid', gridTemplateColumns: '34px minmax(0, 1fr)', alignItems: 'center', gap: 8, minWidth: 0 }}>
    <span aria-hidden="true" style={{ width: 34, height: 34, borderRadius: 8, border: '1px solid var(--line-strong)', background: `var(${token})` }} />
    <span style={{ minWidth: 0 }}>
      <code style={{ display: 'block', color: 'var(--text-1)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{token}</code>
      <small style={{ display: 'block', color: 'var(--text-3)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value || 'not set'}</small>
    </span>
  </div>
}

function Sheet() {
  const [segment, setSegment] = useState<'one' | 'two' | 'three'>('two')
  const [option, setOption] = useState('sol')
  const [color, setColor] = useState('mint')
  const [accent, setAccent] = useState('#8fb4ff')
  const [volume, setVolume] = useState(0.4)
  const [on, setOn] = useState(true)
  useEffect(() => { document.getElementById(location.hash.slice(1))?.scrollIntoView() }, [])
  return <main style={{ boxSizing: 'border-box', minHeight: '100vh', padding: '20px 28px 60px', color: 'var(--text-1)', background: theme === 'light' ? '#f4f4f2' : '#1a1b1d', fontSize: 'var(--fs-md)' }}>
    <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl)', fontWeight: 600 }}>Design sheet</h1>
    <p style={{ margin: '2px 0 16px', color: 'var(--text-2)' }}>The real parts, in {style === 'haze' ? 'Haze' : 'Stone'}, {theme}.</p>

    <Section id="tokens" title="Colours, type and space">
      {TOKENS.map(([group, tokens]) => <div key={group} style={{ marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 8px', color: 'var(--text-2)', fontSize: 'var(--fs-sm)', fontWeight: 600 }}>{group}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>{tokens.map((token) => <Swatch key={token} token={token} />)}</div>
      </div>)}
      <h3 style={{ margin: '12px 0 8px', color: 'var(--text-2)', fontSize: 'var(--fs-sm)', fontWeight: 600 }}>Type</h3>
      {SIZES.map((size) => <div key={size} style={{ fontSize: `var(${size})`, padding: '2px 0' }}>{size}: The quick brown fox, 0123456789</div>)}
      <div style={{ color: 'var(--text-2)', padding: '2px 0' }}>Secondary text</div>
      <div style={{ color: 'var(--text-3)', padding: '2px 0' }}>Quiet text</div>
      <code style={{ display: 'block', padding: '2px 0' }}>Monospace: const total = lines.reduce(add, 0)</code>
    </Section>

    <Section id="controls" title="Buttons, fields and menus">
      <Row label="Primary"><button type="button" className="primary-button">Primary</button><button type="button" className="primary-button small">Small</button><button type="button" className="primary-button" disabled>Disabled</button><button type="button" className="primary-button"><Check size={14} aria-hidden="true" />With icon</button></Row>
      <Row label="Secondary"><button type="button" className="secondary-button">Secondary</button><button type="button" className="secondary-button small">Small</button><button type="button" className="secondary-button" disabled>Disabled</button></Row>
      <Row label="Ghost"><button type="button" className="ghost-button">Ghost</button><button type="button" className="ghost-button small">Small</button><button type="button" className="ghost-button" disabled>Disabled</button></Row>
      <Row label="Danger"><button type="button" className="danger-button">Delete</button><button type="button" className="danger-button" disabled>Disabled</button></Row>
      <Row label="Icon"><button type="button" className="icon-button" aria-label="Settings"><Settings size={15} aria-hidden="true" /></button><button type="button" className="icon-button quiet" aria-label="Add"><Plus size={15} aria-hidden="true" /></button><button type="button" className="icon-button tiny" aria-label="Delete"><Trash2 size={13} aria-hidden="true" /></button><button type="button" className="icon-button" disabled aria-label="Send"><ArrowUp size={15} aria-hidden="true" /></button></Row>
      <Row label="Text field"><input className="text-input" placeholder="A placeholder" aria-label="Empty field" /><input className="text-input" defaultValue="Some text" aria-label="Filled field" /><input className="text-input" defaultValue="Disabled" disabled aria-label="Disabled field" /></Row>
      <Row label="Long field"><textarea className="text-input" rows={3} defaultValue={'Several lines\nof text'} aria-label="Long field" style={{ width: 320 }} /></Row>
      <Row label="Dropdown"><Select ariaLabel="Model" value={option} onChange={setOption} options={[{ value: 'sol', label: 'GPT-6.1-Sol' }, { value: 'luna', label: 'GPT-6-Luna' }, { value: 'off', label: 'Unavailable', disabled: true }]} /><Select ariaLabel="Model, field" variant="field" value={option} onChange={setOption} options={[{ value: 'sol', label: 'GPT-6.1-Sol' }, { value: 'luna', label: 'GPT-6-Luna' }]} /></Row>
      <Row label="Segments"><SegmentedControl label="Segments" value={segment} onChange={setSegment} options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }, { value: 'three', label: 'Three' }]} /></Row>
      <Row label="Switch"><button type="button" className={`toggle ${on ? 'on' : ''}`} role="switch" aria-label="A switch" aria-checked={on} onClick={() => setOn((value) => !value)}><i /></button></Row>
      <Row label="Slider"><SoundVolumeSlider value={volume} onChange={setVolume} onCommit={setVolume} onPlaySample={() => undefined} /></Row>
      <Row label="Tooltip"><Tip text="A tooltip, on hover or focus"><button type="button" className="secondary-button small">Hover me</button></Tip><HelpTip text="A help bubble that explains a setting." /></Row>
      <Row label="Menu"><div className="menu-surface" role="menu" style={{ position: 'static', width: 200 }}><button type="button" className="menu-item" role="menuitem">A menu item</button><button type="button" className="menu-item" role="menuitem"><Plus size={15} aria-hidden="true" />With an icon</button><button type="button" className="menu-item" role="menuitem" disabled>Disabled</button></div></Row>
      <Row label="Colours"><div style={{ width: 300 }}><SwatchGrid value={color} onChange={setColor} /></div></Row>
      <Row label="Accent"><AccentPicker value={accent} onChange={setAccent} /></Row>
      <div style={{ marginTop: 10, maxWidth: 620 }}><SettingsGroup title="A settings group"><SettingsRow label="A row" hint="A hint that explains it."><button type="button" className="secondary-button small">Change</button></SettingsRow><SettingsRow label="A row with detail" detail="One more line under the label." /></SettingsGroup></div>
    </Section>

    <Section id="status" title="Status, chips and banners">
      <Row label="Working">{STATUSES.map((status) => <span key={status} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><StatusDot status={status} showIdle /><small style={{ color: 'var(--text-2)' }}>{status}</small></span>)}</Row>
      <Row label="Access"><ApprovalBadge mode="auto" /><ApprovalBadge mode="accept_edits" /><ApprovalBadge mode="bypass" /><ApprovalPill mode="auto" /><ApprovalPill mode="accept_edits" /><ApprovalPill mode="bypass" /><ApprovalPill mode="auto" compact /></Row>
      <Row label="Coding agents">{['claude', 'codex', 'opencode', 'gemini', 'qwen'].map((provider) => <span key={provider} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--text-2)', fontSize: 12 }}><ProviderLogo provider={provider} />{providerBrand(provider).name}</span>)}</Row>
      <Row label="File chip"><FileReferenceChip file={{ fileName: 'invoice.test.ts', path: 'tests/invoice.test.ts', size: '4 KB' }} /></Row>
      <Row label="Context ring"><ContextWindowIndicator used={14_000} size={400_000} model="gpt-6.1-sol" /><ContextWindowIndicator used={250_000} size={400_000} model="gpt-6.1-sol" /><ContextWindowIndicator used={380_000} size={400_000} model="gpt-6.1-sol" /></Row>
      <Row label="Update banner"><UpdateAvailableBanner version="0.1.0-beta.99" onView={() => undefined} onLater={() => undefined} /></Row>
      <div style={{ maxWidth: 620 }}>
        <ConnectionBanner state="connecting" attempts={2} onRetry={() => undefined} />
        <ConnectionBanner state="disconnected" attempts={5} failed onRetry={() => undefined} />
        <div className="settings-banner"><span>A settings banner with a message.</span><button type="button" className="secondary-button small">Do it</button></div>
        <div className="settings-banner error"><span>A settings error.</span></div>
      </div>
    </Section>

    <Section id="loading" title="Loading and empty">
      <Row label="Loading text"><div style={{ width: 320 }}><Skeleton lines={3} /></div></Row>
      <Row label="Loading rows"><div style={{ width: 320 }}><Skeleton lines={3} variant="row" /></div></Row>
      <Row label="Loading pill"><Skeleton variant="pill" /></Row>
      <Row label="Typing"><span className="typing" aria-label="Working"><i /><i /><i /></span></Row>
      <Row label="Empty"><p className="settings-empty" style={{ margin: 0 }}>Nothing here yet.</p></Row>
    </Section>

    <Section id="art" title="Bot art">
      <Row label="Moods">{ART_MOODS.map((mood) => <div key={mood} style={{ display: 'grid', justifyItems: 'center', gap: 3 }}><BlobCanvas color="#7db6ff" size={48} mood={ART_MOOD_SAMPLE[mood]} look={{ ...MASCOT_LOOK }} label={mood} /><small style={{ color: 'var(--text-3)', fontSize: 10 }}>{mood}</small></div>)}</Row>
      <Row label="Sizes">{[16, 22, 32, 44, 64, 96].map((size) => <BlobCanvas key={size} color="#ff9bd0" size={size} mood="idle" look={{ ...MASCOT_LOOK }} label={`${size} pixels`} />)}</Row>
    </Section>
  </main>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Sheet />)
