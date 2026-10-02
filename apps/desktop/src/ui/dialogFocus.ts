import { useEffect, useRef } from 'react'

const dialogStack: Array<() => void> = []

export function useDialogAccessibility(onClose: () => void) {
  const ref = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const close = () => closeRef.current()
    dialogStack.push(close)
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')).filter((node) => !node.hasAttribute('aria-hidden'))
    const initial = root.querySelector<HTMLElement>('[data-dialog-initial-focus]') ?? focusables()[0]
    const frame = requestAnimationFrame(() => initial?.focus())
    const keydown = (event: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== close) return
      if (event.key === 'Escape') { event.preventDefault(); close(); return }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) { event.preventDefault(); root.focus(); return }
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', keydown)
      const index = dialogStack.lastIndexOf(close)
      if (index >= 0) dialogStack.splice(index, 1)
      previous?.focus()
    }
  }, [])
  return ref
}
