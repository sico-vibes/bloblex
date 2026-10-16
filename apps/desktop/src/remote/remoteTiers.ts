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
// Since FIX29 (WP6a) the data itself lives in `./tiers.json`, next to this
// file, so the same policy can be loaded by the Rust daemon
// (`crates/bloblex-daemon/src/remote/policy.rs`, same bytes via `include_str!`)
// without two hand-kept copies drifting. This module loads the JSON and exposes
// it through the same names and behaviour as before. `paramRules` in the JSON
// name one of the three checks defined below by id; each side implements those
// three checks itself with identical denial strings.
//
// See docs/remote/PROTOCOL.md (the docs table is produced by
// `renderTierTableMarkdown`, printed by scripts/print-remote-tiers.mjs).

import { tierAtLeast, type RemoteTier } from './remoteContract'
import tiersData from './tiers.json'

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

// ---------------------------------------------------------------------------
// tiers.json: the single source of the policy data
//
// The raw file is validated once, at import, so a typo in a class, a tier, a
// params id or a duplicate method fails loudly instead of quietly changing what
// a device may do. `PolicyData` is the shape this module expects; the Rust port
// in `crates/bloblex-daemon/src/remote/policy.rs` deserializes the same file.

interface PolicyMethodRow {
  method: string
  class: string
  minTier: string | null
  why: string
  params: string | null
}

interface PolicyData {
  version: number
  methods: readonly PolicyMethodRow[]
  events: Readonly<Record<string, string>>
  settingsAllowlist: readonly string[]
  sensitiveKeyPattern: string
}

const POLICY: PolicyData = tiersData as PolicyData

const METHOD_CLASSES: readonly string[] = ['read', 'chat', 'approve', 'never']
const TIER_NAMES: readonly string[] = ['viewer', 'chat', 'operator']

/** The params checks, by the id `tiers.json` uses. */
const PARAM_RULES: Readonly<Record<string, ParamRule>> = {
  stagedAttachments: stagedAttachmentRule,
  permissionReply: permissionReplyRule,
  runtimeModels: runtimeModelsRule,
}

/**
 * A family wildcard (`mcp.*`) or a concrete method. `why` is one plain sentence
 * per rule and is used verbatim in the docs table.
 */
export const METHOD_RULES: readonly MethodRule[] = loadMethodRules(POLICY)

function loadMethodRules(data: PolicyData): MethodRule[] {
  if (data.version !== 1) throw new Error(`tiers.json: unsupported version ${data.version}`)
  const seen = new Set<string>()
  const rules: MethodRule[] = []
  for (const row of data.methods) {
    if (seen.has(row.method)) throw new Error(`tiers.json: duplicate method rule ${row.method}`)
    seen.add(row.method)
    if (!METHOD_CLASSES.includes(row.class)) throw new Error(`tiers.json: ${row.method} has unknown class ${row.class}`)
    if (row.minTier !== null && !TIER_NAMES.includes(row.minTier)) throw new Error(`tiers.json: ${row.method} has unknown tier ${row.minTier}`)
    const rule: MethodRule = {
      method: row.method,
      class: row.class as MethodClass,
      minTier: row.minTier as RemoteTier | null,
      why: row.why,
    }
    if (row.params !== null) {
      const params = PARAM_RULES[row.params]
      if (!params) throw new Error(`tiers.json: ${row.method} names unknown params rule ${row.params}`)
      rule.params = params
    }
    rules.push(rule)
  }
  return rules
}

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

/** Keys whose values are never sent to a device. The pattern comes from `tiers.json`. */
const SENSITIVE_KEY = new RegExp(POLICY.sensitiveKeyPattern, 'i')

/** Settings keys a device may read; the rest of the store is withheld. */
export const SETTINGS_ALLOWLIST: readonly string[] = loadSettingsAllowlist(POLICY)

function loadSettingsAllowlist(data: PolicyData): string[] {
  const keys: string[] = []
  for (const key of data.settingsAllowlist) {
    if (typeof key !== 'string' || key.length === 0) throw new Error('tiers.json: settingsAllowlist holds a non-string key')
    keys.push(key)
  }
  return keys
}

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
 * send list from docs/remote/PROTOCOL.md; everything else is dropped. The list
 * lives in `tiers.json`; an unknown policy value fails at import. The parity
 * test fails when the daemon emits a type missing here, so a new event must be
 * classified deliberately.
 */
export const EVENT_POLICY: Readonly<Record<string, EventPolicy>> = loadEventPolicy(POLICY)

function loadEventPolicy(data: PolicyData): Record<string, EventPolicy> {
  const policy: Record<string, EventPolicy> = {}
  for (const [type, value] of Object.entries(data.events)) {
    if (value !== 'allow' && value !== 'drop') throw new Error(`tiers.json: event ${type} has unknown policy ${value}`)
    policy[type] = value
  }
  return policy
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
