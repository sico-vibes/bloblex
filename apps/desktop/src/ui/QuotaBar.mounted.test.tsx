// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { QuotaBar } from './QuotaBar'

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
})

describe('Detailed Usage popover', () => {
  it('lists OpenCode Go 5h, weekly and monthly limits under one heading', async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(<QuotaBar quotas={[{ provider:'opencode', fetchedAt:'2026-10-11T12:00:00Z', snapshot:{ limits:[
      { label:'5-hour', primary:{ usedPercent:5, windowDurationMins:300, resetsAt:'2026-10-11T13:00:00Z' } },
      { label:'Weekly', primary:{ usedPercent:7, windowDurationMins:10080, resetsAt:'2026-10-16T12:00:00Z' } },
      { label:'Monthly', primary:{ usedPercent:17, windowDurationMins:null, resetsAt:'2026-10-30T12:00:00Z' } },
    ] } }]} refreshing={false} onRefresh={() => undefined} onOpenDetails={() => undefined} />))
    await act(async () => { (host!.querySelector('.quota-bar-trigger') as HTMLButtonElement).click(); await Promise.resolve() })
    const windows = [...host!.querySelectorAll('.usage-popover .limit-row')]
    expect(windows).toHaveLength(3)
    expect(windows.map((item) => item.querySelector('.limit-name')?.textContent)).toEqual(['Session', 'Weekly', 'Monthly'])
    expect(windows.map((item) => item.querySelector('.limit-value')?.textContent)).toEqual(['5%', '7%', '17%'])
    expect(windows.every((item) => item.querySelector('.quota-meter'))).toBe(true)
  })
})
