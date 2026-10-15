// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanCard } from './TeamMessages'

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { if (root) act(() => root?.unmount()); host?.remove(); root = null; host = null })

function mount(props: Partial<React.ComponentProps<typeof PlanCard>>) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<PlanCard text={'1. Add the helper\n2. Wire the helper\n3. Write tests'} renderText={(text) => <pre>{text}</pre>} canApprove={false} onApprove={vi.fn()} onRevise={vi.fn()} {...props} />))
  return host
}

describe('PlanCard', () => {
  it('shows the formatted plan until a step has been carried out', () => {
    const view = mount({ steps: ['Add the helper', 'Wire the helper', 'Write tests'], progress: [0, 0, 0] })
    expect(view.querySelector('.plan-card-body')).not.toBeNull()
    expect(view.querySelector('.plan-card-steps')).toBeNull()
  })

  it('turns into a checklist with a count once steps are done', () => {
    const view = mount({ steps: ['Add the helper', 'Wire the helper', 'Write tests'], progress: [1, 1, 0] })
    expect(view.querySelector('.plan-card-body')).toBeNull()
    const items = [...view.querySelectorAll('.plan-card-steps li')]
    expect(items.map((item) => item.classList.contains('done'))).toEqual([true, true, false])
    expect(view.querySelector('.plan-card-count')?.getAttribute('aria-label')).toBe('2 of 3 steps done')
    expect(view.querySelector('.plan-card-meter b')?.getAttribute('style')).toContain('67%')
    expect(items[2]?.textContent).toContain('not done yet')
  })
})
