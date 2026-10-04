import { useEffect, useRef } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { PermissionRequest } from '../types'
import { formatUnknownSafe } from '../types'
import { PermissionChoiceButton } from './PermissionChoiceButton'
import { permissionChoiceLabel } from './permissionChoices'

function choicesForShortcuts(choices: string[]) {
  const words = (choice: string) => choice.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_/.-]+/g, ' ').trim().toLocaleLowerCase().split(/\s+/)
  return {
    allow: choices.find((choice) => ['allow', 'approve', 'accept'].includes(words(choice)[0] ?? '')) ?? null,
    deny: choices.find((choice) => ['deny', 'reject', 'decline'].includes(words(choice)[0] ?? '')) ?? null,
  }
}

export function ApprovalCard({ permission, onReply, focusOnMount = true, variant = 'main' }: {
  permission: PermissionRequest
  onReply: (choice: string) => boolean | void | Promise<boolean | void>
  focusOnMount?: boolean
  variant?: 'main' | 'companion'
}) {
  const cardRef = useRef<HTMLElement>(null)
  const handledShortcut = useRef<string | null>(null)
  const choices = permission.choices ?? []
  const shortcuts = choicesForShortcuts(choices)
  const detail = typeof permission.detail === 'string' ? permission.detail : typeof permission.description === 'string' ? permission.description : typeof permission.command === 'string' ? permission.command : null
  const tool = typeof permission.tool === 'string' ? permission.tool : null
  const deadline = typeof permission.expiresAt === 'string' ? Date.parse(permission.expiresAt) : Number.NaN
  useEffect(() => {
    handledShortcut.current = null
    if (focusOnMount) requestAnimationFrame(() => cardRef.current?.focus())
  }, [focusOnMount, permission.id])
  const replyFromShortcut = (choice: string) => {
    if (handledShortcut.current === permission.id) return
    handledShortcut.current = permission.id
    try {
      const result = onReply(choice)
      if (typeof result === 'object' && result !== null) {
        void result.then((accepted) => { if (accepted === false && handledShortcut.current === permission.id) handledShortcut.current = null })
          .catch(() => { if (handledShortcut.current === permission.id) handledShortcut.current = null })
      } else if (result === false) handledShortcut.current = null
    } catch { handledShortcut.current = null }
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target && (target.matches('input,textarea,select,[contenteditable="true"]') || target.closest('[data-composer]'))) return
    if (event.key === 'Enter' && target === cardRef.current && shortcuts.allow) { event.preventDefault(); replyFromShortcut(shortcuts.allow) }
    if (event.key === 'Escape' && shortcuts.deny) {
      event.preventDefault()
      event.stopPropagation()
      replyFromShortcut(shortcuts.deny)
    }
  }
  return <section ref={cardRef} tabIndex={-1} data-permission-card="" className={`permission-card ${variant === 'companion' ? 'companion-approval-card' : ''}`} onKeyDown={onKeyDown} aria-label="Approval requested">
    <div className="permission-icon"><ShieldAlert size={17} /></div><div className="permission-copy">
      <strong>{formatUnknownSafe(permission.title, 'Approval requested')}</strong><p>{detail ?? `The agent requested permission${tool ? ` to use ${tool}` : ''}.`}</p>
      {Number.isFinite(deadline) && <small className="permission-deadline">Expires {new Date(deadline).toLocaleTimeString()}</small>}
      <div className="permission-actions">{choices.map((choice) => <PermissionChoiceButton key={choice} permission={permission} choice={choice} className={`permission-choice ${choice === shortcuts.allow ? 'permission-choice-primary' : ''} ${choice === shortcuts.deny ? 'permission-choice-secondary' : ''} ${variant === 'companion' ? 'companion-permission-choice' : ''}`} onReply={onReply}>{permissionChoiceLabel(choice)}{choice === shortcuts.allow && <kbd>Enter</kbd>}{choice === shortcuts.deny && <kbd>Esc</kbd>}</PermissionChoiceButton>)}</div>
    </div>
  </section>
}
