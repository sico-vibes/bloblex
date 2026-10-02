import { describe, expect, it } from 'vitest'
import {
  UPDATE_ERROR_MESSAGES, UPDATE_FAILED_MESSAGE, countInstallAffectedSessions, describeUpdateProgress, displayUpdateFailure,
  formatByteCount, formatUpdateTimestamp, installImpactCopy, parseUpdateCheck, parseUpdateProgress, parseUpdatesState, safeUpdateFailureMessage,
  updateErrorMessage,
} from './updatesContract'

const secret = 'SECRET_RAW_STACK'

describe('updates normalisers', () => {
  it('drops unknown fields and fills absent values', () => {
    const state = parseUpdatesState({
      currentVersion: '0.1.0', token: secret, nested: { password: secret }, extra: true,
    })
    expect(state).toEqual({
      currentVersion: '0.1.0', channel: 'beta', autoCheck: true, lastCheckedAt: null, available: null, devBuild: false,
    })
    expect(JSON.stringify(state)).not.toContain(secret)
    expect(parseUpdatesState(null)).toBeNull()
    expect(parseUpdatesState([])).toBeNull()
    expect(parseUpdatesState('beta')).toBeNull()
  })

  it('keeps null notes, dates, and totals without inventing them', () => {
    const state = parseUpdatesState({
      currentVersion: '', channel: 'nope', autoCheck: 'yes', lastCheckedAt: null, devBuild: 'true',
      available: { version: ' 0.2.0 ', notes: null, pubDate: null, channel: 'stable', url: secret },
    })
    expect(state).toEqual({
      currentVersion: '',
      channel: 'beta',
      autoCheck: true,
      lastCheckedAt: null,
      devBuild: false,
      available: { version: '0.2.0', notes: null, pubDate: null, channel: 'stable' },
    })
    expect(JSON.stringify(state)).not.toContain(secret)
    expect(parseUpdatesState({ lastCheckedAt: '   ', available: null, devBuild: false })?.lastCheckedAt).toBeNull()
    expect(parseUpdatesState({ devBuild: true })?.devBuild).toBe(true)
  })

  it('maps only the fixed error strings and never returns raw text', () => {
    expect(updateErrorMessage('network')).toBe(UPDATE_ERROR_MESSAGES.network)
    expect(updateErrorMessage('signature')).toBe(UPDATE_ERROR_MESSAGES.signature)
    expect(updateErrorMessage('manifest')).toBe(UPDATE_ERROR_MESSAGES.manifest)
    expect(updateErrorMessage('unavailable')).toBe(UPDATE_ERROR_MESSAGES.unavailable)
    expect(updateErrorMessage('no_update')).toBe(UPDATE_ERROR_MESSAGES.no_update)
    expect(updateErrorMessage(`panic ${secret}`)).toBe(UPDATE_FAILED_MESSAGE)
    expect(updateErrorMessage(null)).toBe(UPDATE_FAILED_MESSAGE)
    expect(updateErrorMessage({ message: secret })).toBe(UPDATE_FAILED_MESSAGE)
    expect(safeUpdateFailureMessage({ code: 'network', message: `ENOTFOUND ${secret}` })).toBe(UPDATE_ERROR_MESSAGES.network)
    expect(safeUpdateFailureMessage({ code: 'network', message: `ENOTFOUND ${secret}` })).not.toContain(secret)
    expect(safeUpdateFailureMessage(new Error(`read ${secret}`))).toBe(UPDATE_FAILED_MESSAGE)
    expect(displayUpdateFailure(new Error(UPDATE_ERROR_MESSAGES.manifest))).toBe(UPDATE_ERROR_MESSAGES.manifest)
    expect(displayUpdateFailure(new Error(`trace ${secret}`))).toBe(UPDATE_FAILED_MESSAGE)
    expect(displayUpdateFailure({ error: 'no_update', message: secret })).toBe(UPDATE_ERROR_MESSAGES.no_update)
    expect(displayUpdateFailure({ error: 'no_update', message: secret })).not.toContain(secret)
  })

  it('parses check results and progress, including absent totals', () => {
    expect(parseUpdateCheck(null)).toBeNull()
    expect(parseUpdateCheck({ status: 'mystery', checkedAt: '2026-10-02T00:00:00.000Z' })).toBeNull()
    const failed = parseUpdateCheck({ status: 'error', checkedAt: '2026-10-02T00:00:00.000Z', error: `io ${secret}`, message: secret, update: null })
    expect(failed).toEqual({ status: 'error', checkedAt: '2026-10-02T00:00:00.000Z' })
    expect(JSON.stringify(failed)).not.toContain(secret)
    expect(parseUpdateCheck({ status: 'no_stable_release', checkedAt: null, log: secret })).toEqual({ status: 'no_stable_release', checkedAt: '' })
    expect(parseUpdateCheck({
      status: 'available', checkedAt: '2026-10-02T00:00:00.000Z',
      update: { version: '0.2.0', notes: null, pubDate: null, channel: 'beta' },
      message: secret,
    })).toEqual({
      status: 'available', checkedAt: '2026-10-02T00:00:00.000Z',
      update: { version: '0.2.0', notes: null, pubDate: null, channel: 'beta' },
    })
    expect(parseUpdateProgress(null)).toBeNull()
    expect(parseUpdateProgress({ phase: 'extracting', downloadedBytes: 1, totalBytes: 2 })).toBeNull()
    expect(parseUpdateProgress({ phase: 'downloading', downloadedBytes: -4, totalBytes: 0, token: secret })).toEqual({
      phase: 'downloading', downloadedBytes: 0, totalBytes: null,
    })
    expect(parseUpdateProgress({ phase: 'installing', downloadedBytes: 8, totalBytes: null })).toEqual({
      phase: 'installing', downloadedBytes: 8, totalBytes: null,
    })
    expect(JSON.stringify(parseUpdateProgress({ phase: 'downloading', downloadedBytes: 1, totalBytes: null, token: secret }))).not.toContain(secret)
  })

  it('describes bytes, percent, install impact, and timestamps', () => {
    expect(formatByteCount(512)).toBe('512 B')
    expect(describeUpdateProgress({ phase: 'downloading', downloadedBytes: 512, totalBytes: 2048 })).toEqual({
      label: 'Downloaded 512 B of 2.0 KB (25%).', percent: 25,
    })
    expect(describeUpdateProgress({ phase: 'downloading', downloadedBytes: 512, totalBytes: null })).toEqual({
      label: 'Downloaded 512 B.', percent: null,
    })
    expect(describeUpdateProgress({ phase: 'installing', downloadedBytes: 2048, totalBytes: 2048 }).label).toBe('Installing. Bloblex will restart.')
    expect(formatUpdateTimestamp(null)).toBeNull()
    expect(formatUpdateTimestamp('not-a-date')).toBeNull()
    expect(formatUpdateTimestamp('2026-10-01T15:04:00.000Z')).toContain('2026')
    expect(installImpactCopy(1)).toBe('1 session is running or waiting for approval. They will end when Bloblex restarts.')
    expect(installImpactCopy(2)).toBe('2 sessions are running or waiting for approval. They will end when Bloblex restarts.')
    expect(countInstallAffectedSessions([
      { id: 'run', state: 'working' },
      { id: 'wait', state: 'waiting_permission' },
      { id: 'idle', state: 'idle' },
    ], [{ sessionId: 'run', status: 'pending' }, { sessionId: 'idle', status: 'pending' }, { sessionId: 'done', status: 'denied' }])).toBe(3)
    expect(countInstallAffectedSessions([{ id: 'idle', state: 'completed' }], [])).toBe(0)
  })
})
