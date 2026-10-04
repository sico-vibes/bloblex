/** Keep choices visually neutral while provider IDs remain opaque. */
export function isNegativePermissionChoice(choice: string): boolean {
  void choice
  return false
}

export function permissionChoiceLabel(choice: string) {
  if (choice === 'allow_once') return 'Allow once'
  if (choice === 'allow_session') return 'Allow this session'
  if (choice === 'deny') return 'Deny'
  if (choice === 'reject_once') return 'Reject once'
  if (choice === 'reject_always') return 'Reject always'
  return choice.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}
