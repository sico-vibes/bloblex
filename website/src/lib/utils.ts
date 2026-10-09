export function cn(...classes: Array<string | false | null | undefined | Record<string, boolean>>) {
  const names: string[] = []
  for (const entry of classes) {
    if (!entry) continue
    if (typeof entry === 'string') {
      names.push(entry)
      continue
    }
    for (const [name, on] of Object.entries(entry)) {
      if (on) names.push(name)
    }
  }
  return names.join(' ')
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`
}

export function formatDate(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}
