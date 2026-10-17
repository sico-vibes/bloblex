export type QuickSwitcherKind = 'blob' | 'conversation' | 'project' | 'action'

/** Groups in the order the palette shows them. */
export const QUICK_SWITCHER_CATEGORIES = ['Conversations', 'Bots', 'Projects', 'Create', 'Go to', 'Settings', 'Help'] as const
export type QuickSwitcherCategory = typeof QUICK_SWITCHER_CATEGORIES[number]

/** Icon names the palette knows how to draw. */
export type QuickSwitcherIcon = 'conversation' | 'bot' | 'project' | 'new-conversation' | 'new-bot' | 'usage' | 'settings' | 'search' | 'agents' | 'look' | 'remote' | 'tour' | 'shortcuts' | 'details' | 'whats-new'

export interface QuickSwitcherItem {
  id: string
  kind: QuickSwitcherKind
  title: string
  subtitle: string
  searchText: string
  recentAt?: string | null
  /** The group it is listed under; defaults from `kind`. */
  category?: QuickSwitcherCategory
  icon?: QuickSwitcherIcon
  /** A keyboard shortcut shown at the right, such as "Ctrl+/". */
  hint?: string
  /** A bot's colour, for its dot. */
  color?: string
}

export function categoryOf(item: QuickSwitcherItem): QuickSwitcherCategory {
  if (item.category) return item.category
  return item.kind === 'blob' ? 'Bots' : item.kind === 'conversation' ? 'Conversations' : item.kind === 'project' ? 'Projects' : 'Go to'
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

/** Ranked results kept in group order, so each group heading appears once. */
export function groupQuickSwitcherResults(ranked: QuickSwitcherItem[]): QuickSwitcherItem[] {
  const order = (item: QuickSwitcherItem) => QUICK_SWITCHER_CATEGORIES.indexOf(categoryOf(item))
  return ranked.map((item, index) => ({ item, index })).sort((a, b) => order(a.item) - order(b.item) || a.index - b.index).map(({ item }) => item)
}
