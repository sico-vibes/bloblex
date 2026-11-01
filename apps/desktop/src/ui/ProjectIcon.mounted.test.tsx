// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'
import { ProjectIcon, ProjectIconPicker, projectIconChoice } from './ProjectIcon'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../tauri', () => ({ rpc }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let serial = 0
const project = (overrides: Project['overrides'] = {}): Project => ({ id: `p${++serial}`, name: 'Shop', path: `C:/work/shop${serial}`, sortOrder: 0, overrides })
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
beforeEach(() => { rpc.mockReset(); rpc.mockResolvedValue({ found: false }); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('ProjectIcon', () => {
  it('shows the favicon from the project folder when nothing was picked', async () => {
    rpc.mockResolvedValue({ found: true, mime: 'image/png', dataBase64: 'AAAA' })
    const target = project()
    await act(async () => root.render(<ProjectIcon project={target} />))
    await settle()
    expect(rpc).toHaveBeenCalledWith('project.favicon', { projectId: target.id })
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })

  it('falls back to a folder, and asks only once per project', async () => {
    const target = project()
    await act(async () => root.render(<ProjectIcon project={target} />))
    await settle()
    await act(async () => root.render(<ProjectIcon project={target} size={15} />))
    await settle()
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('svg')).not.toBeNull()
  })

  it('prefers the pick and reads no file for it', async () => {
    await act(async () => root.render(<ProjectIcon project={project({ icon: { kind: 'emoji', value: '🚀' } })} />))
    await settle()
    expect(host.textContent).toBe('🚀')
    expect(rpc).not.toHaveBeenCalled()
    await act(async () => root.render(<ProjectIcon project={project({ icon: { kind: 'lucide', value: 'rocket', color: '#3d9bff' } })} />))
    await settle()
    expect(host.querySelector('svg')?.getAttribute('stroke')).toBe('#3d9bff')
  })

  it('ignores an icon this build cannot draw', () => {
    expect(projectIconChoice(project({ icon: { kind: 'lucide', value: 'not-a-real-icon' } }))).toBeNull()
  })
})

describe('ProjectIconPicker', () => {
  const open = async (target: Project, onChange = vi.fn()) => { await act(async () => root.render(<ProjectIconPicker project={target} position={{ x: 10, y: 10 }} onChange={onChange} onClose={vi.fn()} />)); return onChange }

  it('picks an emoji, and resets to the favicon or folder', async () => {
    const onChange = await open(project({ icon: { kind: 'emoji', value: '🚀' } }))
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.project-icon-grid button')].find((button) => button.textContent === '🔥')!.click() })
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'emoji', value: '🔥', color: null })
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Reset')!.click() })
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('recolours a picked icon at once, and new picks keep the colour', async () => {
    const onChange = await open(project({ icon: { kind: 'lucide', value: 'rocket', color: null } }))
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Blue"]')!.click() })
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'lucide', value: 'rocket', color: '#3d9bff' })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="bot"]')!.click() })
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'lucide', value: 'bot', color: '#3d9bff' })
  })
})
