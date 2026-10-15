// Remote mode policy: which daemon methods a paired device may call, at which
// tier. Remote mode must never expose the daemon wholesale, so `daemon_rpc`
// consults this table (via `authorizeRemoteCall`) instead of passing calls
// through. The table is kept honest by `remoteTiers.parity.test.ts`, which reads
// the daemon's dispatch in `crates/bloblex-daemon/src/main.rs` and fails when a
// dispatched method has no rule here, or a rule has outlived its dispatch arm.
//
// See docs/remote/PROTOCOL.md (the docs table is produced by
// `renderTierTableMarkdown`, printed by scripts/print-remote-tiers.mjs).

import { tierAtLeast, type RemoteTier } from './remoteContract'

export type MethodClass = 'read' | 'chat' | 'approve' | 'never'

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
  { method: 'runtime.list', class: 'read', minTier: READ, why: 'Lists the coding agents installed on the host.' },
  { method: 'runtime.capabilities', class: 'read', minTier: READ, why: 'Describes which execution settings a runtime supports.' },
  { method: 'runtime.models', class: 'read', minTier: READ, why: 'Lists the models a runtime offers so the device can show the choices.' },
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
  { method: 'agent.list', class: 'read', minTier: READ, why: 'Lists blobs so a device can pick one.' },
  { method: 'agent.get', class: 'read', minTier: READ, why: 'Reads one blob\'s settings.' },
  { method: 'project.list', class: 'read', minTier: READ, why: 'Lists known projects so a device can pick one.' },
  { method: 'permissions.policy.get', class: 'read', minTier: READ, why: 'Reads the approval policy.' },
  { method: 'settings.get', class: 'read', minTier: READ, why: 'Reads local preferences; the response is filtered before it leaves the host.' },
  { method: 'runtime.profile.list', class: 'read', minTier: READ, why: 'Lists saved runtime profiles.' },
  { method: 'agent.conversation', class: 'read', minTier: READ, why: 'Reads a blob\'s conversation for viewing.' },

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
  { method: 'session.close', class: 'chat', minTier: CHAT, why: 'Closes a managed adapter process.' },

  // -- approve (operator and up, only when the host allows it) ---------------
  { method: 'permission.reply', class: 'approve', minTier: OPERATOR, why: 'Answers a pending approval; only when the host allows approvals from remote.', params: permissionReplyRule },

  // -- never (always denied remotely) ----------------------------------------
  { method: 'settings.set', class: 'never', minTier: null, why: 'A remote device must not change the host\'s preferences.' },
  { method: 'agent.create', class: 'never', minTier: null, why: 'A remote device must not create blobs.' },
  { method: 'agent.update', class: 'never', minTier: null, why: 'A remote device must not edit blobs.' },
  { method: 'agent.delete', class: 'never', minTier: null, why: 'A remote device must not archive blobs.' },
  { method: 'agent.restore', class: 'never', minTier: null, why: 'A remote device must not restore blobs.' },
  { method: 'agent.reorder', class: 'never', minTier: null, why: 'A remote device must not reorder blobs.' },
  { method: 'agent.team.update', class: 'never', minTier: null, why: 'A remote device must not change blob teams.' },
  { method: 'project.create', class: 'never', minTier: null, why: 'A remote device must not create projects.' },
  { method: 'project.update', class: 'never', minTier: null, why: 'A remote device must not edit projects.' },
  { method: 'project.delete', class: 'never', minTier: null, why: 'A remote device must not delete projects.' },
  { method: 'runtime.profile.save', class: 'never', minTier: null, why: 'A remote device must not save runtime profiles.' },
  { method: 'runtime.profile.delete', class: 'never', minTier: null, why: 'A remote device must not delete runtime profiles.' },
  { method: 'runtime.refresh', class: 'never', minTier: null, why: 'A remote device must not trigger a coding agent scan on the host.' },
  { method: 'session.new', class: 'never', minTier: null, why: 'A remote client picks an existing blob and project through a higher-level call, not a session with an arbitrary path.' },
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
}

/**
 * Decide a single remote call. Denial reasons are plain sentences; an unknown
 * method is denied with the fixed reason "not on the remote allowlist".
 */
export function authorizeRemoteCall(input: RemoteCall): { allowed: true } | { allowed: false; reason: string } {
  const rule = ruleFor(input.method)
  if (!rule) return { allowed: false, reason: 'not on the remote allowlist' }
  if (rule.class === 'never') return { allowed: false, reason: rule.why }
  if (rule.minTier !== null && !tierAtLeast(input.tier, rule.minTier)) {
    return { allowed: false, reason: `a ${input.tier} device cannot call ${input.method}` }
  }
  if (rule.class === 'approve' && !input.approvalsFromRemote) {
    return { allowed: false, reason: 'approvals from remote are turned off on this host' }
  }
  if (rule.params) {
    const reason = rule.params.check(input.params)
    if (reason) return { allowed: false, reason }
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
// Snapshot redaction

const SENSITIVE_KEY = /token|secret|password|credential|capability/i

/** Last two segments of an absolute path; other paths pass through unchanged. */
function reducedPath(path: string): string {
  const absolute = path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path)
  if (!absolute) return path
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0)
  return segments.slice(-2).join('/')
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) continue
      if (key === 'customEnv') {
        out[key] = {}
        continue
      }
      if (key === 'instructions') {
        out[key] = typeof entry === 'string' && entry.length > 0 ? { hasInstructions: true } : redact(entry)
        continue
      }
      if (key === 'projectPath') {
        out[key] = typeof entry === 'string' ? reducedPath(entry) : redact(entry)
        continue
      }
      out[key] = redact(entry)
    }
    return out
  }
  return value
}

/**
 * Pure function: the snapshot as a remote device may see it. It drops secret
 * keys, strips custom environment values, replaces non-empty instruction text
 * with `{ hasInstructions: true }`, and trims absolute `projectPath` values to
 * their last two segments. The input is never mutated.
 */
export function redactSnapshotForRemote(snapshot: unknown): unknown {
  return redact(snapshot)
}
