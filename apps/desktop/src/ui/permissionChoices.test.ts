import { describe, expect, it } from 'vitest'
import { isNegativePermissionChoice } from './permissionChoices'

describe('permission choice styling', () => {
  it('keeps opaque provider options neutral and preserves their IDs', () => {
    const choices = ['RejectOnce', 'DENY', 'allow_once', 'reject_custom_opaque_code']
    expect(choices.map(isNegativePermissionChoice)).toEqual([false, false, false, false])
    expect(choices).toEqual(['RejectOnce', 'DENY', 'allow_once', 'reject_custom_opaque_code'])
  })
})
