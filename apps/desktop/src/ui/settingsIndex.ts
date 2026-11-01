// What the Settings search can find. Each entry points at a page and at the
// group heading on that page, which the sheet scrolls to and flashes. Keep the
// `group` strings equal to the `SettingsGroup title` values in SettingsSheet.

export type SettingsPageName = 'General' | 'Appearance' | 'Chat' | 'Speech' | 'Keyboard' | 'Companion' | 'Agents' | 'Accounts' | 'Manager' | 'Approvals' | 'Memory' | 'Skills' | 'Remote' | 'Machines' | 'Connections' | 'Secrets' | 'Updates' | 'Backup' | 'Health'

/** The page list, for anything that has to validate an incoming page name. */
export const SETTINGS_PAGE_NAMES: readonly SettingsPageName[] = ['General', 'Appearance', 'Chat', 'Speech', 'Keyboard', 'Companion', 'Agents', 'Accounts', 'Manager', 'Approvals', 'Memory', 'Skills', 'Remote', 'Machines', 'Connections', 'Secrets', 'Updates', 'Backup', 'Health']

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
  { page: 'General', group: 'Startup', label: 'Start with Windows', keywords: 'startup login autostart boot' },
  { page: 'General', group: 'Startup', label: 'Close to tray', keywords: 'minimise background quit exit' },
  { page: 'General', group: 'Notifications', label: 'Notifications', keywords: 'alerts toast approval' },
  { page: 'General', group: 'Notifications', label: 'Taskbar badge', keywords: 'taskbar tray windows waiting approval' },
  { page: 'General', group: 'Work', label: 'Bots working at once', keywords: 'concurrency parallel limit queue waiting slots' },
  { page: 'General', group: 'Work', label: 'Keep this computer awake', keywords: 'sleep power idle' },
  { page: 'General', group: 'Work', label: 'Resume after usage limits', keywords: 'quota reset continue limit' },
  { page: 'General', group: 'Work', label: 'Automatic retry', keywords: 'overloaded rate limit continue' },
  { page: 'General', group: 'Usage', label: 'Usage bar', keywords: 'quota plan limits bottom window' },
  { page: 'General', group: 'Usage', label: 'Usage tips', keywords: 'quota limit notice' },
  { page: 'General', group: 'Usage', label: 'Read sign-ins for usage', keywords: 'usage quota credentials claude opencode limits' },
  { page: 'General', group: 'Editor', label: 'Editor executable', keywords: 'open files vscode notepad' },
  { page: 'Appearance', group: 'Look', label: 'Look', keywords: 'haze stone blobots theme style robots characters logos font' },
  { page: 'Appearance', group: 'Colour', label: 'Accent', keywords: 'color highlight primary brand' },
  { page: 'Appearance', group: 'Colour', label: 'Theme', keywords: 'dark light system mode' },
  { page: 'Appearance', group: 'Chat background', label: 'Chat background', keywords: 'image picture wallpaper dither ascii halftone scanlines haze effect' },
  { page: 'Appearance', group: 'Text and spacing', label: 'Interface font', keywords: 'font typeface sans pixel display' },
  { page: 'Appearance', group: 'Text and spacing', label: 'Code font', keywords: 'mono monospace font editor code' },
  { page: 'Appearance', group: 'Text and spacing', label: 'Text size', keywords: 'larger smaller zoom' },
  { page: 'Appearance', group: 'Text and spacing', label: 'Density', keywords: 'compact roomy spacing rows' },
  { page: 'Appearance', group: 'Bot list', label: 'Coding agent logos', keywords: 'claude codex opencode logo sidebar header runtime' },
  { page: 'Appearance', group: 'Bot list', label: 'Model and effort under the name', keywords: 'sidebar subtitle model effort' },
  { page: 'Chat', group: 'Sending', label: 'Send a message with', keywords: 'enter ctrl shift send shortcut new line composer' },
  { page: 'Chat', group: 'Sending', label: 'When you send while a bot is working', keywords: 'steer queue message enter keyboard busy send' },
  { page: 'Chat', group: 'Sending', label: 'Steer a running Codex turn', keywords: 'steer codex running' },
  { page: 'Chat', group: 'Conversations', label: 'Agent activity', keywords: 'steps commands files diffs tools' },
  { page: 'Chat', group: 'Conversations', label: 'Message actions', keywords: 'react reply copy message' },
  { page: 'Chat', group: 'Conversations', label: 'Change review', keywords: 'diff keep revert files changed' },
  { page: 'Chat', group: 'Conversations', label: 'Automatic titles', keywords: 'name conversation first prompt' },
  { page: 'Chat', group: 'Conversations', label: 'Search all conversations', keywords: 'find messages history' },
  { page: 'Chat', group: 'Conversations', label: 'Undo', keywords: 'archive delete eight seconds restore' },
  { page: 'Speech', group: 'Microphone', label: 'Dictation', keywords: 'microphone voice talk' },
  { page: 'Speech', group: 'Microphone', label: 'Transcription engine', keywords: 'cloud on device local' },
  { page: 'Speech', group: 'Speech model', label: 'Speech model', keywords: 'download size language' },
  { page: 'Keyboard', group: 'Keyboard shortcuts', label: 'Shortcut list', keywords: 'keyboard shortcuts ctrl slash sheet' },
  { page: 'Keyboard', group: 'Keyboard shortcuts', label: 'Keyboard shortcuts', keywords: 'keybinding keys hotkey rebind quick switcher terminal' },
  { page: 'Companion', group: 'Window', label: 'Show companion', keywords: 'floating avatar desktop' },
  { page: 'Companion', group: 'Window', label: 'Open the companion at startup', keywords: 'floating avatar desktop' },
  { page: 'Companion', group: 'Window', label: 'Show or hide shortcut', keywords: 'hotkey keyboard ctrl alt' },
  { page: 'Companion', group: 'Position', label: 'Companion display', keywords: 'monitor screen' },
  { page: 'Companion', group: 'Position', label: 'Companion start position', keywords: 'place corner bottom centre' },
  { page: 'Companion', group: 'Position', label: 'Reset companion position', keywords: 'move place edge corner screen' },
  { page: 'Companion', group: 'Attention', label: 'Sounds and volume', keywords: 'audio cues mute quiet' },
  { page: 'Companion', group: 'Attention', label: 'Focus mode', keywords: 'quiet peek interrupt concentrate' },
  { page: 'Companion', group: 'Attention', label: 'Watch Claude Code outside Bitbots', keywords: 'terminal hooks outside sessions editor cli' },
  { page: 'Agents', group: 'Installed', label: 'Coding agents', keywords: 'claude codex opencode runtime scan sign in' },
  { page: 'Agents', group: 'Claude Code', label: 'Dynamic workflows and Ultracode', keywords: 'effort claude workflow ultracode' },
  { page: 'Agents', group: 'Custom launchers', label: 'Custom launchers', keywords: 'profile command arguments' },
  { page: 'Accounts', group: 'Accounts', label: 'Add an account', keywords: 'sign in login several second work personal claude codex opencode' },
  { page: 'Accounts', group: 'Custom models', label: 'Custom models', keywords: 'model id effort catalog not listed' },
  { page: 'Manager', group: 'Profile', label: 'Manager', keywords: 'chief of staff model personality name look' },
  { page: 'Manager', group: 'Hand-offs', label: 'Pause new hand-offs', keywords: 'manager delegate assign teammate pause stop new work' },
  { page: 'Manager', group: 'What it knows about you', label: 'What the Manager knows', keywords: 'profile preferences facts lock learned' },
  { page: 'Manager', group: 'Playbook', label: 'Manager playbook', keywords: 'interview plan team guide history restore' },
  { page: 'Approvals', group: 'Defaults', label: 'Default approval mode', keywords: 'permissions ask auto bypass full access accept edits' },
  { page: 'Approvals', group: 'Defaults', label: 'Lock a bot', keywords: 'lock unlock freeze settings badge' },
  { page: 'Approvals', group: 'Always allowed', label: 'Always allowed', keywords: 'approvals permissions always allow rules remembered trust remove' },
  { page: 'Memory', group: 'Memory', label: 'Memory', keywords: 'remember notes shared recall facts' },
  { page: 'Skills', group: 'Skills', label: 'Skills', keywords: 'skill pool shared instructions scripts skill.md' },
  { page: 'Skills', group: 'Import skills', label: 'Import skills', keywords: 'claude codex opencode folder copy add' },
  { page: 'Remote', group: 'Turn on', label: 'Allow remote devices', keywords: 'phone browser pwa relay outside away mobile android iphone' },
  { page: 'Remote', group: 'Add a device', label: 'Pair a device', keywords: 'qr code scan phone tablet connect' },
  { page: 'Remote', group: 'Devices', label: 'Devices', keywords: 'paired phones tablets browsers list remove revoke tier' },
  { page: 'Remote', group: 'Safety', label: 'Approve requests from remote devices', keywords: 'permission approval remote security' },
  { page: 'Remote', group: 'Recent activity', label: 'Recent activity', keywords: 'log connections pairings approvals denied history' },
  { page: 'Machines', group: 'This machine', label: 'This machine\'s name', keywords: 'computer laptop rename' },
  { page: 'Machines', group: 'Other machines', label: 'Link a machine', keywords: 'computer laptop second pair take over handoff move' },
  { page: 'Connections', group: 'Access', label: 'Let outside sessions use Bitbots', keywords: 'mcp claude code connect terminal outside session external tools delegate' },
  { page: 'Connections', group: 'Access', label: 'Connect Claude Code', keywords: 'mcp command claude mcp add copy' },
  { page: 'Connections', group: 'Access', label: 'Reset access', keywords: 'mcp key token rotate revoke' },
  { page: 'Secrets', group: 'Saved', label: 'Secrets', keywords: 'environment token key credential manager password' },
  { page: 'Updates', group: 'Updates', label: 'Updates and version', keywords: 'release check upgrade about' },
  { page: 'Backup', group: 'Export', label: 'Export a backup', keywords: 'save file bots memory skills automations settings' },
  { page: 'Backup', group: 'Restore', label: 'Restore a backup', keywords: 'import load file recover move computer' },
  { page: 'Health', group: 'Health check', label: 'Health check', keywords: 'doctor diagnose repair fix broken sign in login database hook problems' },
  { page: 'Health', group: 'Support', label: 'Run setup again', keywords: 'welcome onboarding first run' },
  { page: 'Health', group: 'Support', label: 'Export diagnostics', keywords: 'logs report problem support zip upload debug' },
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
