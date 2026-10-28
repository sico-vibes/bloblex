// One short line for what a bot is doing right now, from the provider-neutral
// tool record the daemon keeps (`tool_detail` in storage): "Running npm test",
// "Editing App.tsx", "Searching for “retry”". Unknown tools keep their title.

type ToolRecord = Record<string, unknown> & { detail?: Record<string, unknown> | null }

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const clip = (value: string, limit = 48) => (value.length > limit ? `${value.slice(0, limit - 1)}…` : value)
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

function host(url: string) {
  try { return new URL(url).host || url } catch { return url }
}

export function doingNowLabel(tool: ToolRecord): string {
  const detail = tool.detail && typeof tool.detail === 'object' ? tool.detail : {}
  const kind = `${text(tool.kind)} ${text(detail.kind)} ${text(tool.title)}`.toLowerCase()
  const label = text(detail.label)
  if (label.startsWith('Ran ')) return clip(`Running ${label.slice(4)}`)
  const path = text(detail.path)
  const files = typeof detail.fileCount === 'number' && detail.fileCount > 1 ? detail.fileCount : 0
  if (/\b(edit|write|patch|multiedit|create|apply)/.test(kind)) return files ? `Editing ${files} files` : path ? clip(`Editing ${baseName(path)}`) : 'Editing files'
  if (/\b(read|view|open)/.test(kind) && path) return clip(`Reading ${baseName(path)}`)
  const query = text(detail.query) || text(detail.pattern)
  if (/\b(search|grep|glob|find)/.test(kind)) return query ? clip(`Searching for “${clip(query, 32)}”`) : 'Searching'
  const url = text(detail.url)
  if (/\b(fetch|web|browse)/.test(kind) && url) return clip(`Opening ${host(url)}`)
  return clip(text(tool.title) || 'Working')
}
