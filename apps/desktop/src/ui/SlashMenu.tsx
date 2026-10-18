import { Fragment } from 'react'
import { Activity, BookOpen, BookmarkPlus, CheckSquare, ClipboardList, CircleHelp, Compass, FileDown, Gauge, MessageSquarePlus, Pencil, Users, type LucideIcon, MessagesSquare, Cpu } from 'lucide-react'
import { X } from 'lucide-react'
import type { SlashCommand, SlashItem } from './slashCommands'

/** A per-command icon; the same row shape as the mention picker and command palette. */
const ICONS: Record<string, LucideIcon> = {
  plan: ClipboardList,
  new: MessageSquarePlus,
  model: Cpu,
  effort: Gauge,
  rename: Pencil,
  export: FileDown,
  help: CircleHelp,
  interview: MessagesSquare,
  onboard: Compass,
  team: Users,
  status: Activity,
  playbook: BookOpen,
  remember: BookmarkPlus,
}

/** Autocomplete for `/commands` in the composer. Never covers the composer text. */
export function SlashMenu({ items, activeIndex, onPick, onHover }: {
  items: SlashItem[]
  activeIndex: number
  onPick: (item: SlashItem) => void
  onHover: (index: number) => void
}) {
  if (!items.length) return null
  let lastGroup = ''
  return <div className="slash-menu" role="listbox" aria-label="Commands">
    {items.map((item, index) => {
      const header = item.group !== lastGroup ? item.group : null
      lastGroup = item.group
      const Icon = ICONS[item.name] ?? CheckSquare
      return <Fragment key={`${item.kind}:${item.name}`}>
        {header && <div className="slash-menu-group" role="presentation">{header}</div>}
        <button type="button" role="option" aria-selected={index === activeIndex} className={`slash-option ${index === activeIndex ? 'active' : ''}`} onMouseDown={(event) => { event.preventDefault(); onPick(item) }} onMouseEnter={() => onHover(index)}>
          <span className="slash-option-icon"><Icon size={14} aria-hidden="true" /></span>
          <span className="slash-option-text"><strong>/{item.name}</strong><small>{item.description}</small></span>
          {item.shortcut && <kbd className="slash-option-kbd">{item.shortcut}</kbd>}
        </button>
      </Fragment>
    })}
  </div>
}

/** The picked command, shown at the start of the message like the reply strip. */
export function SlashCommandChip({ command, onRemove }: { command: SlashCommand; onRemove: () => void }) {
  return <div className="slash-chip-row">
    <span className="slash-chip" title={command.kind === 'manager' ? 'Manager command for this message' : 'Skill for this message'}>
      <span className="slash-chip-tag">{command.kind === 'manager' ? 'Manager' : 'Skill'}</span>
      <strong>/{command.name}</strong>
      <button type="button" className="slash-chip-remove" aria-label={`Remove /${command.name}`} onClick={onRemove}><X size={11} aria-hidden="true" /></button>
    </span>
  </div>
}
