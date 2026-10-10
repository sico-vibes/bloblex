import { useCallback, useLayoutEffect, useRef, useEffect, useState } from 'react'

const dialogStack: Array<() => void> = []

export function useDialogAccessibility(onClose: () => void, canClose: () => boolean = () => true) {
  const ref = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  const canCloseRef = useRef(canClose)
  const dismissed = useRef(false)
  const restored = useRef(false)
  const restoreFocus = useRef<() => void>(() => undefined)
  closeRef.current = onClose
  canCloseRef.current = canClose
  const close = useCallback(() => {
    if (dismissed.current || !canCloseRef.current()) return
    dismissed.current = true
    closeRef.current()
    restoreFocus.current()
  }, [])

  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const wasDismissed = dismissed.current
    restored.current = false
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    restoreFocus.current = () => {
      if (restored.current) return
      restored.current = true
      previous?.focus()
    }
    dialogStack.push(close)
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')).filter((node) => !node.hasAttribute('aria-hidden'))
    const initial = root.querySelector<HTMLElement>('[data-dialog-initial-focus]') ?? focusables()[0]
    const frame = wasDismissed ? null : requestAnimationFrame(() => {
      if (!dismissed.current && root.isConnected) initial?.focus()
    })
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
      if (frame !== null) cancelAnimationFrame(frame)
      document.removeEventListener('keydown', keydown)
      const index = dialogStack.lastIndexOf(close)
      if (index >= 0) dialogStack.splice(index, 1)
      restoreFocus.current()
    }
  }, [])
  return { ref, close }
}

/** True one frame after mount, so `.blob-dialog-backdrop.is-entered` can transition in. */
export function useDialogEntered() {
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  return entered
}
