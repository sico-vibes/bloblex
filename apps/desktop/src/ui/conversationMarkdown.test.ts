import { describe, expect, it } from 'vitest'
import { conversationMarkdown } from './conversationMarkdown'

describe('conversationMarkdown', () => {
  it('exports ordered messages and summarizes tool activity without command details', () => {
    const markdown = conversationMarkdown({
      id: 's', runtimeId: 'r', title: 'Fix parser', projectPath: 'C:/work/app', createdAt: '2026-10-01T10:30:00Z',
      messages: [
        { id: 'u', role: 'user', text: 'Please fix it', createdAt: '2026-10-01T10:30:01Z' },
        { id: 'a', role: 'assistant', text: 'I will inspect the parser.', createdAt: '2026-10-01T10:30:02Z' },
      ],
      tools: [{ id: 't', title: 'Read file', command: 'secret command', status: 'completed', createdAt: '2026-10-01T10:30:03Z' }],
    }, 'Helper')
    expect(markdown).toContain('# Fix parser')
    expect(markdown).toContain('- Blob: Helper')
    expect(markdown).toContain('- Project: app')
    expect(markdown.indexOf('Please fix it')).toBeLessThan(markdown.indexOf('I will inspect'))
    expect(markdown).toContain('- Activity: Tool activity (completed)')
    expect(markdown).not.toContain('secret command')
  })
})
