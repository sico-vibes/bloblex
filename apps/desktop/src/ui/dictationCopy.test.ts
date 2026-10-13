import { describe, expect, it } from 'vitest'
import { friendlyDictationError } from './dictation'

describe('friendlyDictationError', () => {
  it('explains the bot check in plain words and says what to do next', () => {
    const text = friendlyDictationError('ChatGPT transcription is unavailable (verification required) and no on-device model is installed.')
    expect(text).toContain("OpenAI's bot check blocked it")
    expect(text).toContain('Settings, Speech')
    expect(text).not.toContain('verification required')
  })

  it('maps the challenged wording and the fallback-failed wording', () => {
    expect(friendlyDictationError('OpenAI blocks transcription from apps that are not its own clients, and no on-device model is installed. Use the on-device model or dictate inside the ChatGPT app.')).toContain('third-party apps')
    expect(friendlyDictationError('ChatGPT transcription failed (rate limited), and the on-device model could not run.')).toContain('rate limiting')
  })

  it('leaves other messages alone', () => {
    expect(friendlyDictationError('The microphone is busy.')).toBe('The microphone is busy.')
  })
})
