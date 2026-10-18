// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { ActivitySteps, ActivitySummaryLine, activityTitle } from './ActivityDetails'
import { activityCategory, groupConversationActivity, type ActivityGroup, type ConversationItem } from './conversation'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const step = (kind: string, detail: Record<string, unknown>, title?: string): ConversationItem => ({
  kind: 'activity', id: kind, activityKind: 'tool', activity: { kind, title, detail },
})

describe('readable activity from stored turns', () => {
  it('derives targets from old JSON input and tolerates clipped input', () => {
    expect(activityTitle(step('Glob', { tool: 'Glob', input: '{"pattern":"**/*.ts"}' }))).toBe('Searched **/*.ts')
    expect(activityTitle(step('Read', { tool: 'Read', input: '{"file_path":"src/main.ts"}' }, 'Read'))).toBe('Read src/main.ts')
    expect(activityTitle(step('Grep', { tool: 'Grep', input: '{"pattern":"TODO","path":"src"}' }, 'Grep'))).toBe('Searched TODO in src')
    expect(activityTitle(step('Edit', { tool: 'Edit', input: '{"file_path":', path: 'src/main.ts' }, 'Edit'))).toBe('Edited src/main.ts')
    expect(activityTitle(step('Read', { input: '{"file_path":' }, 'Read'))).toBe('Read a file')
    expect(activityTitle(step('WebFetch', { input: '{"url":"https://example.com/private/path?q=1"}' }))).toBe('Fetched example.com')
    expect(activityTitle(step('execute', { input: '{"command":"cargo test --workspace"}' }))).toBe('Ran cargo test --workspace')
  })

  it('classifies files, edits and searches without calling file reads edits', () => {
    expect(activityCategory(step('Read', {}))).toBe('read')
    expect(activityCategory(step('Edit', {}))).toBe('file')
    expect(activityCategory(step('Glob', {}))).toBe('search')
    expect(activityCategory(step('tool', { tool: 'Grep' }))).toBe('search')
  })

  it('keeps the file name for long paths and counts multi-file changes', () => {
    const long = 'C:/Users/someone/very/deep/folder/structure/that/goes/on/and/on/more/and/more/src/file.ts'
    const read = activityTitle(step('Read', { tool: 'Read', input: JSON.stringify({ file_path: long }) }, 'Read'))
    expect(read.startsWith('Read …')).toBe(true)
    expect(read.endsWith('file.ts')).toBe(true)
    const grep = activityTitle(step('Grep', { tool: 'Grep', pattern: 'needle', path: long }, 'Grep'))
    expect(grep.startsWith('Searched needle in …')).toBe(true)
    expect(grep.endsWith('file.ts')).toBe(true)
    expect(activityTitle(step('fileChange', { tool: 'fileChange', fileCount: 3 }))).toBe('Edited 3 files')
  })

  it('does not call a non-shell tool a command just because it takes one', () => {
    expect(activityCategory(step('mcpToolCall', { tool: 'mcp__thing__run', input: '{"command":"rm -rf /"}' }))).toBe('tool')
    expect(activityCategory(step('NotebookRead', {}))).toBe('read')
  })

  it('lays the companion activity list flat so it keeps no nested indent', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      act(() => root.render(<ActivitySteps items={[step('Bash', { command: 'npm test' })]} />))
      const list = host.querySelector<HTMLOListElement>('.activity-steps')!
      expect(list.classList.contains('flat')).toBe(true)
    } finally { act(() => root.unmount()); host.remove() }
  })

  it('keeps the full command behind expand and groups steps in stable order', () => {
    const command = 'cargo test --workspace --exclude bloblex-desktop --no-fail-fast\nWrite-Output "complete"'
    const items = [step('Read', { path: 'src/main.ts' }), step('Bash', { command }), step('Glob', { pattern: '*.ts' })]
    const group = groupConversationActivity(items)[0] as ActivityGroup
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      act(() => root.render(<ActivitySummaryLine group={group} />))
      expect(host.textContent).toContain('Ran 1 command · used 2 tools')
      expect(host.textContent).not.toContain(command)
      act(() => host.querySelector<HTMLButtonElement>('.activity-summary-toggle')!.click())
      expect([...host.querySelectorAll('h4')].map((node) => node.textContent)).toEqual(['Commands', 'Files', 'Searches'])
      expect(host.querySelector('pre')).toBeNull()
      expect(host.textContent).not.toContain(command)
      const commandStep = [...host.querySelectorAll<HTMLButtonElement>('.activity-step-head')].find((node) => node.textContent?.startsWith('Ran cargo test'))!
      act(() => commandStep.click())
      expect(host.querySelector('pre')?.textContent).toBe(command)
    } finally { act(() => root.unmount()); host.remove() }
  })
})
