import { describe, expect, it } from 'vitest'
import { advanceDropZone, dropChips, dropZoneActive } from './companionDrop'

describe('advanceDropZone', () => {
  it('opens once and stays over while the drag is on the island', () => {
    expect(advanceDropZone('idle', 'enter')).toBe('over')
    expect(advanceDropZone('over', 'enter')).toBe('over')
    expect(advanceDropZone('over', 'leave')).toBe('pending')
  })

  it('re-entering within the grace period returns to over, never idle', () => {
    expect(advanceDropZone('pending', 'enter')).toBe('over')
    let phase = advanceDropZone('idle', 'enter')
    phase = advanceDropZone(phase, 'leave')
    phase = advanceDropZone(phase, 'enter')
    phase = advanceDropZone(phase, 'leave')
    expect(phase).toBe('pending')
  })

  it('a drop always ends at idle', () => {
    expect(advanceDropZone('over', 'drop')).toBe('idle')
    expect(advanceDropZone('pending', 'drop')).toBe('idle')
  })

  it('an idle zone ignores a stray leave', () => {
    expect(advanceDropZone('idle', 'leave')).toBe('idle')
  })

  it('the card is visible except when idle', () => {
    expect(dropZoneActive('idle')).toBe(false)
    expect(dropZoneActive('over')).toBe(true)
    expect(dropZoneActive('pending')).toBe(true)
  })
})

describe('dropChips', () => {
  it('splits a Windows path into name, type and size', () => {
    expect(dropChips('C:\\work\\site\\report.PDF', 2048)).toEqual({ name: 'report.PDF', type: 'PDF', size: '2.0 KB' })
    expect(dropChips('/home/me/notes.md', 512)).toEqual({ name: 'notes.md', type: 'MD', size: '512 B' })
  })

  it('falls back for a missing extension or size', () => {
    expect(dropChips('C:\\work\\LICENSE', null)).toEqual({ name: 'LICENSE', type: 'File', size: '—' })
    expect(dropChips('C:\\work\\big.zip', 5 * 1024 * 1024)).toEqual({ name: 'big.zip', type: 'ZIP', size: '5.0 MB' })
  })
})
