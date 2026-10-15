// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Runtime } from '../types'
import { createDraft, type AgentDraft, type FieldErrors } from './agentForm'
import { BotWizard } from './BotWizard'

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { if (root) act(() => root?.unmount()); host?.remove(); root = null; host = null })

const runtime = { id: 'rt', provider: 'codex', authState: 'authenticated' } as unknown as Runtime

function Harness({ onCreate, errors = {} as FieldErrors, ready = true }: { onCreate: () => void; errors?: FieldErrors; ready?: boolean }) {
  const [draft, setDraft] = useState<AgentDraft>(() => createDraft([runtime], 'rt'))
  return <BotWizard draft={draft} errors={errors} noun="bot" ready={ready} saving={false} providerName="Codex" onDraftChange={setDraft}
    renderSections={(sections) => <div data-testid="sections">{sections.join(',')}</div>} onCreate={onCreate} onAdvanced={vi.fn()} onCancel={vi.fn()} />
}
function mount(ui: React.ReactElement) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(ui))
  return host
}
const click = (view: HTMLElement, text: string) => act(() => { [...view.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)!.click() })

describe('BotWizard', () => {
  it('starts from a template, walks the steps with the right sections and creates on the last one', () => {
    const create = vi.fn()
    const view = mount(<Harness onCreate={create} />)
    expect(view.querySelector('h2')?.textContent).toBe('Start from')
    act(() => { view.querySelector<HTMLButtonElement>('.bot-template')!.click() })
    expect(view.querySelector('h2')?.textContent).toBe('Name it')
    expect(view.querySelector('[data-testid="sections"]')?.textContent).toBe('profile,team')
    click(view, 'Next')
    expect(view.querySelector('[data-testid="sections"]')?.textContent).toBe('model')
    click(view, 'Next')
    expect(view.querySelector('[data-testid="sections"]')?.textContent).toBe('permissions,look')
    click(view, 'Next')
    expect(view.querySelector('h2')?.textContent).toBe('Review')
    expect(view.querySelector('.bot-wizard-review')?.textContent).toContain('Codex')
    click(view, 'Create bot')
    expect(create).toHaveBeenCalledOnce()
  })

  it('blocks Next while the step has an error and goes back', () => {
    const view = mount(<Harness onCreate={vi.fn()} errors={{ name: 'Enter a name.' }} />)
    click(view, 'Start blank')
    expect(view.querySelector('h2')?.textContent).toBe('Name it')
    expect(view.querySelector('.bot-wizard-block')?.textContent).toBe('Enter a name.')
    expect(view.querySelector<HTMLButtonElement>('.primary-button')!.disabled).toBe(true)
    click(view, 'Back')
    expect(view.querySelector('h2')?.textContent).toBe('Start from')
  })
})
