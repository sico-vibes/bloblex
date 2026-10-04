import { useEffect } from 'react'

export function useQuickSwitcherShortcut(enabled: boolean, onOpen: () => void) {
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== 'k') return
      event.preventDefault()
      onOpen()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [enabled, onOpen])
}
