import { describe, expect, it } from 'vitest'
import { rankQuickSwitcherItems, type QuickSwitcherItem } from './quickSwitcherModel'

const rows: QuickSwitcherItem[] = [
  { id: 'sub', kind: 'blob', title: 'Workspace malpha', subtitle: '', searchText: 'Workspace malpha' },
  { id: 'word', kind: 'blob', title: 'Workspace', subtitle: 'Alpha', searchText: 'Workspace Alpha' },
  { id: 'prefix', kind: 'blob', title: 'Alpha', subtitle: '', searchText: 'Alpha' },
  { id: 'recent', kind: 'conversation', title: 'Build', subtitle: 'Alpha', searchText: 'Build Alpha', recentAt: '2026-10-03T10:00:00Z' },
  { id: 'old', kind: 'conversation', title: 'Build', subtitle: 'Alpha', searchText: 'Build Alpha', recentAt: '2026-10-02T10:00:00Z' },
]

describe('rankQuickSwitcherItems', () => {
  it('requires every word and ranks prefixes before substrings', () => {
    expect(rankQuickSwitcherItems(rows, 'alpha').map((row) => row.id)).toEqual(['prefix', 'word', 'recent', 'old', 'sub'])
    expect(rankQuickSwitcherItems(rows, 'alpha missing')).toEqual([])
  })

  it('puts recent conversations first on ties', () => {
    expect(rankQuickSwitcherItems(rows, 'build').map((row) => row.id)).toEqual(['recent', 'old'])
  })
})
