// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
const saveGeneratedImage = vi.fn()
const bridge = vi.hoisted(() => ({ inDesktop: true }))
vi.mock('../tauri', () => ({
  get inDesktop() { return bridge.inDesktop },
  rpc: (...args: unknown[]) => rpc(...args),
  saveGeneratedImage: (...args: unknown[]) => saveGeneratedImage(...args),
  revealInExplorer: vi.fn(),
}))

import { GeneratedImage, generatedImageMeta, imagePromptFrom } from './GeneratedImage'
import { AttachMenu } from './ComposerControls'
import { CompanionChatItem } from './CompanionTeam'

const okReply = { status: 'ok', name: 'sunrise.png', kind: 'image', mediaType: 'image/png', size: 2048, dataUrl: 'data:image/png;base64,AAAA', relativePath: null }
const ready = { kind: 'generated_image', mediaId: 'one', status: 'ready', name: 'sunrise.png', bytes: 2048 }

let root: Root | null = null
let host: HTMLDivElement
async function render(element: React.ReactElement) {
  await act(async () => { root!.render(element) })
  await act(async () => { await Promise.resolve() })
}
const button = (label: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label)) as HTMLButtonElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  bridge.inDesktop = true
  rpc.mockReset()
  saveGeneratedImage.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  host.remove()
})

describe('generatedImageMeta', () => {
  it('reads only a generated image with a media id', () => {
    expect(generatedImageMeta({ kind: 'generated_image' })).toBeNull()
    expect(generatedImageMeta({ kind: 'usage_limit', mediaId: 'x' })).toBeNull()
    expect(generatedImageMeta(null)).toBeNull()
    expect(generatedImageMeta(ready)?.status).toBe('ready')
  })
  it('treats an unknown status as still waiting', () => {
    expect(generatedImageMeta({ kind: 'generated_image', mediaId: 'x', status: 'odd' })?.status).toBe('pending')
  })
})

describe('asking for an image', () => {
  const menu = (onGenerateImage?: () => void) => <AttachMenu imagesSupported imagesDisabled={false} imageCount={0} fileDisabled={false} onImages={vi.fn()} onPickFile={vi.fn()} onGenerateImage={onGenerateImage} />
  const openMenu = async () => { await act(async () => { (host.querySelector('button[aria-label="Attach"]') as HTMLButtonElement).click() }) }

  it('offers it only for a coding agent with an image tool', async () => {
    await render(menu())
    await openMenu()
    expect(host.textContent).not.toContain('Generate an image')
  })

  it('runs the action from the menu and closes it', async () => {
    const generate = vi.fn()
    await render(menu(generate))
    await openMenu()
    await act(async () => { button('Generate an image').click() })
    expect(generate).toHaveBeenCalledOnce()
    expect(host.querySelector('[role="menu"]')).toBeNull()
  })

  it('keeps the menu open to generate when nothing can be attached', async () => {
    await render(<AttachMenu imagesSupported={false} imagesDisabled imageCount={0} fileDisabled onImages={vi.fn()} onPickFile={vi.fn()} onGenerateImage={vi.fn()} />)
    expect((host.querySelector('button[aria-label="Attach"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('turns what is already typed into the description', () => {
    expect(imagePromptFrom('')).toBe('Use your image tool to generate an image of ')
    expect(imagePromptFrom('  a red kite ')).toBe('Use your image tool to generate an image of a red kite')
  })
})

describe('GeneratedImage', () => {
  it('the companion shows a generated image from its message', async () => {
    rpc.mockResolvedValue(okReply)
    await render(<CompanionChatItem currentSessionId="s1" agents={[]} onOpenSide={vi.fn()} message={{ id: 'comp-1', role: 'notice', content: 'Generated an image: sunrise.png', meta: { ...ready, mediaId: 'comp-1' } }} />)
    expect(rpc).toHaveBeenCalledWith('media.preview', { sessionId: 's1', mediaId: 'comp-1' })
    expect(host.querySelector('.generated-image.compact img')).not.toBeNull()
  })

  it('shows a waiting card and asks the daemon for nothing yet', async () => {
    await render(<GeneratedImage sessionId="s1" meta={generatedImageMeta({ kind: 'generated_image', mediaId: 'wait-1', status: 'pending' })!} />)
    expect(host.textContent).toContain('Generating an image…')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('shows the reason a generation failed', async () => {
    await render(<GeneratedImage sessionId="s1" meta={generatedImageMeta({ kind: 'generated_image', mediaId: 'bad-1', status: 'failed', detail: "The image didn't arrive." })!} />)
    expect(host.textContent).toContain("The image couldn't be generated")
    expect(host.textContent).toContain("The image didn't arrive.")
    expect(rpc).not.toHaveBeenCalled()
  })

  it('asks by media id, never by path, once the image is ready', async () => {
    rpc.mockResolvedValue(okReply)
    await render(<GeneratedImage sessionId="s1" meta={generatedImageMeta({ ...ready, mediaId: 'ask-1' })!} />)
    expect(rpc).toHaveBeenCalledWith('media.preview', { sessionId: 's1', mediaId: 'ask-1' })
    expect(host.querySelector('img')?.getAttribute('src')).toBe(okReply.dataUrl)
    expect(host.textContent).toContain('sunrise.png')
  })

  it('moves from waiting to the picture when the same message becomes ready', async () => {
    rpc.mockResolvedValue(okReply)
    await render(<GeneratedImage sessionId="s1" meta={generatedImageMeta({ kind: 'generated_image', mediaId: 'move-1', status: 'pending' })!} />)
    expect(host.querySelector('img')).toBeNull()
    await render(<GeneratedImage sessionId="s1" meta={generatedImageMeta({ ...ready, mediaId: 'move-1' })!} />)
    expect(host.querySelector('img')).not.toBeNull()
  })

  it('shows a file that has gone as a labelled card and can find it again', async () => {
    rpc.mockResolvedValueOnce({ status: 'unavailable', reason: 'That file is no longer there.', name: 'sunrise.png' })
    await render(<GeneratedImage sessionId="s1" meta={generatedImageMeta({ ...ready, mediaId: 'gone-1' })!} />)
    expect(host.textContent).toContain('That file is no longer there.')
    expect(host.querySelector('img')).toBeNull()
    await act(async () => { root!.unmount() })
    root = createRoot(host)
    rpc.mockResolvedValueOnce(okReply)
    await render(<GeneratedImage sessionId="s1" meta={generatedImageMeta({ ...ready, mediaId: 'gone-1' })!} />)
    expect(host.querySelector('img')).not.toBeNull()
  })

  it('saves and shows in the folder by media id', async () => {
    rpc.mockResolvedValue(okReply)
    saveGeneratedImage.mockResolvedValue(true)
    await render(<GeneratedImage sessionId="s1" meta={generatedImageMeta({ ...ready, mediaId: 'act-1' })!} />)
    await act(async () => { button('Save as').click() })
    expect(saveGeneratedImage).toHaveBeenCalledWith('s1', 'act-1')
    expect(host.textContent).toContain('Saved')
    await act(async () => { button('Show in folder').click() })
    expect(rpc).toHaveBeenCalledWith('media.reveal', { sessionId: 's1', mediaId: 'act-1' })
  })

  it('says nothing when the save dialog is cancelled, and shows a failure', async () => {
    rpc.mockResolvedValue(okReply)
    saveGeneratedImage.mockResolvedValueOnce(false)
    await render(<GeneratedImage sessionId="s1" meta={generatedImageMeta({ ...ready, mediaId: 'cancel-1' })!} />)
    await act(async () => { button('Save as').click() })
    expect(host.querySelector('.generated-image-note')?.textContent).toBe('')
    saveGeneratedImage.mockRejectedValueOnce(new Error('The disk is full.'))
    await act(async () => { button('Save as').click() })
    expect(host.querySelector('.generated-image-note.error')?.textContent).toBe('The disk is full.')
  })

  it('copies a PNG, and a refused copy gets a plain sentence', async () => {
    rpc.mockResolvedValue(okReply)
    const write = vi.fn().mockRejectedValue(new Error("Failed to execute 'write' on 'Clipboard': Write permission denied."))
    vi.stubGlobal('ClipboardItem', class { constructor(public items: Record<string, unknown>) { void Object.values(items).map((item) => (item as Promise<unknown>).catch?.(() => undefined)) } })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } })
    await render(<GeneratedImage sessionId="s1" meta={generatedImageMeta({ ...ready, mediaId: 'copy-1' })!} />)
    await act(async () => { button('Copy').click() })
    expect(Object.keys((write.mock.calls[0]![0] as { items: object }[])[0]!.items)).toEqual(['image/png'])
    expect(host.querySelector('.generated-image-note.error')?.textContent).toBe('This image could not be copied.')
    vi.unstubAllGlobals()
  })

  it('the companion thumbnail has no actions or caption', async () => {
    rpc.mockResolvedValue(okReply)
    await render(<GeneratedImage compact sessionId="s1" meta={generatedImageMeta({ ...ready, mediaId: 'small-1' })!} />)
    expect(host.querySelector('img')).not.toBeNull()
    expect(host.querySelector('.generated-image-actions')).toBeNull()
    expect(host.querySelector('figcaption')).toBeNull()
  })

  it('a phone never asks for the file, and says where to see it', async () => {
    bridge.inDesktop = false
    await render(<GeneratedImage sessionId="s1" meta={generatedImageMeta({ ...ready, mediaId: 'phone-1' })!} />)
    expect(rpc).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Open Bitbots on your computer to see this image.')
  })
})
