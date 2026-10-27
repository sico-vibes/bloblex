/**
 * Rich blocks in chat: tables and charts built only from data a model or tool actually wrote.
 *
 * Nothing here executes content. A block is parsed as data, validated against hard limits and
 * rendered by our own React components; whatever fails validation stays visible as a code block
 * with the reason, so a bad block is never silently dropped and never invented.
 */

export type ColumnKind = 'number' | 'text'
export type Cell = string | number | null
export type DataColumn = { key: string; label: string; kind: ColumnKind }
export type DataTable = { columns: DataColumn[]; rows: Cell[][]; title?: string; caption?: string; truncated: boolean }
export type ChartKind = 'bar' | 'line'
export type ChartSeries = { name: string; values: Array<number | null> }
export type ChartSpec = { kind: ChartKind; title?: string; caption?: string; unit?: string; categories: string[]; series: ChartSeries[]; truncated: boolean }
export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }

export const LIMITS = { rows: 1000, columns: 24, cell: 500, categories: 200, series: 6, jsonBytes: 200_000 } as const

const failure = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)
const cleanText = (value: unknown, max = 160) => (typeof value === 'string' ? clip(value.replace(/\s+/g, ' ').trim(), max) : '')

const NUMBER_PATTERN = /^[-+]?\$?\d{1,3}(,\d{3})+(\.\d+)?%?$|^[-+]?\$?\d+(\.\d+)?%?$|^[-+]?\.\d+%?$/

/** A number only when the whole cell is one (optionally with thousands commas, a $ or a %); never a guess from prose. */
export function parseNumber(value: string): number | null {
  const text = value.trim()
  if (!text || !NUMBER_PATTERN.test(text)) return null
  const parsed = Number(text.replace(/[$,%]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function cellFrom(value: unknown): Cell {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return clip(value, LIMITS.cell)
  try { return clip(JSON.stringify(value) ?? '', LIMITS.cell) } catch { return null }
}

/** The number a cell holds, read from its text when the whole cell is one. */
export function numberOf(cell: Cell | undefined): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null
  return typeof cell === 'string' ? parseNumber(cell) : null
}

function kindOf(rows: Cell[][], column: number): ColumnKind {
  let numbers = 0
  let filled = 0
  for (const row of rows) {
    const cell = row[column]
    if (cell === null || cell === undefined || cell === '') continue
    filled += 1
    if (typeof cell === 'number' || (typeof cell === 'string' && parseNumber(cell) !== null)) numbers += 1
  }
  return filled > 0 && numbers / filled >= 0.8 ? 'number' : 'text'
}

function build(headers: string[], rawRows: Cell[][], extra: { title?: string; caption?: string } = {}): Parsed<DataTable> {
  if (!headers.length) return failure('The table has no columns.')
  if (headers.length > LIMITS.columns) return failure(`The table has more than ${LIMITS.columns} columns.`)
  const truncated = rawRows.length > LIMITS.rows
  const rows = rawRows.slice(0, LIMITS.rows).map((row) => headers.map((_, index) => row[index] ?? null))
  const used = new Set<string>()
  const columns = headers.map((header, index): DataColumn => {
    const label = cleanText(header, 80) || `Column ${index + 1}`
    let key = label
    for (let n = 2; used.has(key); n += 1) key = `${label} ${n}`
    used.add(key)
    return { key, label, kind: kindOf(rows, index) }
  })
  // Cells keep the text the author wrote ("12%", "$1,200"); numbers are read from it only to sort and to plot.
  return { ok: true, value: { columns, rows, truncated, ...(extra.title ? { title: extra.title } : {}), ...(extra.caption ? { caption: extra.caption } : {}) } }
}

/** A Markdown table already split into cells (header row first). */
export function tableFromMarkdownRows(rows: string[][]): Parsed<DataTable> {
  const [head, ...body] = rows
  if (!head) return failure('The table is empty.')
  return build(head, body.map((row) => row.map((cell) => cell as Cell)))
}

/** Delimited text with a header row. Quotes follow RFC 4180; the first line decides comma, tab or semicolon. */
export function parseDelimited(source: string): Parsed<DataTable> {
  const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim()
  if (!text) return failure('There is no data.')
  if (text.length > 400_000) return failure('The data is too large to show as a table.')
  const first = text.split('\n', 1)[0] ?? ''
  const counts: Array<[string, number]> = [[',', first.split(',').length], ['\t', first.split('\t').length], [';', first.split(';').length]]
  const delimiter = counts.sort((a, b) => b[1] - a[1])[0]![0]
  const records: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quoted) {
      if (char === '"') { if (text[index + 1] === '"') { field += '"'; index += 1 } else quoted = false } else field += char
    } else if (char === '"' && field === '') quoted = true
    else if (char === delimiter) { row.push(field); field = '' }
    else if (char === '\n') { row.push(field); records.push(row); row = []; field = '' }
    else field += char
    if (records.length > LIMITS.rows + 1) break
  }
  if (quoted) return failure('A quoted value never closes.')
  if (field !== '' || row.length) { row.push(field); records.push(row) }
  if (records.length < 2 || (records[0]?.length ?? 0) < 2) return failure('Delimited data needs a header and at least two columns.')
  const [head, ...body] = records
  return build(head!, body.map((values) => values.map((value): Cell => clip(value, LIMITS.cell))))
}

/** A JSON array of flat objects becomes a table; anything else is not a table and stays JSON. */
export function tableFromJson(source: string): Parsed<DataTable> {
  if (source.length > LIMITS.jsonBytes) return failure('The data is too large to show as a table.')
  let data: unknown
  try { data = JSON.parse(source) } catch { return failure('This is not valid JSON.') }
  if (!Array.isArray(data) || data.length < 1) return failure('Only a JSON list of objects can be shown as a table.')
  if (!data.every(isRecord)) return failure('Only a JSON list of objects can be shown as a table.')
  const keys: string[] = []
  for (const record of data as Record<string, unknown>[]) for (const key of Object.keys(record)) if (!keys.includes(key) && keys.length <= LIMITS.columns) keys.push(key)
  return build(keys, (data as Record<string, unknown>[]).slice(0, LIMITS.rows + 1).map((record) => keys.map((key) => cellFrom(record[key]))))
}

/** `bitbots-table`: { title?, caption?, columns: [string | {label, type?}], rows: [[...]] | [{...}] }. */
export function parseTableSpec(source: string): Parsed<DataTable> {
  if (source.length > LIMITS.jsonBytes) return failure('The table is too large.')
  let spec: unknown
  try { spec = JSON.parse(source) } catch { return failure('The table is not valid JSON.') }
  if (!isRecord(spec)) return failure('The table must be a JSON object.')
  const rowsInput = spec.rows
  if (!Array.isArray(rowsInput) || !rowsInput.length) return failure('The table has no rows.')
  const title = cleanText(spec.title, 120)
  const caption = cleanText(spec.caption, 240)
  const columnInput = Array.isArray(spec.columns) ? spec.columns : null
  let headers: string[]
  if (columnInput) {
    headers = columnInput.map((column) => (typeof column === 'string' ? column : isRecord(column) ? cleanText(column.label ?? column.key, 80) : ''))
    if (headers.some((header) => !header)) return failure('Every column needs a name.')
  } else if (rowsInput.every(isRecord)) {
    headers = []
    for (const record of rowsInput as Record<string, unknown>[]) for (const key of Object.keys(record)) if (!headers.includes(key)) headers.push(key)
  } else return failure('The table needs a columns list.')
  const rows: Cell[][] = []
  for (const row of rowsInput) {
    if (Array.isArray(row)) rows.push(row.map(cellFrom))
    else if (isRecord(row)) {
      const columns = columnInput as unknown[] | null
      rows.push(headers.map((header, index) => {
        const declared = columns?.[index]
        const key = isRecord(declared) && typeof declared.key === 'string' ? declared.key : header
        return cellFrom(row[key] ?? row[header])
      }))
    } else return failure('Each row must be a list or an object.')
  }
  return build(headers, rows, { ...(title ? { title } : {}), ...(caption ? { caption } : {}) })
}

/** `bitbots-chart`: { type: "bar"|"line", title?, caption?, unit?, categories: [..], series: [{name, values:[..]}] } or { data: [{label, value}] }. */
export function parseChartSpec(source: string): Parsed<ChartSpec> {
  if (source.length > LIMITS.jsonBytes) return failure('The chart is too large.')
  let spec: unknown
  try { spec = JSON.parse(source) } catch { return failure('The chart is not valid JSON.') }
  if (!isRecord(spec)) return failure('The chart must be a JSON object.')
  const kind = spec.type === 'line' ? 'line' : spec.type === 'bar' ? 'bar' : null
  if (!kind) return failure('The chart type must be "bar" or "line".')
  let categories: string[] = []
  let series: ChartSeries[] = []
  if (Array.isArray(spec.data)) {
    const rows = spec.data.filter(isRecord)
    if (rows.length !== spec.data.length || !rows.length) return failure('Chart data must be a list of { label, value } objects.')
    categories = rows.map((row) => cleanText(row.label ?? row.x, 60))
    series = [{ name: cleanText(spec.seriesName, 60) || 'Value', values: rows.map((row) => finiteOrNull(row.value ?? row.y)) }]
  } else {
    if (!Array.isArray(spec.categories) || !Array.isArray(spec.series)) return failure('A chart needs categories and series.')
    categories = spec.categories.map((category) => cleanText(typeof category === 'number' ? String(category) : category, 60))
    series = spec.series.map((entry, index) => {
      const record = isRecord(entry) ? entry : {}
      return { name: cleanText(record.name, 60) || `Series ${index + 1}`, values: Array.isArray(record.values) ? record.values.map(finiteOrNull) : [] }
    })
  }
  if (categories.length < 1) return failure('The chart has no categories.')
  if (categories.some((category) => !category)) return failure('Every category needs a label.')
  if (!series.length) return failure('The chart has no series.')
  if (series.length > LIMITS.series) return failure(`A chart can show at most ${LIMITS.series} series.`)
  if (series.some((entry) => entry.values.length !== categories.length)) return failure('Each series needs one value per category.')
  if (!series.some((entry) => entry.values.some((value) => value !== null))) return failure('The chart has no numeric values.')
  const truncated = categories.length > LIMITS.categories
  const title = cleanText(spec.title, 120)
  const caption = cleanText(spec.caption, 240)
  const unit = cleanText(spec.unit, 16)
  return {
    ok: true,
    value: {
      kind,
      categories: categories.slice(0, LIMITS.categories),
      series: series.map((entry) => ({ ...entry, values: entry.values.slice(0, LIMITS.categories) })),
      truncated,
      ...(title ? { title } : {}), ...(caption ? { caption } : {}), ...(unit ? { unit } : {}),
    },
  }
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Columns a user may chart from a table: a label column and the numeric columns. Null when it would not read as a chart. */
export function chartableColumns(table: DataTable): { label: number | null; numeric: number[] } | null {
  const numeric = table.columns.flatMap((column, index) => (column.kind === 'number' ? [index] : []))
  if (!numeric.length || table.rows.length < 2 || table.rows.length > 60) return null
  const label = table.columns.findIndex((column) => column.kind === 'text')
  // A table that is all numbers still charts, by row number; the label column is optional.
  return { label: label >= 0 ? label : null, numeric: numeric.slice(0, LIMITS.series + 4) }
}

/** The chart for the columns the user picked. A column's values are the table's own cells; text that is not a number is a gap. */
export function chartFromTable(table: DataTable, labelColumn: number | null, picked: number[], kind: ChartKind): ChartSpec {
  const categories = table.rows.map((row, index) => (labelColumn === null ? String(index + 1) : cleanText(String(row[labelColumn] ?? ''), 60) || String(index + 1)))
  return {
    kind,
    categories,
    series: picked.slice(0, LIMITS.series).map((column) => ({ name: table.columns[column]?.label ?? 'Value', values: table.rows.map((row) => { return numberOf(row[column]) }) })),
    truncated: false,
    ...(table.title ? { title: table.title } : {}),
  }
}

export function formatNumber(value: number, options: { compact?: boolean; unit?: string } = {}): string {
  const text = new Intl.NumberFormat(undefined, options.compact ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 3 }).format(value)
  return options.unit ? `${text}${/^[%$€£]$/.test(options.unit) ? '' : ' '}${options.unit}` : text
}

/** "Nice" axis ticks from a data range; always includes zero for bars. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) max = min + 1
  const span = max - min
  const raw = span / Math.max(1, count)
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= raw) ?? 10) * magnitude
  const start = Math.floor(min / step) * step
  const ticks: number[] = []
  for (let value = start; value <= max + step * 0.5 && ticks.length < 12; value += step) ticks.push(Number(value.toFixed(10)))
  return ticks
}

export function csvEscape(value: Cell): string {
  const text = value === null ? '' : String(value)
  // A leading = + - @ turns a spreadsheet cell into a formula; prefix it so exported data stays data.
  const guarded = /^[=+\-@\t\r]/.test(text) && typeof value === 'string' && parseNumber(text) === null ? `'${text}` : text
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

export function tableToCsv(table: DataTable, rows: Cell[][] = table.rows): string {
  return [table.columns.map((column) => csvEscape(column.label)).join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n')
}

export type SortState = { column: number; direction: 'asc' | 'desc' } | null

export function sortRows(table: DataTable, sort: SortState, filter: string): Cell[][] {
  const needle = filter.trim().toLowerCase()
  let rows = needle ? table.rows.filter((row) => row.some((cell) => cell !== null && String(cell).toLowerCase().includes(needle))) : table.rows.slice()
  if (sort) {
    const { column, direction } = sort
    const sign = direction === 'asc' ? 1 : -1
    const numeric = table.columns[column]?.kind === 'number'
    rows = rows.map((row, index) => ({ row, index })).sort((a, b) => {
      const left = a.row[column]
      const right = b.row[column]
      // Empty cells always sort last, whichever way the column is ordered.
      if (left === null || left === '') return right === null || right === '' ? a.index - b.index : 1
      if (right === null || right === '') return -1
      const leftNumber = numeric ? numberOf(left) : null
      const rightNumber = numeric ? numberOf(right) : null
      const result = leftNumber !== null && rightNumber !== null ? leftNumber - rightNumber : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' })
      return result === 0 ? a.index - b.index : result * sign
    }).map((entry) => entry.row)
  }
  return rows
}
