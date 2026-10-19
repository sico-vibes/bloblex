// What the Settings search can find. Each entry points at a page and at the
// group heading on that page, which the sheet scrolls to and flashes. Keep the
// `group` strings equal to the `SettingsGroup title` values in SettingsSheet.

export type SettingsPageName = 'General' | 'Appearance' | 'Experimental' | 'Remote' | 'Agents' | 'Manager' | 'Memory' | 'Skills' | 'Speech' | 'Backup' | 'Updates'

/** The page list, for anything that has to validate an incoming page name. */
export const SETTINGS_PAGE_NAMES: readonly SettingsPageName[] = ['General', 'Appearance', 'Experimental', 'Remote', 'Agents', 'Manager', 'Memory', 'Skills', 'Speech', 'Backup', 'Updates']

/**
 * The page out of an open-settings event payload (C13): a known page name, or
 * null when the payload carries none, so an unknown or absent value just opens
 * the sheet on its current page.
 */
export function settingsPageFromEvent(payload: unknown): SettingsPageName | null {
  return typeof payload === 'string' && (SETTINGS_PAGE_NAMES as readonly string[]).includes(payload) ? payload as SettingsPageName : null
}

export interface SettingsIndexEntry {
  page: SettingsPageName
  group: string
  label: string
  /** Extra words people might type. */
  keywords: string
}

export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  { page: 'General', group: 'System', label: 'When you send while a bot is working', keywords: 'steer queue message enter keyboard busy send' },
  { page: 'General', group: 'System', label: 'Run setup again', keywords: 'welcome onboarding first run' },
  { page: 'General', group: 'System', label: 'Start with Windows', keywords: 'startup login autostart boot' },
  { page: 'General', group: 'System', label: 'Close to tray', keywords: 'minimise background quit exit' },
  { page: 'General', group: 'System', label: 'Companion display', keywords: 'monitor screen' },
  { page: 'General', group: 'Companion', label: 'Open the companion at startup', keywords: 'floating avatar desktop' },
  { page: 'General', group: 'Companion', label: 'Companion start position', keywords: 'place corner bottom centre' },
  { page: 'General', group: 'Companion', label: 'Show or hide shortcut', keywords: 'hotkey keyboard ctrl alt' },
  { page: 'General', group: 'Companion', label: 'Sounds and volume', keywords: 'audio cues mute quiet' },
  { page: 'General', group: 'Companion', label: 'Focus mode', keywords: 'quiet peek interrupt concentrate' },
  { page: 'General', group: 'Companion', label: 'Reset companion position', keywords: 'move place edge corner screen' },
  { page: 'General', group: 'Support', label: 'Export diagnostics', keywords: 'logs report problem support zip upload debug' },
  { page: 'Appearance', group: 'Look', label: 'Look', keywords: 'bitbots blobots legacy pop dot frost wallpaper glass font style robots blobs' },
  { page: 'Appearance', group: 'Look', label: 'More looks', keywords: 'legacy pop dot alternate alternative' },
  { page: 'Appearance', group: 'Look options', label: 'Wallpaper', keywords: 'lake dusk bloom sand custom image background' },
  { page: 'Appearance', group: 'Look options', label: 'Glass', keywords: 'solid balanced clear transparency blur' },
  { page: 'Appearance', group: 'Colour', label: 'Accent', keywords: 'color highlight primary brand' },
  { page: 'Appearance', group: 'Display', label: 'Theme', keywords: 'dark light system mode' },
  { page: 'Appearance', group: 'Text', label: 'Interface font', keywords: 'font typeface sans pixel display' },
  { page: 'Appearance', group: 'Text', label: 'Code font', keywords: 'mono monospace font editor code' },
  { page: 'Appearance', group: 'Display', label: 'Text size', keywords: 'larger smaller zoom' },
  { page: 'Appearance', group: 'Display', label: 'Density', keywords: 'compact roomy spacing rows' },
  { page: 'Remote', group: 'Remote access', label: 'Allow remote devices', keywords: 'phone browser pwa relay outside away mobile android iphone' },
  { page: 'Remote', group: 'Add a device', label: 'Pair a device', keywords: 'qr code scan phone tablet connect' },
  { page: 'Remote', group: 'Devices', label: 'Devices', keywords: 'paired phones tablets browsers list remove revoke tier' },
  { page: 'Remote', group: 'Safety', label: 'Approve requests from remote devices', keywords: 'permission approval remote security' },
  { page: 'Remote', group: 'Recent activity', label: 'Recent activity', keywords: 'log connections pairings approvals denied history' },
  { page: 'General', group: 'Editor', label: 'Editor executable', keywords: 'open files vscode notepad' },
  { page: 'Experimental', group: 'Experimental', label: 'Claude dynamic workflows and Ultracode', keywords: 'effort claude workflow ultracode' },
  { page: 'Experimental', group: 'Experimental', label: 'Usage tips', keywords: 'quota limit notice' },
  { page: 'Experimental', group: 'Experimental', label: 'Usage bar', keywords: 'quota plan limits bottom window' },
  { page: 'Experimental', group: 'Experimental', label: 'Runtime logos', keywords: 'claude codex opencode logo sidebar header' },
  { page: 'Experimental', group: 'Experimental', label: 'Agent activity', keywords: 'steps commands files diffs tools' },
  { page: 'Experimental', group: 'Experimental', label: 'Change review', keywords: 'diff keep revert files changed' },
  { page: 'Experimental', group: 'Experimental', label: 'Message actions', keywords: 'react reply copy message' },
  { page: 'Experimental', group: 'Experimental', label: 'Search all conversations', keywords: 'find messages history' },
  { page: 'Experimental', group: 'Experimental', label: 'Automatic titles', keywords: 'name conversation first prompt' },
  { page: 'Experimental', group: 'Experimental', label: 'Undo', keywords: 'archive delete eight seconds restore' },
  { page: 'Experimental', group: 'Experimental', label: 'Shortcut sheet', keywords: 'keyboard shortcuts ctrl slash' },
  { page: 'Experimental', group: 'Experimental', label: 'Automatic retry', keywords: 'overloaded rate limit continue' },
  { page: 'Experimental', group: 'Experimental', label: 'Memory', keywords: 'remember notes recall facts' },
  { page: 'Experimental', group: 'Experimental', label: 'Approval badge', keywords: 'taskbar tray windows waiting' },
  { page: 'Experimental', group: 'Experimental', label: 'Model and effort under the name', keywords: 'sidebar subtitle model effort' },
  { page: 'Experimental', group: 'Experimental', label: 'Lock a bot', keywords: 'lock unlock freeze settings badge' },
  { page: 'General', group: 'Work', label: 'Bots working at once', keywords: 'concurrency parallel limit queue waiting slots' },
  { page: 'General', group: 'Power', label: 'Keep this computer awake', keywords: 'sleep power idle' },
  { page: 'General', group: 'Notifications', label: 'Notifications', keywords: 'alerts toast approval' },
  { page: 'Agents', group: 'Approvals', label: 'Default approval mode', keywords: 'permissions ask auto bypass' },
  { page: 'Agents', group: 'Coding agents', label: 'Coding agents', keywords: 'claude codex opencode runtime scan sign in' },
  { page: 'Agents', group: 'Custom launchers', label: 'Custom launchers', keywords: 'profile command arguments' },
  { page: 'Manager', group: 'Manager', label: 'Manager', keywords: 'chief of staff model personality name look' },
  { page: 'Manager', group: 'What it knows about you', label: 'What the Manager knows', keywords: 'profile preferences facts lock learned' },
  { page: 'Manager', group: 'Playbook', label: 'Manager playbook', keywords: 'interview plan team guide history restore' },
  { page: 'Memory', group: 'Memory', label: 'Memory', keywords: 'remember notes shared' },
  { page: 'Skills', group: 'Skills', label: 'Skills', keywords: 'skill pool shared instructions scripts skill.md' },
  { page: 'Skills', group: 'Import skills', label: 'Import skills', keywords: 'claude codex opencode folder copy add' },
  { page: 'Backup', group: 'Export', label: 'Export a backup', keywords: 'save file bots memory skills automations settings' },
  { page: 'Backup', group: 'Restore', label: 'Restore a backup', keywords: 'import load file recover move computer' },
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
