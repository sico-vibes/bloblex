import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import { ChevronsUpDown, Gauge, LogOut, Pencil, RefreshCw, Settings2 } from 'lucide-react'
import type { ConnectionState } from '../types'

const NAME_KEY = 'bloblex.profile.name'
const SKIPPED_KEY = 'bloblex.profile.skipped'

export function readProfileName() {
  try { return localStorage.getItem(NAME_KEY)?.trim() ?? '' } catch { return '' }
}

function writeProfileName(name: string) {
  try {
    if (name) localStorage.setItem(NAME_KEY, name)
    else localStorage.removeItem(NAME_KEY)
  } catch { /* A blocked Storage API keeps the name for this run only. */ }
}

function onboardingSkipped() {
  try { return localStorage.getItem(SKIPPED_KEY) === '1' } catch { return false }
}

function skipOnboarding() {
  try { localStorage.setItem(SKIPPED_KEY, '1') } catch { /* in-memory only */ }
}

export function profileInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  const letters = words.length === 1 ? Array.from(words[0]).slice(0, 2) : [Array.from(words[0])[0], Array.from(words[words.length - 1])[0]]
  return letters.join('').toLocaleUpperCase()
}

/**
 * Bottom-left account button. Everything that used to sit in the sidebar foot
 * (usage, agent scan, settings, quit) lives in its menu, like a chat app's
 * profile menu. The name is local to this device.
 */
export function ProfileMenu({ connection, usageActive, refreshing, triggerRef, onUsage, onFindAgents, onSettings, onQuit }: {
  connection: ConnectionState
  usageActive: boolean
  refreshing: boolean
  triggerRef?: RefObject<HTMLButtonElement | null>
  onUsage: () => void
  onFindAgents: () => void
  onSettings: () => void
  onQuit: () => void
}) {
  const [name, setName] = useState(readProfileName)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(() => !readProfileName() && !onboardingSkipped())
  const [draft, setDraft] = useState(name)
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const ownTrigger = useRef<HTMLButtonElement>(null)
  const trigger = triggerRef ?? ownTrigger
  const connected = connection === 'connected'

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const close = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  const closeMenu = (refocus = true) => {
    setOpen(false)
    if (refocus) window.setTimeout(() => trigger.current?.focus(), 0)
  }
  const run = (action: () => void) => { closeMenu(false); action() }
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return }
    let next = -1
    if (event.key === 'ArrowDown') next = (index + 1) % items.length
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    if (next >= 0 && items.length) { event.preventDefault(); items[next]?.focus() }
  }
  const saveName = (event: FormEvent) => {
    event.preventDefault()
    const next = draft.trim().slice(0, 40)
    writeProfileName(next)
    setName(next)
    setEditing(false)
  }
  const dismissEditor = () => {
    if (!name) skipOnboarding()
    setDraft(name)
    setEditing(false)
  }

  const initials = profileInitials(name)
  const statusText = connected ? 'On this device' : connection === 'connecting' ? 'Connecting…' : 'Offline'

  return <div className="sidebar-foot" ref={wrapRef}>
    {editing && <form className="profile-onboarding" aria-label="Your name" onSubmit={saveName}>
      <strong>{name ? 'Edit your name' : 'Welcome to Bloblex'}</strong>
      <p>{name ? 'This name is shown in the sidebar and stays on this device.' : 'What should Bloblex call you? It stays on this device.'}</p>
      <input className="text-input" aria-label="Your name" value={draft} maxLength={40} placeholder="Your name" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') dismissEditor() }} />
      <div className="profile-onboarding-actions">
        <button type="button" className="ghost-button small" onClick={dismissEditor}>{name ? 'Cancel' : 'Not now'}</button>
        <button type="submit" className="primary-button small" disabled={!draft.trim()}>Save name</button>
      </div>
    </form>}
    <div className="profile-anchor">
    <button
      ref={trigger}
      type="button"
      className={`profile-button ${open ? 'open' : ''}`}
      aria-label="Account and settings"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-current={usageActive ? 'page' : undefined}
      onClick={() => setOpen((current) => !current)}
    >
      <span className={`profile-avatar ${initials ? '' : 'empty'}`} aria-hidden="true">{initials || '?'}<i className={`presence ${connection}`} /></span>
      <span className="profile-copy"><strong>{name || 'Your profile'}</strong><small>{statusText}</small></span>
      <ChevronsUpDown size={14} aria-hidden="true" />
    </button>
    {open && <div ref={menuRef} className="menu-surface profile-menu" role="menu" aria-label="Account" onKeyDown={onMenuKeyDown}>
      <button type="button" role="menuitem" className="menu-item" disabled={!connected} onClick={() => run(onUsage)}><Gauge size={15} />Usage</button>
      <button type="button" role="menuitem" className="menu-item" disabled={!connected || refreshing} onClick={() => run(onFindAgents)}><RefreshCw size={15} className={refreshing ? 'spinning' : ''} />Find coding agents</button>
      <button type="button" role="menuitem" className="menu-item" onClick={() => run(onSettings)}><Settings2 size={15} />Settings</button>
      <span className="menu-separator" role="separator" />
      <button type="button" role="menuitem" className="menu-item" onClick={() => run(() => { setDraft(name); setEditing(true) })}><Pencil size={15} />{name ? 'Edit name' : 'Add your name'}</button>
      <button type="button" role="menuitem" className="menu-item danger" onClick={() => run(onQuit)}><LogOut size={15} />Quit Bloblex</button>
    </div>}
    </div>
  </div>
}
