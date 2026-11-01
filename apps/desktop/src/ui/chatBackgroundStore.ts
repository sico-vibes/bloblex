// The chat background, a Haze option that is off until an image is chosen. The image and its
// settings stay in this window's own storage: nothing goes to the daemon, a backup or a device.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { applyEffect, CHAT_BACKGROUND_EFFECTS, type ChatBackgroundEffect } from './chatBackgroundEffects'

export type ChatBackgroundScope = 'empty' | 'all'
export type ChatBackgroundPrefs = { hasImage: boolean; effect: ChatBackgroundEffect; scope: ChatBackgroundScope; emptyOpacity: number; sessionOpacity: number }

export const CHAT_BACKGROUND_OPACITY_MIN = 0.05
export const CHAT_BACKGROUND_OPACITY_MAX = 0.65
export const DEFAULT_CHAT_BACKGROUND: ChatBackgroundPrefs = { hasImage: false, effect: 'none', scope: 'all', emptyOpacity: 0.24, sessionOpacity: 0.24 }

const PREFS_KEY = 'bitbots.chatBackground'
const DB_NAME = 'bitbots-chat-background'
const STORE = 'images'
const IMAGE_KEY = 'current'
const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_SIDE = 2048

const clampOpacity = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(CHAT_BACKGROUND_OPACITY_MIN, Math.min(CHAT_BACKGROUND_OPACITY_MAX, value)) : fallback

/** A stored value, with anything unknown or out of range back at its default. */
export function normalizeChatBackgroundPrefs(value: unknown): ChatBackgroundPrefs {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    hasImage: raw.hasImage === true,
    effect: CHAT_BACKGROUND_EFFECTS.some((item) => item.value === raw.effect) ? raw.effect as ChatBackgroundEffect : DEFAULT_CHAT_BACKGROUND.effect,
    scope: raw.scope === 'empty' ? 'empty' : 'all',
    emptyOpacity: clampOpacity(raw.emptyOpacity, DEFAULT_CHAT_BACKGROUND.emptyOpacity),
    sessionOpacity: clampOpacity(raw.sessionOpacity, DEFAULT_CHAT_BACKGROUND.sessionOpacity),
  }
}

function readPrefs(): ChatBackgroundPrefs {
  try { return normalizeChatBackgroundPrefs(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')) } catch { return DEFAULT_CHAT_BACKGROUND }
}

let prefs = readPrefs()
let revision = 0
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export function updateChatBackgroundPrefs(change: Partial<ChatBackgroundPrefs>) {
  prefs = normalizeChatBackgroundPrefs({ ...prefs, ...change })
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* It lasts until the window closes. */ }
  notify()
}

export const useChatBackgroundPrefs = () => useSyncExternalStore(subscribe, () => prefs)

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE) }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('The image store could not be opened.'))
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('The image could not be saved.'))
    })
  } finally { db.close() }
}

async function decode(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, MAX_SIDE / bitmap.width, MAX_SIDE / bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas
}

const toBlob = (canvas: HTMLCanvasElement, type: string) => new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The image could not be prepared.')), type, 0.92))

/** Saves a picked image, scaled to at most 2048 px on its long side. Resolves to a sentence on failure. */
export async function chooseChatBackground(file: File): Promise<string | null> {
  if (!file.type.startsWith('image/')) return 'Choose an image file.'
  if (file.size > MAX_FILE_BYTES) return 'That image is over 25 MB.'
  try {
    const stored = await toBlob(await decode(file), 'image/webp')
    await withStore('readwrite', (store) => store.put(stored, IMAGE_KEY))
    revision += 1
    updateChatBackgroundPrefs({ hasImage: true })
    return null
  } catch { return 'That image could not be read.' }
}

export async function removeChatBackground() {
  await withStore('readwrite', (store) => store.delete(IMAGE_KEY))
  revision += 1
  updateChatBackgroundPrefs({ hasImage: false })
}

/** Browser preview only: a generated picture, so the inspector can show each effect. */
export async function seedChatBackgroundForPreview(effect: ChatBackgroundEffect) {
  const canvas = document.createElement('canvas')
  canvas.width = 1200
  canvas.height = 700
  const context = canvas.getContext('2d')
  if (!context) return
  const sky = context.createLinearGradient(0, 0, 0, 700)
  sky.addColorStop(0, '#2a3f7a'); sky.addColorStop(0.55, '#c9786a'); sky.addColorStop(1, '#f2c27a')
  context.fillStyle = sky
  context.fillRect(0, 0, 1200, 700)
  context.fillStyle = '#ffe6ad'
  context.beginPath(); context.arc(820, 300, 110, 0, Math.PI * 2); context.fill()
  await withStore('readwrite', (store) => toBlobStore(store, canvas)).catch(() => undefined)
  updateChatBackgroundPrefs({ hasImage: true, effect, scope: 'all', emptyOpacity: 0.5, sessionOpacity: 0.35 })
}
function toBlobStore(store: IDBObjectStore, canvas: HTMLCanvasElement): IDBRequest {
  // A data URL keeps this inside the store's one transaction, which a canvas callback would outlive.
  return store.put(dataUrlToBlob(canvas.toDataURL('image/png')), IMAGE_KEY)
}
function dataUrlToBlob(url: string) {
  const bytes = atob(url.slice(url.indexOf(',') + 1))
  return new Blob([Uint8Array.from(bytes, (char) => char.charCodeAt(0))], { type: 'image/png' })
}

/** Follows <html data-theme>, since two of the effects draw on the theme's paper colour. */
function useLightTheme() {
  const [light, setLight] = useState(() => document.documentElement.dataset.theme === 'light')
  useEffect(() => {
    const observer = new MutationObserver(() => setLight(document.documentElement.dataset.theme === 'light'))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return light
}

async function renderEffect(effect: ChatBackgroundEffect, light: boolean): Promise<string | null> {
  const stored = await withStore<Blob | undefined>('readonly', (store) => store.get(IMAGE_KEY) as IDBRequest<Blob | undefined>)
  if (!stored || !stored.size) return null
  if (effect === 'none' || effect === 'haze') return URL.createObjectURL(stored)
  const canvas = await decode(stored)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  const pixels = applyEffect({ width: canvas.width, height: canvas.height, data: image.data }, effect, light)
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), canvas.width, canvas.height), 0, 0)
  return URL.createObjectURL(await toBlob(canvas, 'image/png'))
}

/** The image with its effect applied, as a URL for a CSS background; null while there is none. */
export function useChatBackgroundUrl(enabled: boolean): string | null {
  const current = useChatBackgroundPrefs()
  const light = useLightTheme()
  const [url, setUrl] = useState<string | null>(null)
  const version = useSyncExternalStore(subscribe, () => revision)
  const wanted = enabled && current.hasImage
  useEffect(() => {
    if (!wanted) { setUrl(null); return }
    let live = true
    let made: string | null = null
    void renderEffect(current.effect, light).then((next) => {
      if (!live) { if (next) URL.revokeObjectURL(next); return }
      made = next
      setUrl(next)
    }).catch(() => { if (live) setUrl(null) })
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [wanted, current.effect, light, version])
  return url
}
