// @vitest-environment happy-dom
// Phase 1A: the companion's conversation picker groups a bot's conversations by project.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Project, Session } from '../types'
import { botProjectName, CompanionConversationPicker } from './CompanionConversationPicker'

const bot = { id: 'a1', name: 'Alpha', runtimeId: 'rt', projectId: 'p1' } as Agent
const projects: Project[] = [
  { id: 'p1', name: 'Korus', path: 'D:\\korus', sortOrder: 0 },
  { id: 'p2', name: 'Site', path: 'D:\\site', sortOrder: 1 },
]
const said = [{ id: 'm1', role: 'user', text: 'hi' }] as Session['messages']
function conversation(id: string, title: string, projectId: string | null, updatedAt: string): Session {
  return { id, runtimeId: 'rt', agentId: bot.id, title, projectId, messages: said, updatedAt }
}

let root: Root | null = null
let host: HTMLDivElement | null = null
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => { if (root) act(() => root!.unmount()); root = null; host?.remove(); host = null })

function mount(sessions: Session[], current: Session | null, onPick = vi.fn()) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<CompanionConversationPicker agent={bot} sessions={sessions} projects={projects} current={current} onPick={onPick} />))
  return host
}
const open = async (view: HTMLElement) => { await act(async () => { view.querySelector<HTMLButtonElement>('.select-trigger')!.click() }) }
const listed = () => [...document.querySelectorAll('.select-group-label, [role="option"]')].map((node) => node.textContent)

describe('companion conversation picker (Phase 1A)', () => {
  it('groups conversations by project, most recently used project first', async () => {
    const sessions = [
      conversation('s1', 'Layout', 'p1', '2026-10-29T10:00:00.000Z'),
      conversation('s2', 'Copy', 'p2', '2026-10-29T12:00:00.000Z'),
      conversation('s3', 'Tests', 'p1', '2026-10-29T09:00:00.000Z'),
      conversation('s4', 'Chatting', null, '2026-10-28T09:00:00.000Z'),
    ]
    const onPick = vi.fn()
    const view = mount(sessions, sessions[1], onPick)
    await open(view)
    expect(listed()).toEqual(['Site', 'Copy', 'Korus', 'Layout', 'Tests', 'No project', 'Chatting'])
    await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'Tests')!.click() })
    expect(onPick).toHaveBeenCalledWith(sessions[2])
  })

  it('shows no group headings when every conversation is in one project', async () => {
    const sessions = [conversation('s1', 'Layout', 'p1', '2026-10-29T10:00:00.000Z'), conversation('s2', 'Tests', 'p1', '2026-10-29T09:00:00.000Z')]
    const view = mount(sessions, sessions[0])
    await open(view)
    expect(listed()).toEqual(['Layout', 'Tests'])
  })

  it('names the open conversation\u2019s project, not the bot\u2019s default', () => {
    const inSite = conversation('s2', 'Copy', 'p2', '2026-10-29T12:00:00.000Z')
    const noProject = conversation('s4', 'Chatting', null, '2026-10-28T09:00:00.000Z')
    expect(botProjectName(bot, projects, inSite)).toBe('Site')
    expect(botProjectName(bot, projects, noProject)).toBeNull()
    expect(botProjectName(bot, projects)).toBe('Korus')
  })
})
