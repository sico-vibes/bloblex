import { useEffect, useState } from 'react'
import type { PermissionRequest } from '../types'
import { isPendingPermissionLive, nextPermissionDeadline } from './permissionSelection'

/** A provider choice stays opaque; this button only enforces the request deadline. */
export function PermissionChoiceButton({ permission, choice, onReply, children, className }: {
  permission: PermissionRequest
  choice: string
  onReply: (choice: string) => void
  children: React.ReactNode
  className?: string
}) {
  const [now, setNow] = useState(() => Date.now())
  const live = isPendingPermissionLive(permission, now)

  useEffect(() => {
    const deadline = nextPermissionDeadline([permission], now)
    if (deadline === null) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(Math.max(1, deadline - now + 1), 2_147_000_000))
    return () => window.clearTimeout(timer)
  }, [permission, now])

  return <button type="button" className={className} disabled={!live} aria-disabled={!live} onClick={() => {
    if (isPendingPermissionLive(permission, Date.now())) onReply(choice)
    else setNow(Date.now())
  }}>{children}</button>
}
