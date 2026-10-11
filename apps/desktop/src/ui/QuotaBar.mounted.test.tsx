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
  it('keeps OpenCode Go 5h, weekly and monthly metrics in the same row', async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(<QuotaBar quotas={[{ provider:'opencode', fetchedAt:'2026-10-11T12:00:00Z', snapshot:{ limits:[
      { label:'5-hour', primary:{ usedPercent:5, windowDurationMins:300, resetsAt:'2026-10-11T13:00:00Z' } },
      { label:'Weekly', primary:{ usedPercent:7, windowDurationMins:10080, resetsAt:'2026-10-16T12:00:00Z' } },
      { label:'Monthly', primary:{ usedPercent:17, windowDurationMins:null, resetsAt:'2026-10-30T12:00:00Z' } },
    ] } }]} refreshing={false} onRefresh={() => undefined} onOpenDetails={() => undefined} />))
    await act(async () => { (host!.querySelector('.quota-bar-trigger') as HTMLButtonElement).click(); await Promise.resolve() })
    const windows = [...host!.querySelectorAll('.usage-row-windows .usage-row-window')]
    expect(windows).toHaveLength(3)
    expect(windows.map((item) => item.textContent?.trim())).toEqual(expect.arrayContaining(['5h5%', 'wk7%', '30d17%']))
  })
})
