// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../types'
import { AgentRoster } from './AgentRoster'
import { emptyExpandedState } from './rosterSelectors'
import { emptyPins } from './sidebarPins'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
afterEach(() => { if (root) act(() => root.unmount()); host?.remove() })

function agent(id: string, sortOrder: number): Agent {
  return { id, name: id, description: '', instructions: '', color: 'mint', runtimeId: 'runtime', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder, archived: false, createdAt: '', updatedAt: '' }
}

describe('sidebar reorder keyboard interaction', () => {
  it('moves the focused favourite with Alt+ArrowDown and announces its visible position', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const move = vi.fn()
    const pins = { ...emptyPins(), favorites: ['a', 'b'], order: [] }
    await act(async () => root.render(<AgentRoster
      agents={[agent('a', 0), agent('b', 1)]} sessions={[]} runtimes={[{ id: 'runtime', provider: 'codex', status: 'online' }]}
      connected busy={false} pins={pins} selectedAgentId="a" selectedSessionId={null} query="" expanded={emptyExpandedState()}
      onToggleFavorite={vi.fn()} onMoveFavorite={move} onTogglePinProject={vi.fn()} onTogglePinSession={vi.fn()} onRevealProject={vi.fn()}
      onQueryChange={vi.fn()} onSelect={vi.fn()} onCreate={vi.fn()} onScan={vi.fn()} onNewSession={vi.fn()} onEdit={vi.fn()} onDuplicate={vi.fn()}
      onArchive={vi.fn()} onToggleBlob={vi.fn()} onToggleProject={vi.fn()} onToggleOther={vi.fn()} onSelectSession={vi.fn()}
      onNewSessionInProject={vi.fn()} onResumeSession={vi.fn()} onCancelSession={vi.fn()}
    />))
    const row = host.querySelector<HTMLButtonElement>('.bot-row[data-agent-id="a"]')!
    await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })))
    expect(move).toHaveBeenCalledWith('a', 'b', 'after', ['a', 'b'])
    expect(host.querySelector('[data-reorder-announcement]')?.textContent).toBe('a moved to position 2 of 2 in Favourites.')
  })
})
