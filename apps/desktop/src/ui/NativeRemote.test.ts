import { describe, expect, it } from 'vitest'
import { accountProblem } from './NativeRemote'

describe('native remote sign-in rules', () => {
  it('asks for a username, a long enough password that is not the username, typed twice', () => {
    expect(accountProblem('', 'x'.repeat(12), 'x'.repeat(12))).toBe('Choose a username.')
    expect(accountProblem('basem', 'short', 'short')).toContain('at least 12')
    expect(accountProblem('basem-is-long', 'basem-is-long', 'basem-is-long')).toBe('The password can’t be the username.')
    expect(accountProblem('basem', 'correct horse battery', 'correct horse batterz')).toBe('The two passwords don’t match.')
    expect(accountProblem('basem', 'correct horse battery', 'correct horse battery')).toBeNull()
  })
})
