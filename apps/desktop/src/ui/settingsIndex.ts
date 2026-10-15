// What the Settings search can find. Each entry points at a page and at the
// group heading on that page, which the sheet scrolls to and flashes. Keep the
// `group` strings equal to the `SettingsGroup title` values in SettingsSheet.

export type SettingsPageName = 'General' | 'Appearance' | 'Remote' | 'Agents' | 'Memory' | 'Speech' | 'Updates'

export interface SettingsIndexEntry {
  page: SettingsPageName
  group: string
  label: string
  /** Extra words people might type. */
  keywords: string
}

export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  { page: 'General', group: 'System', label: 'Run setup again', keywords: 'welcome onboarding first run' },
  { page: 'General', group: 'System', label: 'Start with Windows', keywords: 'startup login autostart boot' },
  { page: 'General', group: 'System', label: 'Close to tray', keywords: 'minimise background quit exit' },
  { page: 'General', group: 'System', label: 'Companion display', keywords: 'monitor screen' },
  { page: 'General', group: 'Companion', label: 'Open the companion at startup', keywords: 'floating avatar desktop' },
  { page: 'General', group: 'Companion', label: 'Companion start position', keywords: 'place corner bottom centre' },
  { page: 'General', group: 'Companion', label: 'Show or hide shortcut', keywords: 'hotkey keyboard ctrl alt' },
  { page: 'General', group: 'Companion', label: 'Sounds and volume', keywords: 'audio cues mute quiet' },
  { page: 'Appearance', group: 'Look and colour', label: 'Look', keywords: 'bitbots blobots theme style robots blobs' },
  { page: 'Appearance', group: 'Look and colour', label: 'Accent colour', keywords: 'color highlight primary brand' },
  { page: 'Appearance', group: 'Display', label: 'Theme', keywords: 'dark light system mode' },
  { page: 'Appearance', group: 'Display', label: 'Text size', keywords: 'font larger smaller zoom' },
  { page: 'Appearance', group: 'Display', label: 'Density', keywords: 'compact roomy spacing rows' },
  { page: 'Remote', group: 'Remote access', label: 'Allow remote devices', keywords: 'phone browser pwa relay outside away mobile android iphone' },
  { page: 'Remote', group: 'Add a device', label: 'Pair a device', keywords: 'qr code scan phone tablet connect' },
  { page: 'Remote', group: 'Devices', label: 'Devices', keywords: 'paired phones tablets browsers list remove revoke tier' },
  { page: 'Remote', group: 'Safety', label: 'Approve requests from remote devices', keywords: 'permission approval remote security' },
  { page: 'Remote', group: 'Recent activity', label: 'Recent activity', keywords: 'log connections pairings approvals denied history' },
  { page: 'General', group: 'Editor', label: 'Editor executable', keywords: 'open files vscode notepad' },
  { page: 'General', group: 'Experimental', label: 'Claude dynamic workflows and Ultracode', keywords: 'effort claude workflow' },
  { page: 'General', group: 'Experimental', label: 'Usage tips', keywords: 'quota limit notice' },
  { page: 'General', group: 'Power', label: 'Keep this computer awake', keywords: 'sleep power idle' },
  { page: 'General', group: 'Notifications', label: 'Notifications', keywords: 'alerts toast approval' },
  { page: 'Agents', group: 'Approvals', label: 'Default approval mode', keywords: 'permissions ask auto bypass' },
  { page: 'Agents', group: 'Coding agents', label: 'Coding agents', keywords: 'claude codex opencode runtime scan sign in' },
  { page: 'Agents', group: 'Custom launchers', label: 'Custom launchers', keywords: 'profile command arguments' },
  { page: 'Memory', group: 'Memory', label: 'Memory', keywords: 'remember notes shared' },
  { page: 'Speech', group: 'Dictation', label: 'Dictation', keywords: 'microphone voice talk' },
  { page: 'Speech', group: 'Transcription engine', label: 'Transcription engine', keywords: 'cloud on device local' },
  { page: 'Speech', group: 'Speech model', label: 'Speech model', keywords: 'download size language' },
  { page: 'Updates', group: 'About', label: 'Updates and version', keywords: 'release check upgrade about' },
]

/** Case-insensitive, every word must match the label, group or keywords; label hits rank first. */
export function searchSettings(query: string, entries: readonly SettingsIndexEntry[] = SETTINGS_INDEX, limit = 8): SettingsIndexEntry[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const scored = entries.flatMap((entry, index) => {
    const label = entry.label.toLocaleLowerCase()
    const rest = `${entry.group} ${entry.page} ${entry.keywords}`.toLocaleLowerCase()
    if (!words.every((word) => label.includes(word) || rest.includes(word))) return []
    const labelHits = words.filter((word) => label.includes(word)).length
    const startsLabel = label.startsWith(words[0]!) ? 0 : 1
    return [{ entry, index, score: (words.length - labelHits) * 2 + startsLabel }]
  })
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).slice(0, limit).map(({ entry }) => entry)
}
