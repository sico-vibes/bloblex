// What's new: the release notes that ship with the app, newest first. It opens
// from the profile menu, and once by itself after the app is updated.
import { useState } from 'react'
import { X } from 'lucide-react'
import { appVersion } from '../appRelease'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
import { SafeMarkdown } from './SafeMarkdown'
import './whatsNew.css'

const NOTES = import.meta.glob('../../../../docs/releases/*.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
export const WHATS_NEW_SEEN_KEY = 'bitbots.whatsNew.seen'

export interface ReleaseNote { version: string; text: string }

/** "0.1.0-beta.30" → comparable parts; a plain version sorts after its betas. */
function versionKey(version: string): number[] {
  const [core, pre] = version.split('-')
  const parts = core.split('.').map((part) => Number(part) || 0)
  const beta = pre ? Number(pre.replace(/\D+/g, '')) || 0 : Number.MAX_SAFE_INTEGER
  return [...parts, beta]
}

export function compareVersions(a: string, b: string): number {
  const left = versionKey(a)
  const right = versionKey(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff) return diff
  }
  return 0
}

const BLOCK_START = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||```)/

/**
 * Release notes are wrapped at a fixed width. Join each wrapped line back onto
 * its paragraph or list item so the renderer sees whole sentences (and bold
 * text that spans a wrap).
 */
export function unwrapMarkdown(text: string): string {
  const out: string[] = []
  let fence = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fence = !fence; out.push(line); continue }
    const previous = out[out.length - 1]
    const continues = !fence && line.trim() !== '' && previous !== undefined && previous.trim() !== '' && !BLOCK_START.test(line) && !/^#{1,6}\s/.test(previous.trim()) && !/^\s*```/.test(previous)
    if (continues) out[out.length - 1] = `${previous.replace(/\s+$/, '')} ${line.trim()}`
    else out.push(line)
  }
  return out.join('\n')
}

/** Release notes keyed by version, newest first, without the note's own title line. */
export function releaseNotes(source: Record<string, string> = NOTES): ReleaseNote[] {
  return Object.entries(source)
    .map(([path, text]) => ({ version: path.split('/').pop()!.replace(/\.md$/, ''), text: unwrapMarkdown(text.replace(/^#\s[^\n]*\n+/, '').trim()) }))
    .filter((note) => /^\d+\.\d+\.\d+/.test(note.version))
    .sort((a, b) => compareVersions(b.version, a.version))
}

/** Open What's new by itself only when the app moved to a version it has a note for. */
export function shouldShowWhatsNew(seen: string | null, current: string, notes: readonly ReleaseNote[]): boolean {
  if (!current || !seen || seen === current) return false
  return notes.some((note) => note.version === current)
}

export function readSeenVersion(): string | null {
  try { return localStorage.getItem(WHATS_NEW_SEEN_KEY) } catch { return null }
}
export function markWhatsNewSeen(version: string = appVersion) {
  try { localStorage.setItem(WHATS_NEW_SEEN_KEY, version) } catch { /* preference only */ }
}

export function WhatsNewDialog({ onClose, onOpenLink, notes = releaseNotes() }: { onClose: () => void; onOpenLink: (url: string) => void; notes?: readonly ReleaseNote[] }) {
  const entered = useDialogEntered()
  const { ref, close } = useDialogAccessibility(onClose)
  const [shown, setShown] = useState(4)
  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog whats-new" role="dialog" aria-modal="true" aria-labelledby="whats-new-title" tabIndex={-1}>
      <header className="whats-new-head">
        <div>
          <h2 id="whats-new-title">What’s new</h2>
          {appVersion && <small>You have {appVersion}</small>}
        </div>
        <button type="button" className="queue-icon" aria-label="Close" data-dialog-initial-focus onClick={close}><X size={15} /></button>
      </header>
      <div className="whats-new-body">
        {notes.length === 0 && <p className="blob-muted">No release notes are bundled with this build.</p>}
        {notes.slice(0, shown).map((note) => <article key={note.version} className="whats-new-release">
          <h3>{note.version}{note.version === appVersion && <span className="whats-new-current">This version</span>}</h3>
          <div className="whats-new-text"><SafeMarkdown text={note.text} onOpenLink={onOpenLink} /></div>
        </article>)}
        {notes.length > shown && <button type="button" className="secondary-button small whats-new-more" onClick={() => setShown((count) => count + 6)}>Show older releases</button>}
      </div>
    </section>
  </div>
}
