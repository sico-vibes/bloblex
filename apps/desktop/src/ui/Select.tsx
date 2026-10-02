import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
  /** Starts a labelled group above this option. */
  group?: string
}

/**
 * Dropdown used everywhere instead of the native select, whose popup cannot be
 * styled on Windows. The trigger carries `data-value`; the list is a listbox
 * with arrow-key, Home/End, type-ahead, Enter and Escape support.
 */
export function Select({ value, options, onChange, ariaLabel, disabled = false, variant = 'inline', align = 'right', placeholder, describedBy, className = '' }: {
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  ariaLabel: string
  disabled?: boolean
  variant?: 'inline' | 'field' | 'muted'
  align?: 'left' | 'right'
  placeholder?: string
  describedBy?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ prefix: '', timer: 0 })
  const listId = useId()
  const selected = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  useEffect(() => {
    if (!open) return
    listRef.current?.focus()
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active])

  useEffect(() => () => window.clearTimeout(typeahead.current.timer), [])

  const enabledIndexes = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0)
  const openMenu = () => {
    if (disabled) return
    const current = options.findIndex((option) => option.value === value && !option.disabled)
    setActive(current >= 0 ? current : enabledIndexes[0] ?? -1)
    setOpen(true)
  }
  const close = (refocus = true) => {
    setOpen(false)
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
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-describedby={describedBy}
      data-value={value}
      disabled={disabled}
      onClick={() => open ? close() : openMenu()}
      onKeyDown={onTriggerKeyDown}
    >
      <span>{selected?.label ?? placeholder ?? ''}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div
      ref={listRef}
      id={listId}
      className={`select-menu ${align === 'left' ? 'align-left' : ''}`}
      role="listbox"
      aria-label={ariaLabel}
      tabIndex={-1}
      aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
      onKeyDown={onListKeyDown}
    >
      {options.map((option, index) => [
        option.group ? <div key={`group-${index}`} className="select-group-label" role="presentation">{option.group}</div> : null,
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
          <span>{option.label}</span>
          {option.value === value && <Check size={14} aria-hidden="true" />}
        </div>,
      ])}
    </div>}
  </div>
}
