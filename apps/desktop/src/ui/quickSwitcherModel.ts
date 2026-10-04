export type QuickSwitcherKind = 'blob' | 'conversation' | 'project' | 'action'

export interface QuickSwitcherItem {
  id: string
  kind: QuickSwitcherKind
  title: string
  subtitle: string
  searchText: string
  recentAt?: string | null
}

function rank(item: QuickSwitcherItem, words: string[]) {
  if (!words.length) return 0
  const haystack = item.searchText.toLocaleLowerCase()
  if (!words.every((word) => haystack.includes(word))) return null
  if (haystack.startsWith(words.join(' '))) return 0
  const wordPrefix = words.every((word) => haystack.split(/\s+/).some((part) => part.startsWith(word)))
  return wordPrefix ? 1 : 2
}

export function rankQuickSwitcherItems(items: QuickSwitcherItem[], query: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return items.flatMap((item, index) => {
    const value = rank(item, words)
    return value === null ? [] : [{ item, rank: value, index }]
  }).sort((a, b) => a.rank - b.rank || (a.item.kind === 'conversation' && b.item.kind === 'conversation' ? (b.item.recentAt ?? '').localeCompare(a.item.recentAt ?? '') : 0) || a.index - b.index).map(({ item }) => item)
}
