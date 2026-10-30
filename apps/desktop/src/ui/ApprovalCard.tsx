import { Fragment, useEffect, useRef, useState } from 'react'
import { Check, Copy, ShieldAlert } from 'lucide-react'
import type { PermissionRequest } from '../types'
import { formatUnknownSafe } from '../types'
import { PermissionChoiceButton } from './PermissionChoiceButton'
import { permissionChoiceLabel } from './permissionChoices'

/** "in 4 min" / "in 30 s" / "now" for an absolute deadline. */
export function expiresIn(deadlineMs: number, now: number): string {
  const seconds = Math.round((deadlineMs - now) / 1000)
  if (seconds <= 0) return 'now'
  if (seconds < 90) return 'in ' + seconds + ' s'
  return 'in ' + Math.round(seconds / 60) + ' min'
}

function choicesForShortcuts(choices: string[]) {
  const words = (choice: string) => choice.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_/.-]+/g, ' ').trim().toLocaleLowerCase().split(/\s+/)
  return {
    allow: choices.find((choice) => ['allow', 'approve', 'accept'].includes(words(choice)[0] ?? '')) ?? null,
    deny: choices.find((choice) => ['deny', 'reject', 'decline'].includes(words(choice)[0] ?? '')) ?? null,
  }
}

/** Options a reply carries to `permission.reply`. Phase 1A: an Always rule is for this project or for every project. */
export type PermissionReplyOptions = { remember?: boolean; rememberScope?: 'project' | 'bot' }

export function ApprovalCard({ permission, onReply, focusOnMount = true, variant = 'main' }: {
  permission: PermissionRequest
  onReply: (choice: string, options?: PermissionReplyOptions) => boolean | void | Promise<boolean | void>
  focusOnMount?: boolean
  variant?: 'main' | 'companion'
}) {
  const cardRef = useRef<HTMLElement>(null)
  const handledShortcut = useRef<string | null>(null)
  const choices = permission.choices ?? []
  const shortcuts = choicesForShortcuts(choices)
  const [now, setNow] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)
  // The daemon marks a request it can remember (same bot, same command or file, a safe kind); "Always allow" saves a rule.
  const rememberable = (permission as { rememberable?: unknown }).rememberable === true && !!shortcuts.allow
  const rememberLabel = typeof (permission as { rememberLabel?: unknown }).rememberLabel === 'string' ? String((permission as { rememberLabel?: unknown }).rememberLabel) : ''
  // Phase 1A: a request that knows its conversation's project can be remembered for that project only.
  const projectName = typeof (permission as { projectName?: unknown }).projectName === 'string' ? String((permission as { projectName?: unknown }).projectName).trim() : ''
  const what = rememberLabel ? `: ${rememberLabel}` : ''
  const command = typeof permission.command === 'string' && permission.command.trim() ? permission.command : null
  const detail = typeof permission.detail === 'string' ? permission.detail : typeof permission.description === 'string' ? permission.description : null
  const tool = typeof permission.tool === 'string' ? permission.tool : null
  const deadline = typeof permission.expiresAt === 'string' ? Date.parse(permission.expiresAt) : Number.NaN
  useEffect(() => {
    if (!Number.isFinite(deadline)) return
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [deadline])
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copyCommand = async () => {
    if (!command || !navigator.clipboard?.writeText) return
    try { await navigator.clipboard.writeText(command); setCopied(true) } catch { /* clipboard may be blocked; the command stays selectable */ }
  }
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
  return <section ref={cardRef} tabIndex={-1} data-permission-card="" data-tour={variant === "main" ? "approval" : undefined} className={`permission-card ${variant === 'companion' ? 'companion-approval-card' : ''}`} onKeyDown={onKeyDown} aria-label="Approval requested">
    <div className="permission-icon"><ShieldAlert size={17} /></div><div className="permission-copy">
      <div className="permission-head">
        <strong>{formatUnknownSafe(permission.title, 'Approval requested')}</strong>
        {tool && <span className="permission-tool">{tool}</span>}
        {Number.isFinite(deadline) && <small className="permission-deadline" title={new Date(deadline).toLocaleTimeString()}>Expires {expiresIn(deadline, now)}</small>}
      </div>
      {detail ? <p>{detail}</p> : !command && <p>{`The agent requested permission${tool ? ` to use ${tool}` : ''}.`}</p>}
      {command && <div className="permission-command"><pre><code>{command}</code></pre><button type="button" className="permission-copy-button" aria-label={copied ? 'Command copied' : 'Copy command'} title={copied ? 'Copied' : 'Copy command'} onClick={() => void copyCommand()}>{copied ? <Check size={13} /> : <Copy size={13} />}</button></div>}
      <div className="permission-actions">{choices.map((choice) => <Fragment key={choice}><PermissionChoiceButton permission={permission} choice={choice} className={`permission-choice ${choice === shortcuts.allow ? 'permission-choice-primary' : ''} ${choice === shortcuts.deny ? 'permission-choice-secondary' : ''} ${variant === 'companion' ? 'companion-permission-choice' : ''}`} onReply={onReply}>{permissionChoiceLabel(choice)}{choice === shortcuts.allow && <kbd>Enter</kbd>}{choice === shortcuts.deny && <kbd>Esc</kbd>}</PermissionChoiceButton>{choice === shortcuts.allow && rememberable && (projectName
        ? <>
          <PermissionChoiceButton permission={permission} choice={shortcuts.allow!} className={`permission-choice permission-choice-always ${variant === 'companion' ? 'companion-permission-choice' : ''}`} title={`Always allow for this bot in ${projectName}${what}. You can change or remove it in Settings → Approvals.`} onReply={(choice) => onReply(choice, { remember: true, rememberScope: 'project' })}>Always in {projectName}</PermissionChoiceButton>
          <PermissionChoiceButton permission={permission} choice={shortcuts.allow!} className={`permission-choice permission-choice-always ${variant === 'companion' ? 'companion-permission-choice' : ''}`} title={`Always allow for this bot in every project${what}. You can change or remove it in Settings → Approvals.`} onReply={(choice) => onReply(choice, { remember: true, rememberScope: 'bot' })}>Always, every project</PermissionChoiceButton>
        </>
        : <PermissionChoiceButton permission={permission} choice={shortcuts.allow!} className={`permission-choice permission-choice-always ${variant === 'companion' ? 'companion-permission-choice' : ''}`} title={rememberLabel ? `Always allow for this bot: ${rememberLabel}. You can remove it in Settings → Approvals.` : 'Always allow this for this bot. You can remove it in Settings → Approvals.'} onReply={(choice) => onReply(choice, { remember: true })}>Always allow</PermissionChoiceButton>)}</Fragment>)}</div>
    </div>
  </section>
}
