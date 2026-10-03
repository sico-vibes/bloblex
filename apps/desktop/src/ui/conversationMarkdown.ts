import type { Session } from '../types'
import { buildConversationItems } from './conversation'

export function conversationMarkdown(session: Session, blobName: string, exportedAt = new Date()): string {
  const projectPath = session.projectPath ?? ''
  const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? 'Unknown project'
  const dateValue = session.createdAt ?? session.updatedAt ?? exportedAt.toISOString()
  const date = new Date(dateValue)
  const dateLabel = Number.isNaN(date.valueOf()) ? 'Unknown date' : date.toISOString().slice(0, 10)
  const title = safeTitle(session.title)
  const lines = [`# ${title}`, '', `- Blob: ${safeTitle(blobName)}`, `- Project: ${safeTitle(projectName)}`, `- Date: ${dateLabel}`, '']
  for (const item of buildConversationItems(session)) {
    if (item.kind === 'message') {
      const role = String(item.value?.role ?? item.value?.kind ?? 'agent').toLowerCase() === 'user' ? 'You' : safeTitle(blobName)
      const text = messageText(item.value)
      if (text) lines.push(`## ${role}`, '', text, '')
      continue
    }
    const activity = item.activity ?? {}
    const action = item.activityKind === 'file' ? 'File activity' : item.activityKind === 'turn' ? 'Turn activity' : 'Tool activity'
    const reportedState = String(activity.state ?? activity.status ?? '').toLowerCase()
    const state = ['completed', 'failed', 'running', 'started', 'rejected', 'reported'].includes(reportedState) ? reportedState : 'reported'
    lines.push(`- Activity: ${action} (${state})`)
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function messageText(value: Record<string, unknown> | undefined) {
  const content = value?.text ?? value?.content ?? value?.delta
  return typeof content === 'string' ? content.trim() : ''
}

function safeTitle(value: unknown) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim() || 'Untitled conversation'
}
