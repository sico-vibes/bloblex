import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, BarChart3, Compass, FolderOpen, Globe, Keyboard, MessageSquare, MessageSquarePlus, Palette, PanelRight, Search, Settings2, Smartphone, UserPlus, type LucideIcon, Newspaper } from 'lucide-react'
import { useDialogAccessibility } from './dialogFocus'
import { categoryOf, groupQuickSwitcherResults, rankQuickSwitcherItems, type QuickSwitcherIcon, type QuickSwitcherItem } from './quickSwitcherModel'
import { useEntityNoun } from './vocabulary'

const ICONS: Record<QuickSwitcherIcon, LucideIcon> = {
  conversation: MessageSquare,
  bot: Bot,
  project: FolderOpen,
  'new-conversation': MessageSquarePlus,
  'new-bot': UserPlus,
  usage: BarChart3,
  settings: Settings2,
  search: Search,
  agents: Globe,
  look: Palette,
  remote: Smartphone,
  tour: Compass,
  shortcuts: Keyboard,
  details: PanelRight,
  'whats-new': Newspaper,
}

function ItemIcon({ item }: { item: QuickSwitcherItem }) {
  if (item.kind === 'blob' && item.color) return <span className="quick-switcher-icon bot" aria-hidden="true"><i style={{ background: item.color }} /></span>
  const Icon = ICONS[item.icon ?? (item.kind === 'conversation' ? 'conversation' : item.kind === 'project' ? 'project' : item.kind === 'blob' ? 'bot' : 'settings')]
  return <span className="quick-switcher-icon" aria-hidden="true"><Icon size={15} /></span>
}

export function QuickSwitcher({ items, onChoose, onClose }: { items: QuickSwitcherItem[]; onChoose: (item: QuickSwitcherItem) => void; onClose: () => void }) {
  const Nouns = useEntityNoun({ plural: true, capital: true })
  const nouns = useEntityNoun({ plural: true })
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const { ref, close } = useDialogAccessibility(onClose)
  const results = useMemo(() => {
    const queryText = query.trim()
    const candidates = queryText ? items : items.filter((item) => item.kind === 'action' || item.kind === 'conversation')
    const ranked = rankQuickSwitcherItems(candidates, query)
    if (queryText) return groupQuickSwitcherResults(ranked)
    return groupQuickSwitcherResults([...ranked.filter((item) => item.kind === 'conversation').slice(0, 6), ...ranked.filter((item) => item.kind === 'action')])
  }, [items, query])
  const activeIndex = results.length ? Math.min(active, results.length - 1) : 0
  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    const activeOption = resultsRef.current?.querySelector<HTMLElement>(`[data-result-index="${activeIndex}"]`)
    activeOption?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, results])
  const groupLabel = (item: QuickSwitcherItem) => {
    const category = categoryOf(item)
    return category === 'Bots' ? Nouns : !query.trim() && category === 'Conversations' ? 'Recent conversations' : category
  }
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (results.length) setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length)
    } else if (event.key === 'Enter' && results[activeIndex]) {
      event.preventDefault()
      onChoose(results[activeIndex]!)
      close()
    }
  }
  return <div className="sheet-backdrop quick-switcher-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
    <section ref={ref} className="quick-switcher" role="dialog" aria-modal="true" aria-label="Quick switcher">
      <label className="quick-switcher-search"><Search size={17} /><input ref={inputRef} data-dialog-initial-focus autoComplete="off" aria-label={`Search ${nouns}, conversations, projects, and actions`} aria-autocomplete="list" aria-controls="quick-switcher-results" aria-activedescendant={results.length ? `quick-switcher-option-${activeIndex}` : undefined} placeholder="Search or run an action" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={handleKeyDown} /></label>
      <div ref={resultsRef} id="quick-switcher-results" className="quick-switcher-results" role="listbox" aria-label="Quick switcher results">
        {results.map((item, index) => <Fragment key={`${item.kind}:${item.id}`}>
          {index === 0 || categoryOf(item) !== categoryOf(results[index - 1]!) ? <div className="quick-switcher-label" role="presentation">{groupLabel(item)}</div> : null}
          <button id={`quick-switcher-option-${index}`} data-result-index={index} data-result-id={item.id} type="button" role="option" aria-posinset={index + 1} aria-setsize={results.length} aria-selected={index === activeIndex} className={`menu-item quick-switcher-item ${index === activeIndex ? 'active' : ''}`} onMouseMove={() => setActive(index)} onClick={() => { onChoose(item); close() }}>
            <ItemIcon item={item} />
            <span className="quick-switcher-copy"><strong>{item.title}</strong>{item.subtitle && <small>{item.subtitle}</small>}</span>
            {item.hint ? <kbd className="quick-switcher-kbd">{item.hint}</kbd> : index === activeIndex ? <span className="menu-item-trail" aria-hidden="true">↵</span> : null}
          </button>
        </Fragment>)}
        {!results.length && <p className="quick-switcher-empty">No matching results.</p>}
      </div>
      <footer className="quick-switcher-hint"><span>↑↓ Navigate</span><span>↵ Open</span><span>Esc Close</span></footer>
    </section>
  </div>
}
