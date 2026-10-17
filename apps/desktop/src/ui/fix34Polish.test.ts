import { describe, expect, it } from 'vitest'
import type { Session } from '../types'
import { groupQuickSwitcherResults, type QuickSwitcherItem } from './quickSwitcherModel'
import { clampToViewport } from './tour/placement'
import { compareVersions, releaseNotes, shouldShowWhatsNew, unwrapMarkdown } from './WhatsNew'
import { remoteBannerCopy } from './RemoteChip'
import { botProjectName, companionConversations } from './CompanionConversationPicker'

const item = (id: string, extra: Partial<QuickSwitcherItem>): QuickSwitcherItem => ({ id, kind: 'action', title: id, subtitle: '', searchText: id, ...extra })

describe('command palette groups', () => {
  it('keeps each group together in a fixed order, rank order inside a group', () => {
    const ranked = [item('help', { category: 'Help' }), item('c1', { kind: 'conversation' }), item('new', { category: 'Create' }), item('c2', { kind: 'conversation' }), item('bot', { kind: 'blob' })]
    expect(groupQuickSwitcherResults(ranked).map((entry) => entry.id)).toEqual(['c1', 'c2', 'bot', 'new', 'help'])
  })
})

describe('tour spotlight', () => {
  it('stays inside the window so its ring is not clipped', () => {
    expect(clampToViewport({ x: -6, y: 40, width: 240, height: 300 }, { width: 1200, height: 800 }, 6)).toEqual({ x: 6, y: 40, width: 228, height: 300 })
    expect(clampToViewport({ x: 100, y: 100, width: 50, height: 50 }, { width: 1200, height: 800 }, 6)).toEqual({ x: 100, y: 100, width: 50, height: 50 })
  })
})

describe('what is new', () => {
  it('orders betas numerically and opens only after an update with a note', () => {
    expect(compareVersions('0.1.0-beta.30', '0.1.0-beta.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.1.0-beta.30')).toBeGreaterThan(0)
    const notes = releaseNotes({ '../../../../docs/releases/0.1.0-beta.9.md': '# Bitbots 0.1.0-beta.9\n\nOld', '../../../../docs/releases/0.1.0-beta.30.md': '# Bitbots 0.1.0-beta.30\n\nNew' })
    expect(notes.map((note) => note.version)).toEqual(['0.1.0-beta.30', '0.1.0-beta.9'])
    expect(notes[0]!.text).toBe('New')
    expect(shouldShowWhatsNew('0.1.0-beta.29', '0.1.0-beta.30', notes)).toBe(true)
    expect(shouldShowWhatsNew(null, '0.1.0-beta.30', notes)).toBe(false)
    expect(shouldShowWhatsNew('0.1.0-beta.30', '0.1.0-beta.30', notes)).toBe(false)
    expect(shouldShowWhatsNew('0.1.0-beta.29', '0.1.0-beta.31', notes)).toBe(false)
  })
})

describe('release note unwrapping', () => {
  it('joins wrapped lines into their paragraph or list item, keeping blocks apart', () => {
    const wrapped = 'Intro line one\nline two.\n\n## New\n\n- **Fast after\n  load.** Models cached\n  at boot.\n- Second item\n\n```\nkeep\nthis\n```'
    expect(unwrapMarkdown(wrapped)).toBe('Intro line one line two.\n\n## New\n\n- **Fast after load.** Models cached at boot.\n- Second item\n\n```\nkeep\nthis\n```')
  })
})

describe('remote banner', () => {
  it('says what Remote is doing in a word and a line', () => {
    expect(remoteBannerCopy({ enabled: false, link: 'off', deviceCount: 0 })).toMatchObject({ state: 'Off', tone: 'off' })
    expect(remoteBannerCopy({ enabled: true, link: 'online', deviceCount: 0 })).toMatchObject({ state: 'On', detail: 'No devices yet' })
    expect(remoteBannerCopy({ enabled: true, link: 'online', deviceCount: 2, connectedCount: 1 })).toMatchObject({ detail: '1 device connected', tone: 'live' })
    expect(remoteBannerCopy({ enabled: true, link: 'error', deviceCount: 0 })).toMatchObject({ state: 'Problem', tone: 'waiting' })
  })
})

describe('companion conversations', () => {
  const s = (id: string, extra: Partial<Session>): Session => ({ id, runtimeId: 'rt', agentId: 'a', ...extra })
  it('lists the bot’s own conversations newest first, skipping empty ones except the open one', () => {
    const sessions = [
      s('old', { updatedAt: '2026-10-10', messages: [{ id: 'm', role: 'user', content: 'x' }] }),
      s('new', { updatedAt: '2026-10-16', messages: [{ id: 'm', role: 'user', content: 'x' }] }),
      s('empty', { updatedAt: '2026-10-17', messages: [] }),
      s('side', { updatedAt: '2026-10-17', link: { kind: 'side' } as never }),
      s('other', { agentId: 'b', updatedAt: '2026-10-17' }),
    ]
    expect(companionConversations(sessions, 'a', null).map((x) => x.id)).toEqual(['new', 'old'])
    expect(companionConversations(sessions, 'a', 'empty').map((x) => x.id)).toEqual(['empty', 'new', 'old'])
    expect(botProjectName({ id: 'a', projectId: 'p' } as never, [{ id: 'p', name: 'crewspan' } as never])).toBe('crewspan')
    expect(botProjectName({ id: 'a' } as never, [])).toBeNull()
  })
})
