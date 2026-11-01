// A project's icon. The owner's pick wins: an emoji, or a preset icon in a colour. With no pick it's
// the favicon in the project's own folder when there is one, else a plain folder.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Book, Brain, Braces, Briefcase, Camera, ChartColumn, CircleDollarSign, Clover, Cloud, Code, Database, Dumbbell, FlaskConical, Flower2, Folder, FolderOpen, Gamepad2, Globe, GraduationCap, Heart, House, Leaf, Lightbulb, Music, Notebook, Palette, PawPrint, Pencil, PencilRuler, PenTool, Plane, Popcorn, Rocket, Scale, Search, Shield, ShoppingBasket, Stethoscope, Terminal, Wrench, Zap, type LucideIcon } from 'lucide-react'
import type { Project } from '../types'
import { rpc } from '../tauri'
import { usePopoverDismiss } from './ComposerControls'
import './projectIcon.css'

export type ProjectIconChoice = { kind: 'emoji' | 'lucide' | 'favicon'; value: string; color?: string | null }

export const PROJECT_ICONS: ReadonlyArray<{ id: string; Icon: LucideIcon; words: string }> = [
  { id: 'folder', Icon: Folder, words: 'directory files' },
  { id: 'code', Icon: Code, words: 'programming develop' },
  { id: 'braces', Icon: Braces, words: 'code json' },
  { id: 'terminal', Icon: Terminal, words: 'shell command' },
  { id: 'database', Icon: Database, words: 'data sql storage' },
  { id: 'cloud', Icon: Cloud, words: 'server hosting' },
  { id: 'globe', Icon: Globe, words: 'web site world' },
  { id: 'rocket', Icon: Rocket, words: 'launch startup' },
  { id: 'bot', Icon: Bot, words: 'robot ai' },
  { id: 'brain', Icon: Brain, words: 'ai idea think' },
  { id: 'wrench', Icon: Wrench, words: 'tool fix' },
  { id: 'shield', Icon: Shield, words: 'security safe' },
  { id: 'zap', Icon: Zap, words: 'fast power' },
  { id: 'flask', Icon: FlaskConical, words: 'science test lab' },
  { id: 'lightbulb', Icon: Lightbulb, words: 'idea' },
  { id: 'chart', Icon: ChartColumn, words: 'analytics data' },
  { id: 'dollar', Icon: CircleDollarSign, words: 'money finance' },
  { id: 'briefcase', Icon: Briefcase, words: 'work business' },
  { id: 'book', Icon: Book, words: 'read docs' },
  { id: 'notebook', Icon: Notebook, words: 'notes journal' },
  { id: 'graduation', Icon: GraduationCap, words: 'school learn' },
  { id: 'pencil', Icon: Pencil, words: 'write edit' },
  { id: 'pen', Icon: PenTool, words: 'design vector' },
  { id: 'ruler', Icon: PencilRuler, words: 'design plan' },
  { id: 'palette', Icon: Palette, words: 'art colour color design' },
  { id: 'camera', Icon: Camera, words: 'photo' },
  { id: 'music', Icon: Music, words: 'audio song' },
  { id: 'popcorn', Icon: Popcorn, words: 'film movie' },
  { id: 'gamepad', Icon: Gamepad2, words: 'game play' },
  { id: 'stethoscope', Icon: Stethoscope, words: 'health medical' },
  { id: 'dumbbell', Icon: Dumbbell, words: 'fitness gym' },
  { id: 'scale', Icon: Scale, words: 'law legal' },
  { id: 'plane', Icon: Plane, words: 'travel' },
  { id: 'house', Icon: House, words: 'home' },
  { id: 'basket', Icon: ShoppingBasket, words: 'shop store' },
  { id: 'heart', Icon: Heart, words: 'love' },
  { id: 'paw', Icon: PawPrint, words: 'pet animal' },
  { id: 'leaf', Icon: Leaf, words: 'nature green' },
  { id: 'flower', Icon: Flower2, words: 'nature' },
  { id: 'clover', Icon: Clover, words: 'luck' },
]

export const PROJECT_EMOJI: ReadonlyArray<{ emoji: string; words: string }> = [
  { emoji: '🚀', words: 'rocket launch' }, { emoji: '⚡', words: 'zap fast' }, { emoji: '🔥', words: 'fire hot' }, { emoji: '✨', words: 'sparkle' }, { emoji: '🎯', words: 'target goal' }, { emoji: '💡', words: 'idea light' },
  { emoji: '🧠', words: 'brain ai' }, { emoji: '🤖', words: 'robot bot' }, { emoji: '🛠️', words: 'tools fix' }, { emoji: '⚙️', words: 'gear settings' }, { emoji: '🧪', words: 'test science' }, { emoji: '🔒', words: 'lock security' },
  { emoji: '💻', words: 'laptop code' }, { emoji: '📱', words: 'phone mobile app' }, { emoji: '🌐', words: 'web globe' }, { emoji: '☁️', words: 'cloud' }, { emoji: '📦', words: 'package box' }, { emoji: '🗂️', words: 'folder files' },
  { emoji: '📝', words: 'notes write' }, { emoji: '📚', words: 'books docs' }, { emoji: '📊', words: 'chart data' }, { emoji: '💰', words: 'money finance' }, { emoji: '🛒', words: 'shop cart' }, { emoji: '💼', words: 'work business' },
  { emoji: '🎨', words: 'art design' }, { emoji: '🎮', words: 'game' }, { emoji: '🎵', words: 'music' }, { emoji: '🎬', words: 'film movie' }, { emoji: '📷', words: 'camera photo' }, { emoji: '✈️', words: 'travel plane' },
  { emoji: '🏠', words: 'home house' }, { emoji: '🌱', words: 'plant grow' }, { emoji: '🌊', words: 'wave water' }, { emoji: '⭐', words: 'star' }, { emoji: '❤️', words: 'heart love' }, { emoji: '🐾', words: 'pet paw' },
  { emoji: '🦊', words: 'fox' }, { emoji: '🐙', words: 'octopus' }, { emoji: '🍕', words: 'pizza food' }, { emoji: '☕', words: 'coffee' },
]

/** Neutral first: it clears the colour, so the icon follows the text. */
export const PROJECT_ICON_COLOURS: ReadonlyArray<{ value: string | null; label: string; swatch: string }> = [
  { value: null, label: 'Text colour', swatch: 'var(--text-1)' },
  { value: '#ff6b6b', label: 'Red', swatch: '#ff6b6b' },
  { value: '#ff9147', label: 'Orange', swatch: '#ff9147' },
  { value: '#f5c542', label: 'Yellow', swatch: '#f5c542' },
  { value: '#3ecf7a', label: 'Green', swatch: '#3ecf7a' },
  { value: '#3d9bff', label: 'Blue', swatch: '#3d9bff' },
  { value: '#a97bff', label: 'Purple', swatch: '#a97bff' },
  { value: '#ff8ac4', label: 'Pink', swatch: '#ff8ac4' },
]

/** The icon a project has chosen, if it's one this build can draw. */
export function projectIconChoice(project: Project | null | undefined): ProjectIconChoice | null {
  const icon = project?.overrides?.icon
  if (!icon || typeof icon !== 'object' || (icon.kind !== 'emoji' && icon.kind !== 'lucide')) return null
  if (icon.kind === 'lucide' && !PROJECT_ICONS.some((item) => item.id === icon.value)) return null
  return icon
}

const favicons = new Map<string, Promise<string | null>>()

/** The data URL of the favicon in the project's folder. Asked once per project and folder; it's only read from the project's own files. */
function faviconFor(projectId: string, path: string): Promise<string | null> {
  const key = `${projectId}|${path}`
  let found = favicons.get(key)
  if (!found) {
    found = rpc<{ found?: boolean; mime?: string; dataBase64?: string }>('project.favicon', { projectId }).then((result) => result?.found && result.mime && result.dataBase64 ? `data:${result.mime};base64,${result.dataBase64}` : null).catch(() => { favicons.delete(key); return null })
    favicons.set(key, found)
  }
  return found
}

function useFavicon(project: Project | null | undefined, wanted: boolean) {
  const [url, setUrl] = useState<string | null>(null)
  const id = project?.id
  const path = project?.path
  useEffect(() => {
    setUrl(null)
    if (!wanted || !id || !path) return
    let live = true
    void faviconFor(id, path).then((next) => { if (live) setUrl(next) })
    return () => { live = false }
  }, [id, path, wanted])
  return url
}

export function ProjectIcon({ project, size = 12 }: { project: Project | null | undefined; size?: number }) {
  const choice = projectIconChoice(project)
  const favicon = useFavicon(project, !choice)
  if (!project) return <FolderOpen size={size} aria-hidden="true" />
  if (choice?.kind === 'emoji') return <span className="project-icon-emoji" style={{ fontSize: size }} aria-hidden="true">{choice.value}</span>
  if (choice?.kind === 'lucide') {
    const Icon = PROJECT_ICONS.find((item) => item.id === choice.value)!.Icon
    return <Icon size={size} color={choice.color ?? undefined} aria-hidden="true" />
  }
  if (favicon) return <img className="project-icon-image" src={favicon} width={size} height={size} alt="" draggable={false} />
  return <Folder size={size} aria-hidden="true" />
}

/** Emoji or preset icons, with colours for the icons. Each pick applies at once and the picker stays open. */
export function ProjectIconPicker({ project, position, onChange, onClose }: { project: Project; position: { x: number; y: number }; onChange: (icon: ProjectIconChoice | null) => void; onClose: () => void }) {
  const current = projectIconChoice(project)
  const [tab, setTab] = useState<'emoji' | 'icons'>(current?.kind === 'lucide' ? 'icons' : 'emoji')
  const [query, setQuery] = useState('')
  const [color, setColor] = useState<string | null>(current?.kind === 'lucide' ? current.color ?? null : null)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  usePopoverDismiss(true, rootRef, onClose)
  useEffect(() => { searchRef.current?.focus({ focusVisible: false } as FocusOptions) }, [])
  const words = query.trim().toLocaleLowerCase()
  const emoji = useMemo(() => PROJECT_EMOJI.filter((item) => !words || item.words.includes(words)), [words])
  const icons = useMemo(() => PROJECT_ICONS.filter((item) => !words || item.id.includes(words) || item.words.includes(words)), [words])
  const pickColour = (next: string | null) => { setColor(next); if (current?.kind === 'lucide') onChange({ ...current, color: next }) }
  const empty = tab === 'emoji' ? emoji.length === 0 : icons.length === 0
  return <div ref={rootRef} className="menu-surface project-icon-picker" role="dialog" aria-label={`Icon for ${project.name}`} style={{ left: Math.max(8, Math.min(position.x, window.innerWidth - 300)), top: Math.max(8, Math.min(position.y, window.innerHeight - 340)) }}>
    <div className="project-icon-head">
      <div className="segmented" role="radiogroup" aria-label="Icon type">
        <button type="button" role="radio" aria-checked={tab === 'emoji'} className={tab === 'emoji' ? 'on' : undefined} onClick={() => setTab('emoji')}>Emoji</button>
        <button type="button" role="radio" aria-checked={tab === 'icons'} className={tab === 'icons' ? 'on' : undefined} onClick={() => setTab('icons')}>Icons</button>
      </div>
      <button type="button" className="ghost-button small" disabled={!current} title="Goes back to the project's own favicon, or a folder" onClick={() => onChange(null)}>Reset</button>
    </div>
    <label className="project-icon-search"><Search size={13} aria-hidden="true" /><input ref={searchRef} type="search" value={query} aria-label={tab === 'emoji' ? 'Search emoji' : 'Search icons'} placeholder={tab === 'emoji' ? 'Search emoji' : 'Search icons'} spellCheck={false} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery('') } }} /></label>
    {tab === 'icons' && <div className="project-icon-colours" role="radiogroup" aria-label="Icon colour">{PROJECT_ICON_COLOURS.map((item) => <button key={item.label} type="button" role="radio" aria-checked={color === item.value} aria-label={item.label} title={item.label} className={color === item.value ? 'on' : undefined} style={{ background: item.swatch }} onClick={() => pickColour(item.value)} />)}</div>}
    {empty ? <p className="project-icon-empty">Nothing matches.</p> : <div className="project-icon-grid" style={tab === 'icons' && color ? { color } : undefined}>
      {tab === 'emoji'
        ? emoji.map((item) => <button key={item.emoji} type="button" aria-label={item.words.split(' ')[0]} aria-pressed={current?.kind === 'emoji' && current.value === item.emoji} onClick={() => onChange({ kind: 'emoji', value: item.emoji, color: null })}><span>{item.emoji}</span></button>)
        : icons.map((item) => <button key={item.id} type="button" aria-label={item.id} title={item.id} aria-pressed={current?.kind === 'lucide' && current.value === item.id} onClick={() => onChange({ kind: 'lucide', value: item.id, color })}><item.Icon size={16} aria-hidden="true" /></button>)}
    </div>}
  </div>
}
