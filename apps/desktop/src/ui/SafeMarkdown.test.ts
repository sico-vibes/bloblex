import { describe, expect, it } from 'vitest'
import { parseMarkdownBlocks, tokenizeInlineMarkdown } from './SafeMarkdown'

describe('safe Markdown parsing', () => {
  it('parses supported block syntax and keeps one list nesting level', () => {
    const blocks = parseMarkdownBlocks('# Heading\n\nParagraph\ncontinued\n\n- one\n  - nested\n\n> quote\n\n| A | B |\n| --- | --- |\n| x | y |\n\n```ts\nconst x = 1\n```')
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'list', 'quote', 'table', 'code'])
    expect(blocks[2]?.items).toEqual([{ depth: 0, text: 'one' }, { depth: 1, text: 'nested' }])
    expect(blocks[4]?.rows).toEqual([['A', 'B'], ['x', 'y']])
    expect(blocks[5]).toMatchObject({ language: 'ts', text: 'const x = 1' })
  })

  it('supports ordered lists, emphasis, strong text, inline code, and safe web links', () => {
    expect(parseMarkdownBlocks('1. first\n2. second')[0]).toMatchObject({ kind: 'list', ordered: true })
    expect(tokenizeInlineMarkdown('**strong** *em* `code` [web](https://example.invalid/path) [bad](javascript:alert(1))')).toEqual([
      { kind: 'strong', text: 'strong' }, { kind: 'text', text: ' ' }, { kind: 'em', text: 'em' }, { kind: 'text', text: ' ' },
      { kind: 'code', text: 'code' }, { kind: 'text', text: ' ' }, { kind: 'link', text: 'web', url: 'https://example.invalid/path' }, { kind: 'text', text: ' [bad](javascript:alert(1))' },
    ])
  })

  it('keeps underscore identifiers and dunder names literal while allowing boundary emphasis', () => {
    expect(tokenizeInlineMarkdown('foo_bar_baz __init__ _emphasis_')).toEqual([
      { kind: 'text', text: 'foo_bar_baz __init__ ' }, { kind: 'em', text: 'emphasis' },
    ])
  })

  it('falls back to literal text for unmatched or unsupported syntax', () => {
    expect(tokenizeInlineMarkdown('**unfinished and <script>alert(1)</script>')).toEqual([{ kind: 'text', text: '**unfinished and <script>alert(1)</script>' }])
    expect(parseMarkdownBlocks('<img src=x onerror=alert(1)>')[0]).toMatchObject({ kind: 'paragraph', text: '<img src=x onerror=alert(1)>' })
    expect(parseMarkdownBlocks('```unterminated\ntext')).toMatchObject([{ kind: 'literal', text: '```unterminated\ntext' }])
  })
})
