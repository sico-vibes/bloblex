import { useEffect } from 'react'
import { matchesShortcut } from './shortcuts'

export function useQuickSwitcherShortcut(enabled: boolean, onOpen: () => void, keys: string | null = 'Ctrl+K') {
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, keys)) return
      event.preventDefault()
      onOpen()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [enabled, onOpen, keys])
}
