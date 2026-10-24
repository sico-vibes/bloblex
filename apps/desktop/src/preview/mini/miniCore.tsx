// Shared pieces of the Mini skin study: the variant table, the store, the
// runtime logo and the status aura (the animated gradient that replaces the
// mascots as each bot's status).
import { createContext, useContext, type CSSProperties } from 'react'
import { Star } from 'lucide-react'
import { RUNTIME_NAME, shift, type Bot, type LogoMode, type Session, type Status, type Task } from './miniData'

const providerAssets = import.meta.glob('../../assets/providers/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const asset = (name: string) => Object.entries(providerAssets).find(([path]) => path.endsWith(`/${name}.svg`))?.[1] ?? ''

export type VariantId = '1' | '2' | '3'
export type AuraKind = 'band' | 'comet' | 'mist'
export interface Variant {
  id: VariantId; name: string; note: string; mode: 'dark' | 'light'; aura: AuraKind
  nav: 'sidebar' | 'tabs' | 'rail'; board: 'lanes' | 'columns'; companion: 'stack' | 'dock' | 'rail'
}
export const VARIANTS: Variant[] = [
  { id: '1', name: 'Haze', note: 'Smoky glass, a wide wave that rolls in from the right', mode: 'dark', aura: 'band', nav: 'sidebar', board: 'lanes', companion: 'stack' },
  { id: '2', name: 'Vision', note: 'Warm frosted glass, a comet trail that streams left', mode: 'dark', aura: 'comet', nav: 'tabs', board: 'columns', companion: 'dock' },
  { id: '3', name: 'Aurora', note: 'Cool deep glass, drifting colour mist', mode: 'dark', aura: 'mist', nav: 'rail', board: 'lanes', companion: 'rail' },
]

export type Screen = 'chat' | 'tasks'
export type TasksView = 'board' | 'timeline' | 'tree'

export interface MiniState {
  variant: Variant; bots: Bot[]; tasks: Task[]; sessions: Session[]; selected: string | null; screen: Screen; tasksView: TasksView
  logoMode: LogoMode; now: number; paused: boolean; openTask: string | null; dragOver: string | null; dragging: string | null
}
export interface MiniActions {
  select: (id: string | null) => void; setScreen: (screen: Screen) => void; setTasksView: (view: TasksView) => void
  setStatus: (botId: string, status: Status) => void; updateBot: (botId: string, patch: Partial<Bot>) => void
  updateTask: (id: string, patch: Partial<Task>) => void; removeTask: (id: string) => void; openTask: (id: string | null) => void
  dispatch: (taskId: string, botId: string) => string; unassign: (taskId: string) => void; askManager: (ask: string) => void
  setPaused: (paused: boolean) => void; setDrag: (taskId: string | null, over: string | null) => void
}
export const MiniContext = createContext<{ state: MiniState; act: MiniActions } | null>(null)
export function useMini() { const value = useContext(MiniContext); if (!value) throw new Error('MiniContext'); return value }

export const botById = (bots: Bot[], id: string | null) => bots.find((bot) => bot.id === id)

/* ------------------------------------------------------------------ logo */

/** The runtime's logo in its own colours, tinted with the bot's colour, or in the text colour. */
export function Logo({ bot, size = 18, mode, light }: { bot: Bot; size?: number; mode: LogoMode; light: boolean }) {
  const chosen = bot.logo ?? mode
  const file = bot.runtime === 'claude' ? 'claude' : `${bot.runtime}-${light ? 'light' : 'dark'}`
  const url = asset(file)
  const box = { width: size, height: size } as CSSProperties
  return <span className={`mini-logo${bot.manager ? ' is-manager' : ''}`} style={box} role="img" aria-label={RUNTIME_NAME[bot.runtime]}>
    {chosen === 'original'
      ? <img src={url} width={size} height={size} alt="" draggable={false} />
      : <span className="mini-logo-mask" style={{ WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")`, background: chosen === 'tint' ? bot.color : 'currentColor' }} />}
    {bot.manager && <span className="mini-manager-star" aria-hidden="true"><Star size={Math.max(6, size * .36)} fill="currentColor" strokeWidth={0} /></span>}
  </span>
}

/* ------------------------------------------------------------------ aura */

const GOLD = ['#e7b24a', '#f6d27a', '#c98a2b']
/**
 * The status gradient. Shown only while a bot is doing something or is
 * selected (the Manager keeps a still golden fade). Speed and colourfulness
 * carry the state: idle-selected is slow and muted, thinking is two close
 * hues, working is fast with three hues, needs-you breathes amber, a failure
 * falters in red, and finishing sweeps green once.
 */
export function Aura({ bot, status, selected, kind, quiet = false }: { bot: Bot; status: Status; selected: boolean; kind: AuraKind; quiet?: boolean }) {
  const manager = !!bot.manager
  if (status === 'idle' && !selected && !manager) return null
  const idleState = status === 'idle'
  const colours = status === 'needs' ? ['#ffb347', '#ff7a45', '#ffd98a']
    : status === 'error' ? ['#ff5a5f', '#d6336c', '#ff9a8a']
    : status === 'done' ? ['#3ddc97', '#8ef0c8', '#2bb3a3']
    : manager ? (idleState ? GOLD : [GOLD[0], '#ffcf6b', shift(GOLD[0], -18, 10, -6)])
    : status === 'working' ? [bot.color, shift(bot.color, 42, 12, 6), shift(bot.color, -38, 8, 12)]
    : status === 'thinking' ? [bot.color, shift(bot.color, 16, 0, 12), shift(bot.color, -10, -5, 4)]
    : [shift(bot.color, 0, -40, 0), shift(bot.color, 8, -50, 12), shift(bot.color, -8, -45, 6)]
  const timing: Record<Status, [string, number]> = { working: ['2.4s', .72], thinking: ['5.5s', .52], needs: ['4s', .62], error: ['9s', .52], done: ['2.2s', .62], idle: [manager ? '16s' : '14s', manager ? .38 : .3] }
  const [dur, alpha] = timing[status]
  const style = { '--c1': colours[0], '--c2': colours[1], '--c3': colours[2], '--dur': dur, '--alpha': quiet ? alpha * .7 : alpha } as CSSProperties
  const still = manager && idleState && !selected
  return <span className={`aura aura-${kind} aura-${status}${selected ? ' is-selected' : ''}${still ? ' is-still' : ''}`} style={style} aria-hidden="true"><i /><i /><i /></span>
}

export const STATUS_WORD: Record<Status, string> = { idle: 'Idle', thinking: 'Thinking', working: 'Working', needs: 'Needs you', error: 'Failed', done: 'Done' }
