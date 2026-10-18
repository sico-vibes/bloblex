// Slash commands in the composer (FIX37 G4). Typing `/` at the start of the
// composer, or after a space, opens a menu of three groups:
//   - Actions the app performs itself (no message is sent);
//   - Skills from the shared pool that are enabled for this bot;
//   - Manager commands, only when the conversation's bot is the Manager.
// Picking a skill or Manager command attaches it to the message; the message is
// stored and shown exactly as typed (`/name` plus whatever follows).

export type SlashGroup = 'Actions' | 'Skills' | 'Manager'
export type SlashKind = 'action' | 'skill' | 'manager'

/** Actions the app performs itself; no message is sent. */
export type SlashActionId = 'plan' | 'new' | 'model' | 'effort' | 'rename' | 'export' | 'help'

export interface SlashItem {
  kind: SlashKind
  /** The name without the leading slash. */
  name: string
  group: SlashGroup
  description: string
  /** A keyboard hint shown on the right, when one exists. */
  shortcut?: string
  /** Set for `kind: 'action'`. */
  action?: SlashActionId
}

/** A skill the pool has switched on for this bot. */
export interface SlashSkill {
  name: string
  description: string
}

/** A command attached to the message being composed. */
export interface SlashCommand {
  kind: 'skill' | 'manager'
  name: string
}

export const SLASH_ACTIONS: readonly SlashItem[] = [
  { kind: 'action', name: 'plan', group: 'Actions', description: 'Turn plan mode on or off for this conversation', action: 'plan' },
  { kind: 'action', name: 'new', group: 'Actions', description: 'Start a new conversation with this bot', action: 'new' },
  { kind: 'action', name: 'model', group: 'Actions', description: 'Choose the model for this conversation', action: 'model' },
  { kind: 'action', name: 'effort', group: 'Actions', description: 'Choose the effort level for this conversation', action: 'effort' },
  { kind: 'action', name: 'rename', group: 'Actions', description: 'Rename this conversation', action: 'rename' },
  { kind: 'action', name: 'export', group: 'Actions', description: 'Export this conversation as Markdown', action: 'export' },
  { kind: 'action', name: 'help', group: 'Actions', description: 'Show every command', action: 'help' },
]

export const MANAGER_SLASH_COMMANDS: readonly SlashItem[] = [
  { kind: 'manager', name: 'interview', group: 'Manager', description: 'Run or continue the personalisation interview' },
  { kind: 'manager', name: 'onboard', group: 'Manager', description: 'Onboard a project and propose a team' },
  { kind: 'manager', name: 'team', group: 'Manager', description: 'Propose a team of bots for a project' },
  { kind: 'manager', name: 'status', group: 'Manager', description: "Summarise every project's state and open work" },
  { kind: 'manager', name: 'playbook', group: 'Manager', description: 'Review its own playbook and propose improvements' },
  { kind: 'manager', name: 'remember', group: 'Manager', description: 'Save what follows as a fact about you' },
]

/** The `/query` being typed at the caret, at the start or after a space. */
export function slashQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const match = /(^|\s)\/([\p{L}\p{N}_-]{0,40})$/u.exec(before)
  if (!match) return null
  const query = match[2]
  return { start: before.length - query.length - 1, query }
}

/** The menu rows for a query: this bot's actions, skills, then Manager commands. */
export function slashItems(query: string, options: { skills?: readonly SlashSkill[]; isManager?: boolean; actions?: readonly SlashItem[] } = {}): SlashItem[] {
  const needle = query.trim().toLowerCase()
  const skills: SlashItem[] = (options.skills ?? []).map((skill) => ({
    kind: 'skill', name: skill.name, group: 'Skills', description: skill.description,
  }))
  const manager = options.isManager ? MANAGER_SLASH_COMMANDS : []
  return [...(options.actions ?? SLASH_ACTIONS), ...skills, ...manager]
    .filter((item) => !needle || `${item.name} ${item.description}`.toLowerCase().includes(needle))
    .slice(0, 40)
}

/** The actions the compact companion composer offers; the rest are main-window only. */
export const COMPANION_SLASH_ACTIONS: readonly SlashItem[] = SLASH_ACTIONS.filter((item) => item.action === 'new' || item.action === 'model' || item.action === 'effort')

/**
 * A message that begins with a known skill or Manager command, as typed by hand
 * (for example `/code-review check the parser`). Returns the command to send, or
 * null when the leading `/word` is not one this bot may use.
 */
export function leadingCommand(text: string, options: { skills?: readonly SlashSkill[]; isManager?: boolean } = {}): SlashCommand | null {
  const match = /^\/([a-z0-9][a-z0-9-]{0,63})(?:\s|$)/i.exec(text)
  if (!match) return null
  const name = match[1].toLowerCase()
  if ((options.skills ?? []).some((skill) => skill.name === name)) return { kind: 'skill', name }
  if (options.isManager && MANAGER_SLASH_COMMANDS.some((item) => item.name === name)) return { kind: 'manager', name }
  return null
}

/** The message shown and stored for a command plus the typed remainder. */
export function commandMessage(command: SlashCommand, remainder: string): string {
  const rest = remainder.trim()
  return rest ? `/${command.name} ${rest}` : `/${command.name}`
}

// ---------------------------------------------------------------------------
// Opening the existing composer controls from an action

export type ExecutionPickerKind = 'model' | 'effort'

/** The window event `SessionExecutionControls` listens for to open a picker. */
export const EXECUTION_PICKER_EVENT = 'bloblex:exec-picker'

export function requestExecutionPicker(kind: ExecutionPickerKind) {
  window.dispatchEvent(new CustomEvent(EXECUTION_PICKER_EVENT, { detail: kind }))
}
