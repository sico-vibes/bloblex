// @vitest-environment happy-dom
import { chooseOption, selectTrigger, selectValue } from './testSelect'
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEV_BUILD_UPDATES_MESSAGE, NO_STABLE_RELEASE_MESSAGE, UP_TO_DATE_MESSAGE, UPDATE_ERROR_MESSAGES, UPDATE_FAILED_MESSAGE,
  type UpdateCheckResult, type UpdateInfo, type UpdateProgress, type UpdatesState,
} from '../updatesContract'
import { DISMISSED_UPDATE_VERSION_KEY, UpdateAvailableBanner, useMainUpdateOffer } from './UpdateBanner'
import { SettingsSheet } from './SettingsSheet'
import { UpdatesPanel } from './UpdatesPanel'

const h = vi.hoisted(() => ({
  updatesGetState: vi.fn(),
  updatesSetPreferences: vi.fn(),
  updatesCheck: vi.fn(),
  updatesInstall: vi.fn(),
  listenForUpdateAvailable: vi.fn(),
  listenForUpdateProgress: vi.fn(),
  rpc: vi.fn(),
  permissionsPolicyGet: vi.fn(),
}))

vi.mock('../tauri', () => ({
  inDesktop: true,
  rpc: h.rpc,
  permissionsPolicyGet: h.permissionsPolicyGet,
  setCompanionVisibility: vi.fn(),
  setCloseToTray: vi.fn(),
  setCompanionMonitor: vi.fn(),
  companionMonitorOptions: async () => [],
  currentCompanionMonitor: async () => null,
  updatesGetState: h.updatesGetState,
  updatesSetPreferences: h.updatesSetPreferences,
  updatesCheck: h.updatesCheck,
  updatesInstall: h.updatesInstall,
  listenForUpdateAvailable: h.listenForUpdateAvailable,
  listenForUpdateProgress: h.listenForUpdateProgress,
}))
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }))

function state(partial: Partial<UpdatesState> = {}): UpdatesState {
  return { currentVersion: '0.1.0', channel: 'beta', autoCheck: true, lastCheckedAt: null, available: null, devBuild: false, ...partial }
}

const offer: UpdateInfo = { version: '0.2.0', notes: 'Parser totals use integers.', pubDate: '2026-10-01T15:04:00.000Z', channel: 'beta' }

function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => { root.render(node) })
  return {
    host,
    async settle() {
      await act(async () => {
        await Promise.resolve()
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      })
    },
    unmount() { act(() => root.unmount()); host.remove() },
  }
}

const views: Array<{ unmount: () => void }> = []
afterEach(() => { for (const view of views.splice(0)) view.unmount(); vi.restoreAllMocks() })

beforeEach(() => {
  // In-memory storage so the tests do not depend on the runtime's own localStorage.
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => store.clear(),
  })
  for (const mock of Object.values(h)) mock.mockReset()
  h.updatesGetState.mockResolvedValue(state())
  h.updatesSetPreferences.mockImplementation(async (patch: Partial<UpdatesState>) => state(patch))
  h.updatesCheck.mockResolvedValue({ status: 'up_to_date', checkedAt: '2026-10-02T08:00:00.000Z' } satisfies UpdateCheckResult)
  h.updatesInstall.mockResolvedValue(undefined)
  h.listenForUpdateAvailable.mockResolvedValue(() => undefined)
  h.listenForUpdateProgress.mockResolvedValue(() => undefined)
  h.rpc.mockResolvedValue({ settings: { showCompanion: true, closeToTray: true } })
  h.permissionsPolicyGet.mockResolvedValue({ defaultMode: 'ask', perAgent: [] })
})

function buttonNamed(root: ParentNode, label: string) {
  return [...root.querySelectorAll('button')].find((item) => item.textContent?.includes(label) || item.getAttribute('aria-label') === label)
}

async function openUpdates(search: { sessions?: Array<{ id: string; runtimeId: string; state: string }>; permissions?: Array<{ id: string; sessionId?: string; status?: string }> } = {}) {
  const view = mount(<SettingsSheet snapshot={{ agents: [], sessions: search.sessions ?? [], permissions: search.permissions ?? [] }} initialPage="Updates" onClose={() => undefined} onRefresh={() => undefined} onError={() => undefined} onOpenAgent={() => undefined} />)
  views.push(view)
  await view.settle()
  await view.settle()
  return view
}

describe('updates settings', () => {
  it('shows every check outcome and never the raw error text', async () => {
    const view = await openUpdates()
    const updates = view.host.querySelector('[data-settings-section="updates"]')
    expect(updates?.textContent).toContain('Current version')
    expect(updates?.querySelector('[data-update-version]')?.textContent).toBe('0.1.0')
    expect(updates?.querySelector('[data-update-last-checked]')?.textContent).toBe('Not checked yet')
    expect(updates?.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite')
    expect(view.host.querySelector('.settings-nav')?.textContent).toContain('Updates')

    const check = view.host.querySelector<HTMLButtonElement>('[data-update-check]')!
    await act(async () => { check.click() })
    await view.settle()
    expect(view.host.querySelector('[data-update-status]')?.textContent).toBe(UP_TO_DATE_MESSAGE)
    expect(buttonNamed(view.host, 'Install and restart')).toBeUndefined()

    h.updatesCheck.mockResolvedValueOnce({ status: 'no_stable_release', checkedAt: '2026-10-02T09:00:00.000Z', message: 'SECRET_STABLE' })
    await act(async () => { check.click() })
    await view.settle()
    expect(view.host.querySelector('[data-update-status]')?.textContent).toBe(NO_STABLE_RELEASE_MESSAGE)
    expect(view.host.textContent).not.toContain('SECRET_STABLE')

    for (const code of ['network', 'signature', 'manifest', 'unavailable'] as const) {
      h.updatesCheck.mockResolvedValueOnce({ status: 'error', error: code, message: `RAW ${code} SECRET_ERR`, checkedAt: '2026-10-02T09:00:00.000Z' })
      await act(async () => { view.host.querySelector<HTMLButtonElement>('[data-update-check]')!.click() })
      await view.settle()
      expect(view.host.querySelector('[data-update-status]')?.textContent).toBe(UPDATE_ERROR_MESSAGES[code])
      expect(view.host.textContent).not.toContain('SECRET_ERR')
      expect(view.host.querySelector('[data-update-check]')?.textContent).toBe('Retry')
    }

    h.updatesCheck.mockResolvedValueOnce({ status: 'error', error: 'panic SECRET_STACK', message: 'SECRET_STACK', checkedAt: '' })
    await act(async () => { view.host.querySelector<HTMLButtonElement>('[data-update-check]')!.click() })
    await view.settle()
    expect(view.host.querySelector('[data-update-status]')?.textContent).toBe(UPDATE_FAILED_MESSAGE)
    expect(view.host.textContent).not.toContain('SECRET_STACK')
  })

  it('disables Check now and announces while a check is in progress', async () => {
    let finish: (result: UpdateCheckResult) => void = () => undefined
    h.updatesCheck.mockImplementation(() => new Promise<UpdateCheckResult>((resolve) => { finish = resolve }))
    const view = await openUpdates()
    const check = view.host.querySelector<HTMLButtonElement>('[data-update-check]')!
    await act(async () => { check.click() })
    await view.settle()
    expect(check.textContent).toBe('Checking…')
    expect(check.disabled).toBe(true)
    expect(view.host.querySelector('[data-update-status]')?.textContent).toBe('Checking for updates.')
    await act(async () => { finish({ status: 'up_to_date', checkedAt: '2026-10-02T10:00:00.000Z' }) })
    await view.settle()
    expect(view.host.querySelector('[data-update-status]')?.textContent).toBe(UP_TO_DATE_MESSAGE)
    expect(view.host.querySelector<HTMLButtonElement>('[data-update-check]')!.disabled).toBe(false)
    expect(view.host.querySelector('[data-update-check]')?.textContent).toBe('Check now')
  })

  it('shows an available release with its version, date, and notes', async () => {
    h.updatesGetState.mockResolvedValue(state({
      lastCheckedAt: 'not-a-date',
      available: { ...offer, notes: 'Line one\n<script>SECRET_NOTE</script>', pubDate: 'not-a-date' },
    }))
    const missingDate = await openUpdates()
    expect(missingDate.host.querySelector('[data-update-offer]')?.textContent).toContain('Update 0.2.0 is available')
    expect(missingDate.host.querySelector('[data-update-offer] script')).toBeNull()
    expect(missingDate.host.querySelector('[data-update-offer]')?.textContent).toContain('SECRET_NOTE')
    expect(missingDate.host.querySelector('[data-update-last-checked]')?.textContent).toBe('Not checked yet')
    expect(missingDate.host.textContent).not.toContain('not-a-date')

    h.updatesGetState.mockResolvedValue(state({ lastCheckedAt: '2026-10-02T08:00:00.000Z', available: offer }))
    const view = await openUpdates()
    const text = view.host.querySelector('[data-update-offer]')?.textContent ?? ''
    expect(text).toContain('Update 0.2.0 is available')
    expect(text).toContain('2026')
    expect(text).toContain('Parser totals use integers.')
    expect(view.host.querySelector('[data-update-last-checked]')?.textContent).toContain('2026')
    expect(buttonNamed(view.host, 'Install and restart')).toBeTruthy()
  })

  it('disables update controls in a development build', async () => {
    h.updatesGetState.mockResolvedValue(state({ devBuild: true, available: { ...offer, notes: 'SECRET_DEV', version: '9.9.9' } }))
    const view = await openUpdates()
    expect(view.host.textContent).toContain(DEV_BUILD_UPDATES_MESSAGE)
    expect(view.host.textContent).not.toContain('SECRET_DEV')
    expect(view.host.textContent).not.toContain('9.9.9')
    expect(selectTrigger(view.host, 'Update channel')!.disabled).toBe(true)
    expect(view.host.querySelector<HTMLButtonElement>('[aria-label="Check for updates automatically"]')!.disabled).toBe(true)
    expect(view.host.querySelector<HTMLButtonElement>('[data-update-check]')!.disabled).toBe(true)
    expect(buttonNamed(view.host, 'Install and restart')).toBeUndefined()
    await act(async () => { view.host.querySelector<HTMLButtonElement>('[data-update-check]')!.click() })
    expect(h.updatesCheck).not.toHaveBeenCalled()
  })

  it('saves channel and automatic checks with exact arguments and keeps the previous value after a failure', async () => {
    const view = await openUpdates()
    const toggle = view.host.querySelector<HTMLButtonElement>('[aria-label="Check for updates automatically"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await act(async () => { toggle.click() })
    await view.settle()
    expect(h.updatesSetPreferences).toHaveBeenCalledWith({ autoCheck: false })
    expect(h.updatesSetPreferences.mock.calls[0]?.[0]).toEqual({ autoCheck: false })

    expect(view.host.querySelector('#update-channel-hint')?.textContent).toContain('pre-releases')
    await chooseOption(view.host, 'Update channel', 'stable')
    await view.settle()
    expect(h.updatesSetPreferences).toHaveBeenCalledWith({ channel: 'stable' })
    expect(view.host.querySelector('#update-channel-hint')?.textContent).toBe('Finished releases only.')

    h.updatesSetPreferences.mockRejectedValueOnce({ code: 'network', message: 'ENOTFOUND SECRET_HOST' })
    await act(async () => { view.host.querySelector<HTMLButtonElement>('[aria-label="Check for updates automatically"]')!.click() })
    await view.settle()
    expect(view.host.querySelector('[data-update-status]')?.textContent).toBe(UPDATE_ERROR_MESSAGES.network)
    expect(view.host.textContent).not.toContain('SECRET_HOST')
    expect(selectValue(view.host, 'Update channel')).toBe('stable')
    expect(view.host.querySelector<HTMLButtonElement>('[aria-label="Check for updates automatically"]')!.getAttribute('aria-checked')).toBe('true')
  })

  it('confirms before restarting running or approval-waiting sessions, and Escape returns focus without installing', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return <>
        <button type="button" onClick={() => setOpen(true)}>Open settings</button>
        {open && <SettingsSheet snapshot={{ agents: [], sessions: [
          { id: 'run', runtimeId: 'rt', state: 'working' },
          { id: 'ask', runtimeId: 'rt', state: 'idle' },
          { id: 'done', runtimeId: 'rt', state: 'completed' },
        ], permissions: [{ id: 'perm', sessionId: 'ask', status: 'pending' }] }} initialPage="Updates" onClose={() => setOpen(false)} onRefresh={() => undefined} onError={() => undefined} onOpenAgent={() => undefined} />}
      </>
    }
    h.updatesGetState.mockResolvedValue(state({ available: offer }))
    const view = mount(<Harness />)
    views.push(view)
    const opener = buttonNamed(view.host, 'Open settings')!
    opener.focus()
    await act(async () => { opener.click() })
    await view.settle()
    await view.settle()
    const install = buttonNamed(view.host, 'Install and restart') as HTMLButtonElement
    install.focus()
    await act(async () => { install.click() })
    await view.settle()
    const dialog = view.host.querySelector('[data-update-confirm]')
    expect(dialog?.textContent).toContain('2 sessions are running or waiting for approval. They will end when Bloblex restarts.')
    expect(view.host.querySelector('.settings-sheet')).not.toBeNull()
    expect(document.activeElement).toBe(dialog?.querySelector('[data-dialog-initial-focus]'))
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(view.host.querySelector('[data-update-confirm]')).toBeNull()
    expect(view.host.querySelector('.settings-sheet')).not.toBeNull()
    expect(document.activeElement).toBe(install)
    expect(h.updatesInstall).not.toHaveBeenCalled()

    await act(async () => { install.click() })
    await view.settle()
    const confirm = view.host.querySelector<HTMLButtonElement>('[data-update-confirm] .primary-button')!
    await act(async () => { confirm.click(); confirm.click() })
    await view.settle()
    expect(h.updatesInstall).toHaveBeenCalledTimes(1)
  })

  it('installs directly when nothing is running and reports progress for known and unknown totals', async () => {
    let onProgress: (progress: UpdateProgress) => void = () => undefined
    let failInstall: (reason: unknown) => void = () => undefined
    h.listenForUpdateProgress.mockImplementation(async (handler: (progress: UpdateProgress) => void) => { onProgress = handler; return () => undefined })
    h.updatesInstall.mockImplementation(() => new Promise((_resolve, reject) => { failInstall = reject }))
    h.updatesGetState.mockResolvedValue(state({ available: offer }))
    const view = mount(<UpdatesPanel sessions={[{ id: 'idle', state: 'completed' }]} />)
    views.push(view)
    await view.settle()
    const install = buttonNamed(view.host, 'Install and restart') as HTMLButtonElement
    await act(async () => { install.click() })
    await view.settle()
    expect(view.host.querySelector('[data-update-confirm]')).toBeNull()
    expect(h.updatesInstall).toHaveBeenCalledTimes(1)
    expect(install.disabled).toBe(true)

    await act(async () => { onProgress({ phase: 'downloading', downloadedBytes: 512, totalBytes: 2048 }) })
    const known = view.host.querySelector('[role="progressbar"]')
    expect(known?.getAttribute('aria-valuenow')).toBe('25')
    expect(view.host.querySelector('[data-update-status]')?.textContent).toBe('Downloaded 512 B of 2.0 KB (25%).')

    await act(async () => { onProgress({ phase: 'downloading', downloadedBytes: 512, totalBytes: null }) })
    const unknown = view.host.querySelector('[role="progressbar"]')
    expect(unknown?.hasAttribute('aria-valuenow')).toBe(false)
    expect(unknown?.className).toContain('is-indeterminate')
    expect(view.host.querySelector('[data-update-status]')?.textContent).toBe('Downloaded 512 B.')

    await act(async () => { onProgress({ phase: 'installing', downloadedBytes: 512, totalBytes: null }) })
    expect(view.host.querySelector('[data-update-status]')?.textContent).toBe('Installing. Bloblex will restart.')

    await act(async () => { failInstall({ code: 'manifest', message: 'parse SECRET_MANIFEST' }) })
    await view.settle()
    expect(view.host.querySelector('[role="progressbar"]')).toBeNull()
    expect(view.host.querySelector('[data-update-status]')?.textContent).toBe(UPDATE_ERROR_MESSAGES.manifest)
    expect(view.host.textContent).not.toContain('SECRET_MANIFEST')
    expect(buttonNamed(view.host, 'Install and restart')?.hasAttribute('disabled')).toBe(false)
  })

  it('keeps an indeterminate download static when motion is reduced', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('reduce'), media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(() => true),
    }) as unknown as MediaQueryList)
    let onProgress: (progress: UpdateProgress) => void = () => undefined
    h.listenForUpdateProgress.mockImplementation(async (handler: (progress: UpdateProgress) => void) => { onProgress = handler; return () => undefined })
    h.updatesInstall.mockImplementation(() => new Promise(() => undefined))
    h.updatesGetState.mockResolvedValue(state({ available: offer }))
    const view = mount(<UpdatesPanel />)
    views.push(view)
    await view.settle()
    await act(async () => { buttonNamed(view.host, 'Install and restart')!.click() })
    await view.settle()
    await act(async () => { onProgress({ phase: 'downloading', downloadedBytes: 10, totalBytes: null }) })
    const bar = view.host.querySelector('[role="progressbar"]')
    expect(bar?.className).toContain('is-reduced-motion')
    expect(bar?.className).not.toContain('is-indeterminate')
  })
})

describe('update banner', () => {
  function OfferHost({ companion = false }: { companion?: boolean }) {
    const offerState = useMainUpdateOffer(companion)
    if (!offerState.version) return null
    return <UpdateAvailableBanner version={offerState.version} onView={() => undefined} onLater={offerState.dismiss} />
  }

  it('shows a dismissible banner per version and stays hidden for the same version', async () => {
    h.updatesGetState.mockResolvedValue(state({ available: offer }))
    const view = mount(<OfferHost />)
    views.push(view)
    await view.settle()
    expect(view.host.querySelector('[data-update-banner]')?.textContent).toContain('Update 0.2.0 is available')
    await act(async () => { buttonNamed(view.host, 'Later')!.click() })
    expect(view.host.querySelector('[data-update-banner]')).toBeNull()
    expect(localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY)).toBe('0.2.0')

    view.unmount()
    const again = mount(<OfferHost />)
    views.push(again)
    await again.settle()
    expect(again.host.querySelector('[data-update-banner]')).toBeNull()

    h.updatesGetState.mockResolvedValue(state({ available: { ...offer, version: '0.3.0' } }))
    const newer = mount(<OfferHost />)
    views.push(newer)
    await newer.settle()
    expect(newer.host.querySelector('[data-update-banner]')?.textContent).toContain('Update 0.3.0 is available')
  })

  it('shows the next distinct event after Later, and never a dev or companion offer', async () => {
    let onAvailable: (info: UpdateInfo) => void = () => undefined
    h.listenForUpdateAvailable.mockImplementation(async (handler: (info: UpdateInfo) => void) => { onAvailable = handler; return () => undefined })
    h.updatesGetState.mockResolvedValue(state())
    const view = mount(<OfferHost />)
    views.push(view)
    await view.settle()
    expect(view.host.querySelector('[data-update-banner]')).toBeNull()
    await act(async () => { onAvailable(offer) })
    expect(view.host.querySelector('[data-update-banner]')?.textContent).toContain('Update 0.2.0 is available')
    await act(async () => { buttonNamed(view.host, 'Later')!.click() })
    await act(async () => { onAvailable(offer) })
    expect(view.host.querySelector('[data-update-banner]')).toBeNull()
    await act(async () => { onAvailable({ ...offer, version: '0.4.0', notes: 'SECRET_BANNER' }) })
    expect(view.host.querySelector('[data-update-banner]')?.textContent).toContain('Update 0.4.0 is available')
    expect(view.host.textContent).not.toContain('SECRET_BANNER')

    h.updatesGetState.mockClear()
    h.updatesGetState.mockResolvedValue(state({ devBuild: true, available: offer }))
    const dev = mount(<OfferHost />)
    views.push(dev)
    await dev.settle()
    expect(dev.host.querySelector('[data-update-banner]')).toBeNull()

    h.updatesGetState.mockClear()
    const companion = mount(<OfferHost companion />)
    views.push(companion)
    await companion.settle()
    expect(companion.host.querySelector('[data-update-banner]')).toBeNull()
    expect(h.updatesGetState).not.toHaveBeenCalled()
  })

  it('survives storage failures without rendering a thrown message', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SECRET_STORAGE_READ') })
    h.updatesGetState.mockResolvedValue(state({ available: offer }))
    const view = mount(<OfferHost />)
    views.push(view)
    await view.settle()
    expect(view.host.querySelector('[data-update-banner]')).not.toBeNull()
    expect(view.host.textContent).not.toContain('SECRET_STORAGE_READ')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('SECRET_STORAGE_WRITE') })
    await act(async () => { buttonNamed(view.host, 'Later')!.click() })
    expect(view.host.querySelector('[data-update-banner]')).toBeNull()
    expect(view.host.textContent).not.toContain('SECRET_STORAGE_WRITE')
  })
})
