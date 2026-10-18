// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticsDialog } from './DiagnosticsDialog'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  select: vi.fn(),
  write: vi.fn(),
}))

vi.mock('../tauri', () => ({
  inDesktop: true,
  previewMode: false,
  rpc: mocks.rpc,
  selectDiagnosticsExportPath: mocks.select,
  writeDiagnosticsExport: mocks.write,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

const PREVIEW = {
  generatedAt: '2026-10-18T20:00:00.000Z',
  fileName: 'bitbots-diagnostics-2026-10-18.zip',
  files: [
    { name: 'README.txt', sizeBytes: 900 },
    { name: 'environment.json', sizeBytes: 640 },
    { name: 'settings.json', sizeBytes: 1240 },
    { name: 'events.json', sizeBytes: 12800 },
    { name: 'logs/daemon.2026-10-18.log', sizeBytes: 33932 },
  ],
}

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.select.mockReset()
  mocks.write.mockReset()
  mocks.rpc.mockResolvedValue(PREVIEW)
  mocks.select.mockResolvedValue('diagnostics-token')
  mocks.write.mockResolvedValue({ path: 'C:\\Users\\you\\Documents\\bitbots-diagnostics-2026-10-18.zip', sizeBytes: 48512, files: [] })
})

afterEach(() => { if (root) act(() => root.unmount()); host?.remove() })

async function open() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<DiagnosticsDialog onClose={vi.fn()} />))
  await tick()
}

describe('the Export diagnostics preview', () => {
  it('lists every part of the zip before saving and hides no secret', async () => {
    await open()
    const list = document.querySelector('.diagnostics-contents')!
    const text = list.textContent ?? ''
    expect(text).toContain('README — what is inside')
    expect(text).toContain('Environment — app, OS and coding agent versions')
    expect(text).toContain('Settings — with secrets removed')
    expect(text).toContain('Recent activity — message and command text removed')
    expect(text).toContain('Log file — recent lines')
    expect(document.body.textContent).toContain('nothing is uploaded anywhere')
  })

  it('writes the zip through the native save token and reports where it went', async () => {
    await open()
    const save = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Save as…'))!
    await act(async () => { save.click() })
    await tick()
    expect(mocks.select).toHaveBeenCalledTimes(1)
    expect(mocks.write).toHaveBeenCalledWith('diagnostics-token')
    expect(document.body.textContent).toContain('Saved to C:\\Users\\you\\Documents\\bitbots-diagnostics-2026-10-18.zip')
  })

  it('says so when the list cannot be read and never enables saving', async () => {
    mocks.rpc.mockRejectedValue(new Error('The daemon is not running.'))
    await open()
    expect(document.body.textContent).toContain('The daemon is not running.')
    const save = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Save as…')) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it('moves focus into the dialog when it opens', async () => {
    await open()
    const close = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Not now'))!
    expect(document.activeElement).toBe(close)
  })

  it('closes only the dialog on Escape, not the sheet that opened it', async () => {
    const onClose = vi.fn()
    const sheetHeard = vi.fn()
    // The Settings sheet listens on `document` as well; the dialog must take
    // the key first so Escape does not close both at once.
    document.addEventListener('keydown', sheetHeard)
    try {
      host = document.createElement('div'); document.body.append(host); root = createRoot(host)
      await act(async () => root.render(<DiagnosticsDialog onClose={onClose} />))
      await tick()
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(sheetHeard).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', sheetHeard)
    }
  })
})
