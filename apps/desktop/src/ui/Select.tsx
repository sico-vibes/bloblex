import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search } from 'lucide-react'
import { ProviderLogo } from './providerBrand'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
  /** Starts a labelled group above this option. */
  group?: string
  groupProvider?: string
  groupBefore?: readonly { label: string; provider?: string }[]
  provider?: string
}

/**
 * Dropdown used everywhere instead of the native select, whose popup cannot be
 * styled on Windows. The trigger carries `data-value`; the list is a listbox
 * with arrow-key, Home/End, type-ahead, Enter and Escape support. Long lists
 * can pass `searchable` to get a filter field at the top of the menu.
 * Inside a dialog the menu floats above it (a portal into the page, placed against
 * the trigger, flipping upwards when there is no room below), so it never changes
 * the dialog's size or gets clipped by it.
 */
export function Select({ value, options, onChange, ariaLabel, disabled = false, variant = 'inline', align = 'right', menuPlacement = 'bottom', triggerLabel, placeholder, describedBy, className = '', searchable = false, searchPlaceholder = 'Search' }: {
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  ariaLabel: string
  disabled?: boolean
  variant?: 'inline' | 'field' | 'muted'
  align?: 'left' | 'right'
  menuPlacement?: 'top' | 'bottom'
  triggerLabel?: string
  placeholder?: string
  describedBy?: string
  className?: string
  /** Shows a filter field when there are more than this many options (true means always). */
  searchable?: boolean | number
  searchPlaceholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const [active, setActive] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [floating, setFloating] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const typeahead = useRef({ prefix: '', timer: 0 })
  const listId = useId()
  const selected = options.find((option) => option.value === value)
  const visibleTriggerLabel = triggerLabel ?? selected?.label ?? placeholder ?? ''
  const triggerAccessibleName = visibleTriggerLabel ? `${ariaLabel}, ${visibleTriggerLabel}` : ariaLabel

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current && !rootRef.current.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  const showSearch = searchable === true || (typeof searchable === 'number' && options.length > searchable)
  // Each option's group, carried down from the option that starts it, so a filtered list keeps its headings.
  const groups = groupOf(options)
  const needle = query.trim().toLocaleLowerCase()
  const visible = options.map((_, index) => index).filter((index) => !needle || matches(options[index], groups[index], needle))

  useEffect(() => {
    if (!open) return
    if (showSearch) searchRef.current?.focus()
    else listRef.current?.focus()
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active, showSearch, floating])

  useEffect(() => () => window.clearTimeout(typeahead.current.timer), [])

  const place = useCallback(() => {
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return
    const rect = trigger.getBoundingClientRect()
    const width = menu.offsetWidth
    const height = Math.min(menu.scrollHeight, 340)
    const below = window.innerHeight - rect.bottom - 12
    const above = rect.top - 12
    const up = menuPlacement === 'top' ? above >= Math.min(height, 120) || above > below : below < height && above > below
    const room = Math.min(340, Math.max(96, up ? above : below))
    const shown = Math.min(height, room)
    const left = Math.max(8, Math.min(align === 'left' ? rect.left : rect.right - width, window.innerWidth - width - 8))
    setPos({ left, top: up ? rect.top - 4 - shown : rect.bottom + 4, maxHeight: room })
  }, [align, menuPlacement])

  useLayoutEffect(() => {
    if (!open) { setFloating(false); setPos(null); return }
    setFloating(Boolean(triggerRef.current?.closest('[role="dialog"]')))
  }, [open])
  useLayoutEffect(() => {
    if (!open || !floating) return
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, floating, place, query, options.length])
  const floatStyle: CSSProperties | undefined = floating ? { position: 'fixed', right: 'auto', bottom: 'auto', left: pos?.left ?? 0, top: pos?.top ?? 0, maxHeight: pos?.maxHeight, minWidth: triggerRef.current?.offsetWidth, zIndex: 200 } : undefined
  const placement = `${align === 'left' ? 'align-left' : ''} ${menuPlacement === 'top' ? 'open-up' : ''}`.trim()
  const enabledIndexes = visible.filter((index) => !options[index].disabled)
  const openMenu = () => {
    if (disabled) return
    const current = options.findIndex((option) => option.value === value && !option.disabled)
    setActive(current >= 0 ? current : enabledIndexes[0] ?? -1)
    setOpen(true)
  }
  const close = (refocus = true) => {
    setOpen(false)
    setQuery('')
    // Focus returns synchronously so a dialog opened by onChange records the trigger as its return target.
    if (refocus) triggerRef.current?.focus()
  }
  const choose = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    close()
    if (option.value !== value) onChange(option.value)
  }
  const step = (direction: 1 | -1) => {
    if (enabledIndexes.length === 0) return
    const position = enabledIndexes.indexOf(active)
    const next = position < 0 ? (direction === 1 ? 0 : enabledIndexes.length - 1) : (position + direction + enabledIndexes.length) % enabledIndexes.length
    setActive(enabledIndexes[next])
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault()
      openMenu()
    }
  }
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = event.key
    if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (key === 'Tab') { close(false); return }
    if (key === 'ArrowDown') { event.preventDefault(); step(1); return }
    if (key === 'ArrowUp') { event.preventDefault(); step(-1); return }
    if (key === 'Home') { event.preventDefault(); setActive(enabledIndexes[0] ?? -1); return }
    if (key === 'End') { event.preventDefault(); setActive(enabledIndexes.at(-1) ?? -1); return }
    if (key === 'Enter' || key === ' ') { event.preventDefault(); choose(active); return }
    if (key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const prefix = `${typeahead.current.prefix}${key}`.toLocaleLowerCase()
      typeahead.current.prefix = prefix
      window.clearTimeout(typeahead.current.timer)
      typeahead.current.timer = window.setTimeout(() => { typeahead.current.prefix = '' }, 600)
      const match = enabledIndexes.find((index) => options[index].label.toLocaleLowerCase().startsWith(prefix))
      if (match !== undefined) setActive(match)
    }
  }

  return <div ref={rootRef} className={`select ${variant === 'inline' ? '' : variant} ${open ? 'open' : ''} ${className}`.replace(/\s+/g, ' ').trim()}>
    <button
      ref={triggerRef}
      type="button"
      className="select-trigger"
      aria-label={triggerAccessibleName}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-describedby={describedBy}
      data-value={value}
      disabled={disabled}
      onClick={() => open ? close() : openMenu()}
      onKeyDown={onTriggerKeyDown}
    >
      <span className={selected?.provider ? 'select-provider-label' : undefined}>{selected?.provider && <ProviderLogo provider={selected.provider} size={16} />}{visibleTriggerLabel}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && wrapFloat(floating, <SearchShell enabled={showSearch} className={placement} shellRef={menuRef} style={floatStyle}>
    {showSearch && <label className="select-search">
      <Search size={13} aria-hidden="true" />
      <input
        ref={searchRef}
        type="text"
        value={query}
        placeholder={searchPlaceholder}
        aria-label={`Search ${ariaLabel.toLocaleLowerCase()}`}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value
          setQuery(next)
          const nextNeedle = next.trim().toLocaleLowerCase()
          const first = options.findIndex((option, index) => !option.disabled && (!nextNeedle || matches(option, groups[index], nextNeedle)))
          setActive(first)
        }}
        onKeyDown={(event) => {
          if (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete' || event.key === 'ArrowLeft' || event.key === 'ArrowRight' || (event.key === ' ' && query)) return
          onListKeyDown(event as unknown as KeyboardEvent<HTMLDivElement>)
        }}
      />
    </label>}
    <div
      ref={(node) => { listRef.current = node; if (!showSearch) menuRef.current = node }}
      style={showSearch ? undefined : floatStyle}
      id={listId}
      className={showSearch ? 'select-list' : `select-menu ${placement}`}
      role="listbox"
      aria-label={ariaLabel}
      tabIndex={-1}
      aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
      onKeyDown={onListKeyDown}
    >
      {visible.length === 0 && <div className="select-empty" role="presentation">No matches</div>}
      {visible.map((index, position) => {
        const option = options[index]
        const previous = position > 0 ? visible[position - 1] : -1
        const heading = needle
          ? (groups[index] && groups[index] !== (previous >= 0 ? groups[previous] : undefined) ? { label: groups[index]!, provider: undefined } : null)
          : (option.group ? { label: option.group, provider: option.groupProvider } : null)
        return [
        ...(needle ? [] : option.groupBefore ?? []).map((group, groupIndex) => <div key={`group-before-${index}-${groupIndex}`} className={`select-group-label ${group.provider ? 'provider-group-label' : ''}`} role="presentation">{group.provider && <ProviderLogo provider={group.provider} size={16} />}{group.label}</div>),
        heading ? <div key={`group-${index}`} className={`select-group-label ${heading.provider ? 'provider-group-label' : ''}`} role="presentation">{heading.provider && <ProviderLogo provider={heading.provider} size={16} />}{heading.label}</div> : null,
        <div
          key={`${option.value}-${index}`}
          id={`${listId}-${index}`}
          role="option"
          className={`select-option ${index === active ? 'active' : ''}`}
          data-active={index === active}
          data-value={option.value}
          aria-selected={option.value === value}
          aria-disabled={option.disabled || undefined}
          onPointerEnter={() => { if (!option.disabled) setActive(index) }}
          onClick={() => choose(index)}
        >
          <span className={option.provider ? 'select-provider-label' : undefined}>{option.provider && <ProviderLogo provider={option.provider} size={16} />}{option.label}</span>
          {option.value === value && <Check size={14} aria-hidden="true" />}
        </div>,
      ]})}
    </div>
    </SearchShell>)}
  </div>
}

/** A floating menu is portalled to the page body; the menu bubbles React events to the Select as before. */
function wrapFloat(floating: boolean, menu: ReactNode) {
  return floating ? createPortal(menu, document.body) : menu
}

/** With search on, the field and the list share one floating surface; otherwise the list is the surface. */
function SearchShell({ enabled, className, children, shellRef, style }: { enabled: boolean; className: string; children: ReactNode; shellRef: { current: HTMLDivElement | null }; style?: CSSProperties }) {
  return enabled ? <div ref={(node) => { shellRef.current = node }} style={style} className={`select-menu select-menu-search ${className}`}>{children}</div> : <>{children}</>
}

function groupOf(options: readonly SelectOption[]) {
  let current: string | undefined
  return options.map((option) => {
    if (option.group) current = option.group
    return current
  })
}

function matches(option: SelectOption, group: string | undefined, needle: string) {
  return option.label.toLocaleLowerCase().includes(needle)
    || option.value.toLocaleLowerCase().includes(needle)
    || (group ?? '').toLocaleLowerCase().includes(needle)
}
