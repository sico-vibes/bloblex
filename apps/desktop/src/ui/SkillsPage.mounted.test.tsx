// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rpc: vi.fn(), openProjectFolder: vi.fn(), previewBackupImport: vi.fn(), selectBackupImportPath: vi.fn() }))
vi.mock('../tauri', () => ({
  rpc: h.rpc,
  openProjectFolder: h.openProjectFolder,
  previewBackupImport: h.previewBackupImport,
  selectBackupImportPath: h.selectBackupImportPath,
  selectBackupExportPath: vi.fn(),
  writeBackupExport: vi.fn(),
}))

import { candidateKey, defaultPicks, filterSkills, formatBytes, SkillsPage, type SkillRow } from './SkillsPage'
import { BotSkillsGroup, skillOnForBot } from './BotSkillsGroup'
import { BackupPage, importResolutions, statsSentence } from './BackupPage'

const skill = (name: string, extra: Partial<SkillRow> = {}): SkillRow => ({ name, description: `${name} helper`, source: 'claude', enabled: true, disabledFor: [], nativeFor: [], ...extra })
const mounted: Array<{ root: Root; host: HTMLDivElement }> = []
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function mount(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(node); await flush() })
  mounted.push({ root, host })
  return host
}
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(text) || item.getAttribute('aria-label') === text) as HTMLButtonElement
const click = async (element: HTMLElement) => { await act(async () => { element.click(); await flush(); await flush() }) }

beforeEach(() => {
  h.rpc.mockReset()
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => {
  for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() }
})

describe('skills helpers', () => {
  it('filters on every word, formats sizes and ticks only new or changed candidates', () => {
    expect(filterSkills([skill('pdf'), skill('release-notes', { description: 'git log notes' })], 'GIT notes').map((item) => item.name)).toEqual(['release-notes'])
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(18_400)).toBe('18 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
    const candidates = [
      { source: 'claude', name: 'a', description: '', path: '', status: 'new' as const },
      { source: 'codex', name: 'b', description: '', path: '', status: 'same' as const },
      { source: 'codex', name: 'c', description: '', path: '', status: 'changed' as const },
    ]
    expect([...defaultPicks(candidates)]).toEqual([candidateKey(candidates[0]), candidateKey(candidates[2])])
  })

  it('a bot sees a skill only when the pool has it on and the bot has not opted out', () => {
    expect(skillOnForBot(skill('a'), 'bot-1')).toBe(true)
    expect(skillOnForBot(skill('a', { disabledFor: ['bot-1'] }), 'bot-1')).toBe(false)
    expect(skillOnForBot(skill('a', { enabled: false }), 'bot-1')).toBe(false)
  })

  it('describes backup counts in words and keeps rename as the default resolution', () => {
    expect(statsSentence({ bots: 1, memory: 3, skills: 0, automations: 0, settings: 2 }, ['bot', 'bots'])).toBe('1 bot, 3 notes and 2 settings')
    expect(statsSentence({ bots: 0, memory: 0, skills: 0, automations: 0, settings: 0 }, ['bot', 'bots'])).toBe('nothing')
    expect(importResolutions({ x: 'replace' }, { pdf: 'skip' })).toEqual({ bots: { x: 'replace' }, skills: { pdf: 'skip' }, default: 'rename' })
  })
})

describe('Skills page', () => {
  it('scans, imports only the ticked candidates, and toggles a skill', async () => {
    const pool = [skill('pdf')]
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'skills.list') return { skills: pool }
      if (method === 'settings.get') return { settings: { 'skills.enabled': true } }
      if (method === 'skills.scan') return { candidates: [
        { source: 'claude', name: 'pdf', description: 'same', path: 'x', status: 'same' },
        { source: 'codex', name: 'notes', description: 'new', path: 'y', status: 'new' },
      ] }
      if (method === 'skills.import') return { imported: (params.items as unknown[]).map(() => 'notes'), skipped: [] }
      return {}
    })
    const host = await mount(<SkillsPage connected />)
    expect(host.textContent).toContain('pdf')
    await click(button(host, 'From your coding agents'))
    const boxes = [...host.querySelectorAll<HTMLInputElement>('.skills-candidate input')]
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([[false, true], [true, false]])
    await click(button(host, 'Import 1'))
    expect(h.rpc).toHaveBeenCalledWith('skills.import', { items: [{ source: 'codex', name: 'notes' }] })
    expect(host.textContent).toContain('Imported 1 skill.')
    await click(button(host, 'Use pdf'))
    expect(h.rpc).toHaveBeenCalledWith('skills.toggle', { name: 'pdf', enabled: false })
  })

  it('the bot page switch opts this bot out without touching the pool switch', async () => {
    h.rpc.mockImplementation(async (method: string) => {
      if (method === 'skills.list') return { skills: [skill('pdf')] }
      if (method === 'settings.get') return { settings: {} }
      return {}
    })
    const host = await mount(<BotSkillsGroup agentId="bot-1" />)
    await click(button(host, 'Let this bot use pdf'))
    expect(h.rpc).toHaveBeenCalledWith('skills.toggle', { name: 'pdf', enabled: false, agentId: 'bot-1' })
  })
})

describe('Backup page', () => {
  it('previews a file, asks about conflicts, and restores with the chosen answers', async () => {
    h.selectBackupImportPath.mockResolvedValue('token')
    h.previewBackupImport.mockResolvedValue({
      previewId: 'p1',
      counts: { bots: 2, memory: 1, skills: 1, automations: 0, settings: 0 },
      conflicts: { bots: [{ exportId: 'e1', name: 'Mochi', existingAgentId: 'a1' }], skills: [{ name: 'pdf', same: false }], memory: [], settings: [] },
      warnings: ['One bot used Bypass approvals; it is restored as Ask.'],
    })
    h.rpc.mockResolvedValue({ imported: { bots: 2, memory: 1, skills: 0, automations: 0, settings: 0 }, skipped: { bots: 0, memory: 0, skills: 1, automations: 0, settings: 0 }, renamed: [{ from: 'Mochi', to: 'Mochi (2)' }] })
    const host = await mount(<BackupPage connected />)
    await click(button(host, 'Choose a backup…'))
    expect(host.textContent).toContain('This backup holds 2 bots, 1 note and 1 skill.')
    expect(host.textContent).toContain('restored as Ask')
    await click(button(host, 'Restore'))
    expect(h.rpc).toHaveBeenCalledWith('backup.import', { previewId: 'p1', resolutions: { bots: { e1: 'rename' }, skills: { pdf: 'skip' }, default: 'rename' } })
    expect(host.textContent).toContain('Renamed Mochi to Mochi (2).')
  })
})
