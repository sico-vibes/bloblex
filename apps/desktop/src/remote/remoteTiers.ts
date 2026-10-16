// Remote mode policy: which daemon methods a paired device may call, at which
// tier, and what a remote client is allowed to see. This module is the
// executable specification of that policy: the future host gateway must call
// `authorizeRemoteCall` before every call and route every result and event
// through the redactors here before any value leaves the host. Nothing
// enforces the policy yet. `daemon_rpc` in `apps/desktop/src-tauri/src/lib.rs`
// is a pass-through and does not consult this table; the module described the
// policy being enforced is a P1 gateway job.
//
// The table is kept honest by `remoteTiers.parity.test.ts`, which reads the
// daemon's dispatch in `crates/bloblex-daemon/src/main.rs` and fails when a
// dispatched method has no rule here, or a rule has outlived its dispatch arm.
//
// See docs/remote/PROTOCOL.md (the docs table is produced by
// `renderTierTableMarkdown`, printed by scripts/print-remote-tiers.mjs).

import { tierAtLeast, type RemoteTier } from './remoteContract'

export type MethodClass = 'read' | 'chat' | 'approve' | 'never'

/** The wire code a gateway raises when `authorizeRemoteCall` denies a call. */
export type DenialCode = 'forbidden_remote' | 'tier_required' | 'approvals_disabled' | 'quiet_hours' | 'invalid_params'

/** A small validator for the params of one method (or one method family). */
export interface ParamRule {
  /** Plain sentence describing what the rule demands; shown in docs. */
  describe: string
  /** Returns a denial reason, or `null` when the params pass. */
  check(params: unknown): string | null
}

export interface MethodRule {
  /** A concrete method name, or a family wildcard such as `mcp.*`. */
  method: string
  class: MethodClass
  minTier: RemoteTier | null
  why: string
  params?: ParamRule
}

function ownKeys(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function attachmentsOf(params: unknown): unknown[] {
  const p = ownKeys(params)
  const attachments = p?.attachments
  return Array.isArray(attachments) ? attachments : []
}

/**
 * Attachments reach the host as staged uploads; a raw filesystem path is never
 * accepted from a device, because the host alone chooses what it reads.
 */
export const stagedAttachmentRule: ParamRule = {
  describe: 'attachments must be staged uploads ({ stagedId }), never a raw { path }',
  check(params) {
    for (const item of attachmentsOf(params)) {
      const attachment = ownKeys(item)
      if (!attachment) return 'attachments must be staged uploads, not raw values'
      if ('path' in attachment) return 'attachments must be staged uploads; a raw path is not accepted'
      if (typeof attachment.stagedId !== 'string' || attachment.stagedId.length === 0) return 'attachments must carry a stagedId'
    }
    return null
  },
}

/** A remote approval must name the request and one provider-supported choice. */
export const permissionReplyRule: ParamRule = {
  describe: 'requires permissionId and choice',
  check(params) {
    const p = ownKeys(params)
    if (!p) return 'permission.reply requires permissionId and choice'
    if (typeof p.permissionId !== 'string' || p.permissionId.length === 0) return 'permission.reply requires a permissionId'
    if (typeof p.choice !== 'string' || p.choice.length === 0) return 'permission.reply requires a choice'
    return null
  },
}

/**
 * A viewer device may read the model list but must not make the host poll the
 * provider: `refresh: true` bypasses the cache and re-queries upstream, which
 * costs the host network, rate limit and possibly money.
 */
export const runtimeModelsRule: ParamRule = {
  describe: 'refresh is not accepted from a device; the host alone may poll the provider',
  check(params) {
    const p = ownKeys(params)
    if (p && p.refresh === true) return 'a device may not make the host poll providers (refresh is not accepted)'
    return null
  },
}

const READ: RemoteTier = 'viewer'
const CHAT: RemoteTier = 'chat'
const OPERATOR: RemoteTier = 'operator'

/**
 * The allowlist, in table order: reads, then chat, then approvals, then the
 * methods remote may never call. `why` is one plain sentence per rule and is
 * used verbatim in the docs table.
 */
export const METHOD_RULES: readonly MethodRule[] = [
  // -- read (viewer and up) --------------------------------------------------
  { method: 'app.snapshot', class: 'read', minTier: READ, why: 'The authoritative state every remote view is built from; it is redacted before it leaves the host.' },
  { method: 'events.replay', class: 'read', minTier: READ, why: 'Replays retained events after a cursor so a reconnecting device can catch up.' },
  { method: 'daemon.health', class: 'read', minTier: READ, why: 'Daemon version, uptime and heartbeat; it carries no user data.' },
  { method: 'session.list', class: 'read', minTier: READ, why: 'Lists conversations so the device can show what is running.' },
  { method: 'session.get', class: 'read', minTier: READ, why: 'Reads one conversation and its history.' },
  { method: 'session.environment', class: 'read', minTier: READ, why: 'Shows where a conversation works.' },
  { method: 'runtime.list', class: 'read', minTier: READ, why: 'Lists the coding agents installed on the host.' },
  { method: 'runtime.capabilities', class: 'read', minTier: READ, why: 'Describes which execution settings a runtime supports.' },
  { method: 'runtime.models', class: 'read', minTier: READ, why: 'Lists the models a runtime offers so the device can show the choices.', params: runtimeModelsRule },
  { method: 'exec.snapshot.*', class: 'read', minTier: READ, why: 'Reads recorded execution snapshots, which already exclude instruction text and environment values.' },
  { method: 'usage.*', class: 'read', minTier: READ, why: 'Reads token and cost summaries.' },
  { method: 'quota.list', class: 'read', minTier: READ, why: 'Reads the provider quota windows the host has recorded.' },
  { method: 'search.messages', class: 'read', minTier: READ, why: 'Searches conversation text on the host.' },
  { method: 'memory.list', class: 'read', minTier: READ, why: 'Lists memory records the person can review.' },
  { method: 'memory.get', class: 'read', minTier: READ, why: 'Reads a single memory record for review.' },
  { method: 'automation.list', class: 'read', minTier: READ, why: 'Lists scheduled automations.' },
  { method: 'automation.get', class: 'read', minTier: READ, why: 'Reads one scheduled automation.' },
  { method: 'automation.runs', class: 'read', minTier: READ, why: 'Lists an automation run history.' },
  { method: 'automation.preview', class: 'read', minTier: READ, why: 'Previews the next run times of a schedule; it changes nothing.' },
  { method: 'agent.list', class: 'read', minTier: READ, why: 'Lists bots so a device can pick one.' },
  { method: 'agent.get', class: 'read', minTier: READ, why: 'Reads one bot\'s settings.' },
  { method: 'project.list', class: 'read', minTier: READ, why: 'Lists known projects so a device can pick one.' },
  { method: 'permissions.policy.get', class: 'read', minTier: READ, why: 'Reads the approval policy.' },
  { method: 'settings.get', class: 'read', minTier: READ, why: 'Reads local preferences; the response is filtered before it leaves the host.' },
  { method: 'runtime.profile.list', class: 'read', minTier: READ, why: 'Lists saved runtime profiles.' },
  { method: 'agent.conversation', class: 'read', minTier: READ, why: 'Reads a bot\'s conversation for viewing.' },

  // -- chat (chat and up) ----------------------------------------------------
  { method: 'session.prompt', class: 'chat', minTier: CHAT, why: 'Starts a turn in an existing conversation.', params: stagedAttachmentRule },
  { method: 'session.steer', class: 'chat', minTier: CHAT, why: 'Sends guidance into a running turn.' },
  { method: 'session.cancel', class: 'chat', minTier: CHAT, why: 'Stops a running turn.' },
  { method: 'session.queue.*', class: 'chat', minTier: CHAT, why: 'Manages the queued prompts of a conversation.', params: stagedAttachmentRule },
  { method: 'session.rename', class: 'chat', minTier: CHAT, why: 'Renames a conversation.' },
  { method: 'session.archive', class: 'chat', minTier: CHAT, why: 'Hides or restores a conversation.' },
  { method: 'message.reaction.toggle', class: 'chat', minTier: CHAT, why: 'Adds or removes an emoji reaction.' },
  { method: 'turn.retry.cancel', class: 'chat', minTier: CHAT, why: 'Cancels a pending automatic retry.' },
  { method: 'session.resume', class: 'chat', minTier: CHAT, why: 'Resumes a resumable conversation.' },
  { method: 'session.warm', class: 'chat', minTier: CHAT, why: 'Starts a conversation\'s coding agent ahead of a message.' },
  { method: 'session.close', class: 'chat', minTier: CHAT, why: 'Closes a managed adapter process.' },

  // -- approve (operator and up, only when the host allows it) ---------------
  { method: 'permission.reply', class: 'approve', minTier: OPERATOR, why: 'Answers a pending approval; only when the host allows approvals from remote.', params: permissionReplyRule },

  // -- never (always denied remotely) ----------------------------------------
  { method: 'settings.set', class: 'never', minTier: null, why: 'A remote device must not change the host\'s preferences.' },
  { method: 'agent.create', class: 'never', minTier: null, why: 'A remote device must not create bots.' },
  { method: 'agent.update', class: 'never', minTier: null, why: 'A remote device must not edit bots.' },
  { method: 'agent.delete', class: 'never', minTier: null, why: 'A remote device must not archive bots.' },
  { method: 'agent.restore', class: 'never', minTier: null, why: 'A remote device must not restore bots.' },
  { method: 'agent.reorder', class: 'never', minTier: null, why: 'A remote device must not reorder bots.' },
  { method: 'agent.team.update', class: 'never', minTier: null, why: 'A remote device must not change bot teams.' },
  { method: 'project.create', class: 'never', minTier: null, why: 'A remote device must not create projects.' },
  { method: 'project.update', class: 'never', minTier: null, why: 'A remote device must not edit projects.' },
  { method: 'project.delete', class: 'never', minTier: null, why: 'A remote device must not delete projects.' },
  { method: 'runtime.profile.save', class: 'never', minTier: null, why: 'A remote device must not save runtime profiles.' },
  { method: 'runtime.profile.delete', class: 'never', minTier: null, why: 'A remote device must not delete runtime profiles.' },
  { method: 'runtime.refresh', class: 'never', minTier: null, why: 'A remote device must not trigger a coding agent scan on the host.' },
  { method: 'session.new', class: 'never', minTier: null, why: 'A remote client picks an existing bot and project through a higher-level call, not a session with an arbitrary path.' },
  { method: 'session.delete', class: 'never', minTier: null, why: 'A remote device must not permanently delete a conversation.' },
  { method: 'session.delete.*', class: 'never', minTier: null, why: 'A remote device must not schedule or cancel a conversation deletion.' },
  { method: 'file.revert', class: 'never', minTier: null, why: 'A remote device must not revert files in the host\'s project.' },
  { method: 'automation.create', class: 'never', minTier: null, why: 'A remote device must not create scheduled automations.' },
  { method: 'automation.update', class: 'never', minTier: null, why: 'A remote device must not edit scheduled automations.' },
  { method: 'automation.pause', class: 'never', minTier: null, why: 'A remote device must not pause a scheduled automation.' },
  { method: 'automation.resume', class: 'never', minTier: null, why: 'A remote device must not resume a scheduled automation.' },
  { method: 'automation.delete', class: 'never', minTier: null, why: 'A remote device must not delete a scheduled automation.' },
  { method: 'automation.run_now', class: 'never', minTier: null, why: 'A remote device must not start an unattended run on the host.' },
  { method: 'memory.create', class: 'never', minTier: null, why: 'A remote device must not write memory records.' },
  { method: 'memory.update', class: 'never', minTier: null, why: 'A remote device must not edit memory records.' },
  { method: 'memory.approve', class: 'never', minTier: null, why: 'A remote device must not approve agent-written memory.' },
  { method: 'memory.delete', class: 'never', minTier: null, why: 'A remote device must not delete memory records.' },
  { method: 'memory.restore', class: 'never', minTier: null, why: 'A remote device must not restore memory records.' },
  { method: 'daemon.shutdown', class: 'never', minTier: null, why: 'A remote device must not stop the host daemon.' },
  { method: 'hook.event', class: 'never', minTier: null, why: 'Hook events come from local coding agents, not from a paired device.' },
  { method: 'mcp.*', class: 'never', minTier: null, why: 'The MCP bridge is the local agent tool surface, not a remote device surface.' },
  { method: 'session.handoff.draft', class: 'never', minTier: null, why: 'A remote device must not draft a handoff between conversations.' },
  { method: 'session.model.update', class: 'never', minTier: null, why: 'A remote device must not change a conversation\'s model, effort or approval mode.' },
  { method: 'pricing.*', class: 'never', minTier: null, why: 'Monetary valuation controls are retired and never remote.' },
  { method: 'subscription.*', class: 'never', minTier: null, why: 'Subscription controls are retired and never remote.' },
  { method: 'budget.*', class: 'never', minTier: null, why: 'Budget controls are retired and never remote.' },
  { method: 'quota.refresh', class: 'never', minTier: null, why: 'A remote device must not trigger a provider quota poll on the host; it only needs to read quota.list.' },
] as const

function isFamily(method: string): boolean {
  return method.endsWith('.*')
}

/** The rule for a method: an exact rule first, else the longest family match. */
export function ruleFor(method: string): MethodRule | null {
  let best: MethodRule | null = null
  for (const rule of METHOD_RULES) {
    if (rule.method === method) return rule
    if (!isFamily(rule.method)) continue
    const prefix = rule.method.slice(0, -1)
    if (method.startsWith(prefix) && (best === null || prefix.length > best.method.length - 1)) best = rule
  }
  return best
}

export interface RemoteCall {
  tier: RemoteTier
  approvalsFromRemote: boolean
  method: string
  params?: unknown
  /**
   * When the host's quiet hours are active, every `chat` and `approve` method
   * is denied; `read` methods still pass. This is a hard read-only override
   * applied before dispatch.
   */
  quietHours?: boolean
}

export type RemoteCallDecision =
  | { allowed: true }
  | { allowed: false; code: DenialCode; reason: string }

/**
 * Decide a single remote call. Denials carry a stable wire `code`
 * (`forbidden_remote`, `tier_required`, `approvals_disabled`, `quiet_hours`,
 * `invalid_params`) and a plain-English `reason`. An unknown method is denied
 * with the fixed reason "not on the remote allowlist".
 */
export function authorizeRemoteCall(input: RemoteCall): RemoteCallDecision {
  const rule = ruleFor(input.method)
  if (!rule) return { allowed: false, code: 'forbidden_remote', reason: 'not on the remote allowlist' }
  if (rule.class === 'never') return { allowed: false, code: 'forbidden_remote', reason: rule.why }
  if (input.quietHours && (rule.class === 'chat' || rule.class === 'approve')) {
    return { allowed: false, code: 'quiet_hours', reason: 'quiet hours are on; this host only allows reading right now' }
  }
  if (rule.class === 'approve') {
    if (rule.minTier !== null && !tierAtLeast(input.tier, rule.minTier)) {
      return { allowed: false, code: 'approvals_disabled', reason: `a ${input.tier} device cannot approve on this host` }
    }
    if (!input.approvalsFromRemote) {
      return { allowed: false, code: 'approvals_disabled', reason: 'approvals from remote are turned off on this host' }
    }
  }
  if (rule.minTier !== null && !tierAtLeast(input.tier, rule.minTier)) {
    return { allowed: false, code: 'tier_required', reason: `a ${input.tier} device cannot call ${input.method}` }
  }
  if (rule.params) {
    const reason = rule.params.check(input.params)
    if (reason) return { allowed: false, code: 'invalid_params', reason }
  }
  return { allowed: true }
}

/** The Markdown table (method, class, minimum tier, why) used by the docs. */
export function renderTierTableMarkdown(): string {
  const lines = ['| Method | Class | Minimum tier | Why |', '| --- | --- | --- | --- |']
  for (const rule of METHOD_RULES) {
    lines.push(`| \`${rule.method}\` | ${rule.class} | ${rule.minTier ?? '—'} | ${rule.why} |`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Redaction
//
// Both redactors below are pure: they never mutate their input and accept and
// return `unknown`. The field policy is:
//
// | Path                                             | Policy                                                        |
// | ------------------------------------------------ | ------------------------------------------------------------- |
// | runtimes[]/runtimeProfiles[]/profiles[] args      | removed, replaced by `{ argCount }`                            |
// | runtimes[]/runtimeProfiles[]/profiles[] executablePath | reduced to its file name                                |
// | agents[].defaultProject, projectPath, projects[].path, files[].path | last two path segments only          |
// | agents[].customArgs                              | replaced by `{ argCount }`                                     |
// | agents[].customEnv                               | `{}` (key names dropped)                                       |
// | agents[].instructions                            | `{ hasInstructions: true }` when non-empty                     |
// | messages[].attachments[].path                    | file name only                                                 |
// | tools[]/turns[]/files[] detail                   | removed by default; `includeToolOutput` restores tool detail   |
// | providerSessionId                                | removed                                                        |
// | keys matching the SENSITIVE_KEY pattern          | removed                                                        |
// | settings                                         | reduced to SETTINGS_ALLOWLIST                                  |
// | message content                                  | kept (the conversation is what the device exists to show)      |
//
// `launchArgs` is the runtime spelling of `args`; both are covered.

export interface RedactOptions {
  /** Restore tool `detail` only (never turn or file detail). Default false. */
  includeToolOutput?: boolean
}

/** Keys whose values are never sent to a device. */
const SENSITIVE_KEY = /token|secret|password|credential|capability|api[-_]?key|private[-_]?key|authorization|bearer|cookie/i

/** Settings keys a device may read; the rest of the store is withheld. */
export const SETTINGS_ALLOWLIST: readonly string[] = [
  'appearance.style',
  'appearance.accent',
  'appearance.theme',
  'appearance.textSize',
  'appearance.density',
  'notifications.enabled',
  'permissions.default_mode',
  'experimental.memory',
]

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key)
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path)
}

/** Last two segments of a path, joined with `/`; short values pass through. */
function reducedPath(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length <= 2) return path
  return segments.slice(-2).join('/')
}

/** The final segment of a path, for names that identify a file only. */
function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0)
  return segments.length > 0 ? segments[segments.length - 1] : path
}

function argCount(entry: unknown): unknown {
  return { argCount: Array.isArray(entry) ? entry.length : 0 }
}

function redactSettings(value: unknown): Record<string, unknown> {
  const source = ownKeys(value)
  const out: Record<string, unknown> = {}
  if (!source) return out
  for (const [key, entry] of Object.entries(source)) {
    if (SETTINGS_ALLOWLIST.includes(key)) out[key] = entry
  }
  return out
}

type FieldPolicy =
  | 'default'
  | 'drop'
  | 'settings'
  | 'customEnv'
  | 'argCount'
  | 'instructions'
  | 'fileName'
  | 'pathTail'
  | 'toolDetail'

/**
 * The name of the array the value sits in, when the value is an array item's
 * field (`[..., 'files', '[]', 'path']` -> `files`). Null for object fields.
 */
function arrayContainer(path: readonly string[]): string | null {
  return path[path.length - 2] === '[]' ? path[path.length - 3] ?? null : null
}

function fieldPolicy(path: readonly string[]): FieldPolicy {
  const key = path[path.length - 1]
  switch (key) {
    case 'providerSessionId':
      return 'drop'
    case 'customEnv':
      return 'customEnv'
    case 'customArgs':
    case 'args':
    case 'launchArgs':
      return 'argCount'
    case 'executablePath':
      return 'fileName'
    case 'instructions':
      return 'instructions'
    case 'defaultProject':
    case 'projectPath':
      return 'pathTail'
    case 'settings':
      return path.length === 1 ? 'settings' : 'default'
    case 'detail': {
      const container = arrayContainer(path)
      if (container === 'tools') return 'toolDetail'
      if (container === 'turns' || container === 'files') return 'drop'
      return 'default'
    }
    case 'path': {
      const container = arrayContainer(path)
      if (container === 'attachments') return 'fileName'
      if (container === 'files' || container === 'projects') return 'pathTail'
      return 'default'
    }
    default:
      return 'default'
  }
}

function redactNode(value: unknown, path: readonly string[], options: RedactOptions): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactNode(entry, [...path, '[]'], options))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) continue
      const childPath = [...path, key]
      switch (fieldPolicy(childPath)) {
        case 'drop':
          continue
        case 'settings':
          out[key] = redactSettings(entry)
          continue
        case 'customEnv':
          out[key] = {}
          continue
        case 'argCount':
          out[key] = argCount(entry)
          continue
        case 'instructions':
          out[key] = typeof entry === 'string' && entry.length > 0 ? { hasInstructions: true } : redactNode(entry, childPath, options)
          continue
        case 'fileName':
          out[key] = typeof entry === 'string' ? fileNameOf(entry) : redactNode(entry, childPath, options)
          continue
        case 'pathTail':
          out[key] = typeof entry === 'string' ? reducedPath(entry) : redactNode(entry, childPath, options)
          continue
        case 'toolDetail':
          if (options.includeToolOutput) out[key] = redactNode(entry, childPath, options)
          continue
        default:
          out[key] = redactNode(entry, childPath, options)
      }
    }
    return out
  }
  return value
}

/**
 * Pure function: the snapshot as a remote device may see it. It applies the
 * field policy documented above (file-name-only executables, argument counts,
 * shortened project paths, hidden tool/turn/file detail, hidden
 * `providerSessionId`, the settings allowlist and the sensitive-key rule). The
 * input is never mutated. This redacts `app.snapshot`; the gateway must also
 * apply [redactResultForRemote] to every other result.
 */
export function redactSnapshotForRemote(snapshot: unknown, options: RedactOptions = {}): unknown {
  return redactNode(snapshot, [], options)
}

/** Redact an `Agent` DTO (used for `agent.get`/`agent.list` and `agent.changed`). */
function redactAgentForRemote(agent: unknown, options: RedactOptions): unknown {
  return redactNode(agent, [], options)
}

/**
 * Redact one RPC result for a remote device, by method. `app.snapshot` gets the
 * full snapshot policy; `session.get`/`session.list`, `agent.get`/`agent.list`,
 * `runtime.list`, `runtime.profile.list`, `search.messages` and `automation.get`
 * (prompt kept, paths trimmed) go through the same field watcher; `memory.get`
 * and `memory.list` are kept; `settings.get` is reduced to the allowlist. Any
 * other method whose class is `read` still goes through the field watcher, so a
 * read never passes raw; every other method's result is returned unchanged.
 */
export function redactResultForRemote(method: string, result: unknown, options: RedactOptions = {}): unknown {
  switch (method) {
    case 'app.snapshot':
      return redactSnapshotForRemote(result, options)
    case 'session.get':
    case 'session.list':
      return redactNode(result, [], options)
    case 'agent.get':
    case 'agent.list':
      return redactAgentForRemote(result, options)
    case 'runtime.list':
    case 'runtime.profile.list':
      return redactNode(result, [], options)
    case 'search.messages':
      return redactNode(result, [], options)
    case 'automation.get':
      return redactNode(result, [], options)
    case 'memory.get':
    case 'memory.list':
      return result
    case 'settings.get':
      return redactSettings(result)
    default:
      return ruleFor(method)?.class === 'read' ? redactNode(result, [], options) : result
  }
}

// ---------------------------------------------------------------------------
// Event redaction

/** Whether a daemon event type may cross to a device, or must be dropped. */
export type EventPolicy = 'allow' | 'drop'

/**
 * Every event type the daemon can emit, classified. `allow` is the reviewed
 * send list from docs/remote/PROTOCOL.md; everything else is dropped. The
 * parity test fails when the daemon emits a type missing here, so a new event
 * must be classified deliberately.
 */
export const EVENT_POLICY: Readonly<Record<string, EventPolicy>> = {
  // send (reviewed allowlist)
  'message.delta': 'allow',
  'message.completed': 'allow',
  'session.changed': 'allow',
  'session.deleted': 'allow',
  'turn.completed': 'allow',
  'turn.cancelled': 'allow',
  'turn.error': 'allow',
  'permission.requested': 'allow',
  'permission.resolved': 'allow',
  'agent.changed': 'allow',
  'queue.changed': 'allow',
  'usage.updated': 'allow',
  'quota.updated': 'allow',
  'daemon.health': 'allow',
  'events.replay.complete': 'allow',
  'replay.gap': 'allow',
  'runtime.models.changed': 'allow',
  // drop (never sent)
  'automation.changed': 'drop',
  'automation.deleted': 'drop',
  'automation.run.changed': 'drop',
  'automation.run.finished': 'drop',
  'exec.options.changed': 'drop',
  'exec.options.rejected': 'drop',
  'file.changed': 'drop',
  'hook.observed': 'drop',
  'memory.changed': 'drop',
  'memory.deleted': 'drop',
  'permission.auto_denied': 'drop',
  'permission.auto_resolved': 'drop',
  'permission.bypass_active': 'drop',
  'runtime.changed': 'drop',
  'session.context.reset': 'drop',
  'session.context.updated': 'drop',
  'session.context_exhausted': 'drop',
  'session.replaced': 'drop',
  'session.resume_rejected': 'drop',
  'settings.changed': 'drop',
  'tool.changed': 'drop',
  'turn.retry_declined': 'drop',
  'turn.retry_scheduled': 'drop',
}

function dropKeys(value: unknown, keys: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => dropKeys(entry, keys))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (keys.includes(key)) continue
      out[key] = dropKeys(entry, keys)
    }
    return out
  }
  return value
}

/** Reduce every absolute path string in the tree to its last two segments. */
function reduceAbsolutePaths(value: unknown): unknown {
  if (typeof value === 'string') return isAbsolutePath(value) ? reducedPath(value) : value
  if (Array.isArray(value)) return value.map(reduceAbsolutePaths)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = reduceAbsolutePaths(entry)
    return out
  }
  return value
}

function trimMessageField(value: unknown, max: number): unknown {
  const source = ownKeys(value)
  if (!source || typeof source.message !== 'string') return value
  return { ...value as Record<string, unknown>, message: source.message.slice(0, max) }
}

function redactEventPayload(type: string, payload: unknown): unknown {
  switch (type) {
    case 'message.completed':
      return dropKeys(redactNode(payload, ['payload'], {}), ['raw', 'providerPayload'])
    case 'turn.error':
      return reduceAbsolutePaths(trimMessageField(redactNode(payload, ['payload'], {}), 200))
    case 'permission.requested':
      return reduceAbsolutePaths(redactNode(payload, ['payload'], {}))
    case 'agent.changed':
      return redactAgentForRemote(payload, {})
    default:
      return redactNode(payload, ['payload'], {})
  }
}

/**
 * The event as a remote device may see it, or `null` when it must not be sent.
 * `message.completed` drops `raw`/`providerPayload`; `turn.error` trims the
 * message to 200 characters and reduces absolute paths; `permission.requested`
 * keeps the command text but reduces absolute paths; `agent.changed` goes
 * through the agent policy; every allowed type is still walked for sensitive
 * keys. Anything not on EVENT_POLICY returns `null` (for example
 * `tool.changed`, `hook.observed`, `exec.options.*`, `settings.changed`).
 */
export function redactEventForRemote(event: unknown): unknown | null {
  const envelope = ownKeys(event)
  if (!envelope) return null
  const type = envelope.type
  if (typeof type !== 'string' || EVENT_POLICY[type] !== 'allow') return null
  return { ...envelope, payload: redactEventPayload(type, envelope.payload) }
}
