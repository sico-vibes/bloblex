// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RECENT_FOLDER_LIMIT, recentFolders, rememberFolder } from './folderRecents'

describe('recent folders', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { localStorage.clear() })

  it('remembers a folder once, newest first', () => {
    rememberFolder('C:/one')
    rememberFolder('C:/two')
    rememberFolder('C:/one')
    expect(recentFolders()).toEqual(['C:/one', 'C:/two'])
  })

  it('keeps at most six folders', () => {
    for (const path of ['1', '2', '3', '4', '5', '6', '7']) rememberFolder(`C:/${path}`)
    expect(recentFolders()).toHaveLength(RECENT_FOLDER_LIMIT)
    expect(recentFolders()[0]).toBe('C:/7')
    expect(recentFolders()).not.toContain('C:/1')
  })

  it('ignores empty or whitespace paths and trims real ones', () => {
    rememberFolder('')
    rememberFolder('   ')
    rememberFolder('  C:/work  ')
    expect(recentFolders()).toEqual(['C:/work'])
  })

  it('drops non-string and empty stored entries', () => {
    localStorage.setItem('bitbots.recentFolders', JSON.stringify(['C:/ok', 7, '', '  ', null, 'C:/next']))
    expect(recentFolders()).toEqual(['C:/ok', 'C:/next'])
    localStorage.setItem('bitbots.recentFolders', 'not json')
    expect(recentFolders()).toEqual([])
  })
})
