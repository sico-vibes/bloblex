import { useState } from 'react'
import { Copy } from 'lucide-react'

type InlineToken = { kind: 'text' | 'code' | 'strong' | 'em' | 'link'; text: string; url?: string }
type MarkdownBlock = { kind: 'paragraph' | 'heading' | 'quote' | 'code' | 'list' | 'table' | 'literal'; text?: string; level?: number; language?: string; rows?: string[][]; ordered?: boolean; items?: Array<{ depth: number; text: string }> }

function safeHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch { return null }
}

export function tokenizeInlineMarkdown(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|(?<![\p{L}\p{N}_])_[^_\n]+_(?![\p{L}\p{N}_])|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/giu
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) tokens.push({ kind: 'text', text: text.slice(cursor, index) })
    const value = match[0]
    if (value.startsWith('`')) tokens.push({ kind: 'code', text: value.slice(1, -1) })
    else if (value.startsWith('**') || value.startsWith('__')) tokens.push({ kind: 'strong', text: value.slice(2, -2) })
    else if (value.startsWith('*') || value.startsWith('_')) tokens.push({ kind: 'em', text: value.slice(1, -1) })
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value)
      const url = link ? safeHttpUrl(link[2]!) : null
      tokens.push(url ? { kind: 'link', text: link![1]!, url } : { kind: 'text', text: value })
    }
    cursor = index + value.length
  }
  if (cursor < text.length) tokens.push({ kind: 'text', text: text.slice(cursor) })
  return tokens.length ? tokens : [{ kind: 'text', text }]
}

function isTableSeparator(line: string) {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function cells(line: string) { return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()) }

export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) { index += 1; continue }
    const fence = /^```([^`]*)$/.exec(line)
    if (fence) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) code.push(lines[index++] ?? '')
      if (index < lines.length) {
        index += 1
        blocks.push({ kind: 'code', text: code.join('\n'), language: fence[1]?.trim() ?? '' })
      } else blocks.push({ kind: 'literal', text: [line, ...code].join('\n') })
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) { blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! }); index += 1; continue }
    if (line.startsWith('|') && isTableSeparator(lines[index + 1] ?? '')) {
      const rows = [cells(line)]
      index += 2
      while (index < lines.length && (lines[index] ?? '').startsWith('|')) rows.push(cells(lines[index++] ?? ''))
      blocks.push({ kind: 'table', rows })
      continue
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) quote.push((lines[index++] ?? '').replace(/^>\s?/, ''))
      blocks.push({ kind: 'quote', text: quote.join('\n') })
      continue
    }
    if (/^\s*([-*+] |\d+\. )/.test(line)) {
      const items: Array<{ depth: number; text: string }> = []
      const ordered = /^\s*\d+\. /.test(line)
      while (index < lines.length && /^\s*([-*+] |\d+\. )/.test(lines[index] ?? '')) {
        const current = lines[index++] ?? ''
        const depth = Math.min(1, Math.floor((current.match(/^\s*/)?.[0].length ?? 0) / 2))
        items.push({ depth, text: current.replace(/^\s*(?:[-*+] |\d+\. )/, '') })
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const paragraph = [line]
    index += 1
    while (index < lines.length && (lines[index] ?? '').trim() && !/^(?:#{1,3}\s|```|>\s?|\s*[-*+] |\s*\d+\. )/.test(lines[index] ?? '') && !(lines[index] ?? '').startsWith('|') ) paragraph.push(lines[index++] ?? '')
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
  }
  return blocks
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); window.setTimeout(() => setCopied(false), 1200) } catch { setCopied(false) }
  }
  return <div className="message-code"><div className="message-code-header"><span>{language || 'Code'}</span><button type="button" onClick={() => void copy()} aria-label="Copy code"><Copy size={13} />{copied ? 'Copied' : 'Copy'}</button></div><pre><code>{code}</code></pre></div>
}

export function SafeMarkdown({ text, onOpenLink }: { text: string; onOpenLink: (url: string) => void }) {
  const inline = (value: string, keyPrefix: string) => tokenizeInlineMarkdown(value).map((token, index) => {
    const key = `${keyPrefix}-${index}`
    if (token.kind === 'code') return <code key={key}>{token.text}</code>
    if (token.kind === 'strong') return <strong key={key}>{token.text}</strong>
    if (token.kind === 'em') return <em key={key}>{token.text}</em>
    if (token.kind === 'link') return <button key={key} type="button" className="markdown-link" onClick={() => token.url && onOpenLink(token.url)}>{token.text}</button>
    return <span key={key}>{token.text}</span>
  })
  return <div className="safe-markdown">{parseMarkdownBlocks(text).map((block, index) => {
    const key = `block-${index}`
    if (block.kind === 'literal') return <p key={key} className="markdown-literal">{block.text}</p>
    if (block.kind === 'code') return <CodeBlock key={key} language={block.language ?? ''} code={block.text ?? ''} />
    if (block.kind === 'heading') { const content = inline(block.text ?? '', key); return block.level === 1 ? <h2 key={key}>{content}</h2> : block.level === 2 ? <h3 key={key}>{content}</h3> : <h4 key={key}>{content}</h4> }
    if (block.kind === 'quote') return <blockquote key={key}>{(block.text ?? '').split('\n').map((line, lineIndex) => <p key={`${key}-${lineIndex}`}>{inline(line, `${key}-${lineIndex}`)}</p>)}</blockquote>
    if (block.kind === 'list') {
      const Tag = block.ordered ? 'ol' : 'ul'
      return <Tag key={key}>{(block.items ?? []).map((item, itemIndex) => <li key={`${key}-${itemIndex}`} className={item.depth ? 'nested' : undefined}>{inline(item.text, `${key}-${itemIndex}`)}</li>)}</Tag>
    }
    if (block.kind === 'table') {
      const rows = block.rows ?? []
      return <div className="markdown-table-scroll" key={key}><table><thead><tr>{(rows[0] ?? []).map((cell, cellIndex) => <th key={cellIndex}>{inline(cell, `${key}-head-${cellIndex}`)}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell, `${key}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>
    }
    return <p key={key}>{inline(block.text ?? '', key)}</p>
  })}</div>
}
