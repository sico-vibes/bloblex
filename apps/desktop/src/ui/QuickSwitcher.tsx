import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { useDialogAccessibility } from './dialogFocus'
import { rankQuickSwitcherItems, type QuickSwitcherItem } from './quickSwitcherModel'

export function QuickSwitcher({ items, onChoose, onClose }: { items: QuickSwitcherItem[]; onChoose: (item: QuickSwitcherItem) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const { ref, close } = useDialogAccessibility(onClose)
  const results = useMemo(() => {
    const queryText = query.trim()
    const candidates = queryText ? items : items.filter((item) => item.kind === 'action' || item.kind === 'conversation')
    const ranked = rankQuickSwitcherItems(candidates, query)
    if (queryText) return ranked
    return [...ranked.filter((item) => item.kind === 'conversation').slice(0, 8), ...ranked.filter((item) => item.kind === 'action')]
  }, [items, query])
  const activeIndex = results.length ? Math.min(active, results.length - 1) : 0
  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    const activeOption = resultsRef.current?.querySelector<HTMLElement>(`[data-result-index="${activeIndex}"]`)
    activeOption?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, results])
  const groupLabel = (kind: QuickSwitcherItem['kind']) => kind === 'blob' ? 'Blobs' : kind === 'conversation' ? 'Conversations' : kind === 'project' ? 'Projects' : 'Actions'
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
      <label className="quick-switcher-search"><Search size={17} /><input ref={inputRef} data-dialog-initial-focus autoComplete="off" aria-label="Search blobs, conversations, projects, and actions" aria-autocomplete="list" aria-controls="quick-switcher-results" aria-activedescendant={results.length ? `quick-switcher-option-${activeIndex}` : undefined} placeholder="Search or run an action" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={handleKeyDown} /></label>
      <div ref={resultsRef} id="quick-switcher-results" className="quick-switcher-results" role="listbox" aria-label="Quick switcher results">
        {results.map((item, index) => <Fragment key={`${item.kind}:${item.id}`}>
          {index === 0 || item.kind !== results[index - 1]?.kind ? <div className="quick-switcher-label">{groupLabel(item.kind)}</div> : null}
          <button id={`quick-switcher-option-${index}`} data-result-index={index} data-result-id={item.id} type="button" role="option" aria-posinset={index + 1} aria-setsize={results.length} aria-selected={index === activeIndex} className={`menu-item quick-switcher-item ${index === activeIndex ? 'active' : ''}`} onMouseMove={() => setActive(index)} onClick={() => { onChoose(item); close() }}><span className="quick-switcher-copy"><strong>{item.title}</strong>{item.subtitle && <small>{item.subtitle}</small>}</span><span className="menu-item-trail">{item.kind === 'action' ? '↵' : ''}</span></button>
        </Fragment>)}
        {!results.length && <p className="quick-switcher-empty">No matching results.</p>}
      </div>
      <footer className="quick-switcher-hint"><span>↑↓ Navigate</span><span>↵ Open</span><span>Esc Close</span></footer>
    </section>
  </div>
}
