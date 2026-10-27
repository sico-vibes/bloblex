import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, BarChart3, ChevronRight, Copy, Search, Table2 } from 'lucide-react'
import { RichChart } from './RichChart'
import { chartableColumns, chartFromTable, sortRows, tableToCsv, type Cell, type ChartKind, type DataTable, type SortState } from './richData'
import './richBlocks.css'

const INITIAL_ROWS = 12
const FILTER_FROM = 9

function nextSort(current: SortState, column: number): SortState {
  if (!current || current.column !== column) return { column, direction: 'asc' }
  return current.direction === 'asc' ? { column, direction: 'desc' } : null
}

/**
 * An interactive table over real data: sort by column, filter, open a row to read every cell, copy as CSV,
 * and (when the table has numbers worth plotting) switch to a chart of the same cells.
 */
export function RichTable({ table, label, renderCell }: { table: DataTable; label: string; renderCell?: (text: string, key: string) => ReactNode }) {
  const [sort, setSort] = useState<SortState>(null)
  const [filter, setFilter] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const [view, setView] = useState<'table' | 'chart'>('table')
  const [copied, setCopied] = useState(false)
  const chartable = useMemo(() => chartableColumns(table), [table])
  const [picked, setPicked] = useState<number[] | null>(null)
  const [chartKind, setChartKind] = useState<ChartKind>('bar')
  const identity = useMemo(() => new Map(table.rows.map((row, index) => [row, index] as const)), [table])
  const rows = useMemo(() => sortRows(table, sort, filter), [table, sort, filter])
  const visible = showAll || rows.length <= INITIAL_ROWS + 2 ? rows : rows.slice(0, INITIAL_ROWS)
  const columnsKey = table.columns.map((column) => column.key).join('|')
  const activeColumns = picked ?? (chartable ? chartable.numeric.slice(0, 1) : [])

  const copy = async () => {
    try { await navigator.clipboard.writeText(tableToCsv(table, rows)); setCopied(true); window.setTimeout(() => setCopied(false), 1400) } catch { setCopied(false) }
  }
  const toggleRow = (index: number) => setOpen((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next })
  const text = (cell: Cell, key: string): ReactNode => {
    if (cell === null || cell === '') return <span className="rich-empty" aria-label="empty">–</span>
    if (typeof cell === 'number') return String(cell)
    return renderCell ? renderCell(cell, key) : cell
  }

  return <figure className="rich-block rich-table" aria-label={label}>
    <header className="rich-head">
      <div className="rich-title">{table.title ? <strong>{table.title}</strong> : <span>Table</span>}<small>{rows.length === table.rows.length ? `${table.rows.length} rows` : `${rows.length} of ${table.rows.length} rows`}{table.truncated ? ' (first 1,000)' : ''}</small></div>
      <div className="rich-tools">
        {chartable && <div className="rich-switch" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}><Table2 size={13} aria-hidden="true" />Table</button>
          <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}><BarChart3 size={13} aria-hidden="true" />Chart</button>
        </div>}
        <button type="button" className="rich-tool" onClick={() => void copy()} aria-label="Copy as CSV"><Copy size={13} aria-hidden="true" />{copied ? 'Copied' : 'Copy CSV'}</button>
      </div>
    </header>
    {view === 'chart' && chartable ? <div className="rich-chart-pane">
      <div className="rich-chart-controls">
        <div className="rich-chips" role="group" aria-label="Columns to plot">
          {chartable.numeric.map((column) => {
            const on = activeColumns.includes(column)
            return <button type="button" key={column} aria-pressed={on} className="rich-chip" onClick={() => setPicked(on ? (activeColumns.length > 1 ? activeColumns.filter((value) => value !== column) : activeColumns) : [...activeColumns, column].slice(0, 6))}>{table.columns[column]?.label}</button>
          })}
        </div>
        <div className="rich-switch" role="group" aria-label="Chart type">
          <button type="button" aria-pressed={chartKind === 'bar'} onClick={() => setChartKind('bar')}>Bars</button>
          <button type="button" aria-pressed={chartKind === 'line'} onClick={() => setChartKind('line')}>Line</button>
        </div>
      </div>
      <RichChart spec={chartFromTable(table, chartable.label, activeColumns, chartKind)} label={`${label}, chart`} embedded />
      {activeColumns.length > 1 && <p className="rich-note">All selected columns share one axis. Pick columns that use the same unit.</p>}
    </div> : <>
      {table.rows.length >= FILTER_FROM && <label className="rich-filter"><Search size={13} aria-hidden="true" /><input type="search" value={filter} onChange={(event) => { setFilter(event.target.value); setShowAll(false) }} placeholder="Filter rows" aria-label="Filter rows" spellCheck={false} /></label>}
      <div className="rich-scroll" tabIndex={0} role="region" aria-label={`${label}, scrollable`}>
        <table>
          {table.caption && <caption>{table.caption}</caption>}
          <thead><tr>
            <th className="rich-open-col"><span className="sr-only">Details</span></th>
            {table.columns.map((column, index) => {
              const active = sort?.column === index
              return <th key={`${columnsKey}-${index}`} scope="col" className={column.kind === 'number' ? 'rich-num' : undefined} aria-sort={active ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button type="button" className="rich-sort" onClick={() => setSort(nextSort(sort, index))} aria-label={`Sort by ${column.label}`}>
                  <span>{column.label}</span>{active ? (sort!.direction === 'asc' ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />) : <span className="rich-sort-spacer" aria-hidden="true" />}
                </button>
              </th>
            })}
          </tr></thead>
          <tbody>
            {visible.map((row) => {
              const id = identity.get(row) ?? -1
              const expanded = open.has(id)
              return [
                <tr key={`r${id}`} className={expanded ? 'open' : undefined}>
                  <td className="rich-open-col"><button type="button" className="rich-row-toggle" aria-expanded={expanded} aria-label={expanded ? 'Hide row details' : 'Show row details'} onClick={() => toggleRow(id)}><ChevronRight size={13} aria-hidden="true" /></button></td>
                  {row.map((cell, index) => <td key={index} className={table.columns[index]?.kind === 'number' ? 'rich-num' : undefined}><div className="rich-cell">{text(cell, `r${id}c${index}`)}</div></td>)}
                </tr>,
                expanded && <tr key={`d${id}`} className="rich-details"><td colSpan={table.columns.length + 1}>
                  <dl>{table.columns.map((column, index) => <div key={index}><dt>{column.label}</dt><dd>{text(row[index] ?? null, `d${id}c${index}`)}</dd></div>)}</dl>
                </td></tr>,
              ]
            })}
            {!visible.length && <tr><td colSpan={table.columns.length + 1} className="rich-none">No rows match “{filter}”.</td></tr>}
          </tbody>
        </table>
      </div>
      {rows.length > visible.length && <button type="button" className="rich-more" onClick={() => setShowAll(true)}>Show all {rows.length} rows</button>}
      {showAll && rows.length > INITIAL_ROWS + 2 && <button type="button" className="rich-more" onClick={() => setShowAll(false)}>Show fewer rows</button>}
    </>}
  </figure>
}
