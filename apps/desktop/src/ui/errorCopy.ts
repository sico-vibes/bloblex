// Plain-language error copy. The daemon, the adapters and the runtime probes all
// speak in codes and provider diagnostics; the UI should not. `friendlyError`
// turns whatever we were given into one short sentence, an optional second
// sentence, an optional recovery action and a tone. Unknown input always falls
// back to a generic sentence with a retry, and the raw text is never the title.

export type FriendlyErrorTone = 'attention' | 'failure' | 'info'

export type FriendlyErrorActionKind = 'sign-in' | 'rescan' | 'retry' | 'open-settings' | 'open-logs' | 'update-agent'

export interface FriendlyErrorAction {
  kind: FriendlyErrorActionKind
  label: string
}

export interface FriendlyError {
  /** One short sentence, no provider jargon. */
  title: string
  /** Optional second sentence with the next step. */
  detail?: string
  action?: FriendlyErrorAction
  tone: FriendlyErrorTone
}

export type FriendlyErrorInput = { code?: string; message?: string; provider?: string } | string | null | undefined

interface NormalizedError {
  code: string
  message: string
  provider?: string
}

const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }

function providerName(provider?: string): string {
  if (!provider) return ''
  const key = provider.trim().toLowerCase()
  if (!key) return ''
  return PROVIDER_NAMES[key] ?? key[0]!.toUpperCase() + key.slice(1)
}

/** Splits an `code: message` string, but only when the head looks like a code. */
function splitCode(text: string): { code: string; message: string } | null {
  const split = text.indexOf(': ')
  if (split <= 0) return null
  const head = text.slice(0, split)
  if (/\s/.test(head)) return null
  return { code: head, message: text.slice(split + 2) }
}

function normalize(raw: FriendlyErrorInput): NormalizedError | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return null
    const split = splitCode(text)
    return split ? { ...split } : { code: '', message: text }
  }
  const code = typeof raw.code === 'string' ? raw.code.trim() : ''
  const message = typeof raw.message === 'string' ? raw.message.trim() : ''
  const provider = typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider : undefined
  if (!code && !message) return null
  if (!code) {
    const split = splitCode(message)
    if (split) return { ...split, provider }
  }
  return { code, message, provider }
}

function action(kind: FriendlyErrorActionKind, label: string): FriendlyErrorAction {
  return { kind, label }
}

const RETRY = action('retry', 'Try again')

function signIn(provider: string | undefined): FriendlyError {
  const name = providerName(provider)
  return {
    title: name ? `Sign in to ${name}.` : 'Sign in to your coding agent.',
    detail: 'Run its sign-in command in a terminal, then try again.',
    action: action('sign-in', 'Sign-in steps'),
    tone: 'attention',
  }
}

const RATE_LIMITED: FriendlyError = {
  title: 'The coding agent is busy right now.',
  detail: 'It is rate limited. Try again in a moment.',
  action: RETRY,
  tone: 'attention',
}

const CONTEXT_FULL: FriendlyError = {
  title: 'This conversation is full.',
  detail: 'Start a new conversation to keep going.',
  action: RETRY,
  tone: 'attention',
}

const QUOTA: FriendlyError = {
  title: 'You have reached the usage limit.',
  detail: 'Wait for the limit to reset, then try again.',
  action: RETRY,
  tone: 'attention',
}

const PROVIDER_UNAVAILABLE: FriendlyError = {
  title: 'The coding agent is not available.',
  detail: 'It may be offline or need an update. Check Settings, then try again.',
  action: action('update-agent', 'Update agent'),
  tone: 'failure',
}

const MODEL_UNAVAILABLE: FriendlyError = {
  title: 'That model is not available.',
  detail: 'Pick a different model in the composer.',
  action: action('open-settings', 'Open settings'),
  tone: 'attention',
}

const TIMEOUT: FriendlyError = {
  title: 'The coding agent took too long.',
  detail: 'No answer arrived in time. Try again.',
  action: RETRY,
  tone: 'attention',
}

const PROCESS_EXITED: FriendlyError = {
  title: 'The coding agent stopped.',
  detail: 'Its process exited before it finished. Try again.',
  action: RETRY,
  tone: 'failure',
}

const PERMISSION_DENIED: FriendlyError = {
  title: 'Permission was denied.',
  detail: 'A required action was not allowed.',
  tone: 'attention',
}

const NOT_FOUND: FriendlyError = {
  title: 'That is no longer available.',
  detail: 'Refresh and try again.',
  action: RETRY,
  tone: 'info',
}

const CONFLICT: FriendlyError = {
  title: 'That action does not match the current state.',
  detail: 'Refresh and try again.',
  action: RETRY,
  tone: 'attention',
}

const INTERNAL: FriendlyError = {
  title: 'Something went wrong on your device.',
  detail: 'Try again. If it keeps happening, open the logs.',
  action: action('open-logs', 'Open logs'),
  tone: 'failure',
}

const CANCELLED: FriendlyError = { title: 'Cancelled.', tone: 'info' }

const INVALID: FriendlyError = {
  title: 'That did not work.',
  detail: 'Check the details and try again.',
  action: RETRY,
  tone: 'attention',
}

const PROVIDER_ERROR: FriendlyError = {
  title: 'The coding agent reported a problem.',
  detail: 'Try again, or start a new conversation.',
  action: RETRY,
  tone: 'failure',
}

const CONFIG_UNSUPPORTED: FriendlyError = {
  title: 'Those settings are not supported.',
  detail: 'Change the model or effort and try again.',
  action: action('open-settings', 'Open settings'),
  tone: 'attention',
}

function byCode(code: string, provider: string | undefined): FriendlyError | null {
  switch (code.toLowerCase()) {
    case 'invalid_argument':
    case 'invalidargument':
      return INVALID
    case 'provider_unavailable':
    case 'providerunavailable':
    case 'no_adapter':
    case 'not_installed':
      return PROVIDER_UNAVAILABLE
    case 'unauthenticated':
    case 'not_signed_in':
    case 'notsignedin':
    case 'auth_required':
    case 'authrequired':
    case 'unauthorized':
      return signIn(provider)
    case 'rate_limited':
    case 'ratelimited':
    case 'overloaded':
    case 'too_many_requests':
      return RATE_LIMITED
    case 'model_unavailable':
    case 'modelunavailable':
    case 'invalid_model':
      return MODEL_UNAVAILABLE
    case 'context':
    case 'context_exhausted':
    case 'context_overflow':
      return CONTEXT_FULL
    case 'timeout':
      return TIMEOUT
    case 'process_exited':
    case 'processexited':
    case 'process_error':
      return PROCESS_EXITED
    case 'permission_denied':
    case 'permissiondenied':
    case 'permission':
      return PERMISSION_DENIED
    case 'quota':
    case 'quota_exceeded':
    case 'usage_limit':
    case 'budget':
    case 'budget_stop':
      return QUOTA
    case 'not_found':
    case 'notfound':
      return NOT_FOUND
    case 'conflict':
      return CONFLICT
    case 'internal':
      return INTERNAL
    case 'cancelled':
    case 'canceled':
    case 'aborterror':
      return CANCELLED
    case 'provider_error':
    case 'provider':
    case 'protocol_error':
      return PROVIDER_ERROR
    case 'config_unsupported':
    case 'config':
    case 'unsupported':
      return CONFIG_UNSUPPORTED
    default:
      return null
  }
}

/** The probe and adapter messages our own code already produces, in plain words. */
function byMessage(message: string, provider: string | undefined): FriendlyError | null {
  const lower = message.toLowerCase()
  if (!lower) return null
  if (/(sign[- ]?in|sign in|log in|login|authenticat|credential|api key|token expired|\b401\b)/.test(lower)) return signIn(provider)
  if (/(rate limit|\b429\b|overloaded|too many requests|temporarily unavailable)/.test(lower)) return RATE_LIMITED
  if (/(context (window )?(is )?(full|overflow)|context exhausted|too many tokens)/.test(lower)) return CONTEXT_FULL
  if (/(quota|usage limit|out of credit)/.test(lower)) return QUOTA
  if (/(timed out|timeout)/.test(lower)) return TIMEOUT
  if (/(process exited|process is unavailable|stopped unexpectedly|supervise)/.test(lower)) return PROCESS_EXITED
  if (/permission/.test(lower) && /(denied|not allowed|refused)/.test(lower)) return PERMISSION_DENIED
  if (/model/.test(lower) && /(unavailable|not available|unknown|invalid|unrecognized|rejected)/.test(lower)) return MODEL_UNAVAILABLE
  if (/(does not advertise|required protocol|unsupported)/.test(lower)) return CONFIG_UNSUPPORTED
  if (/(not installed|not available|unavailable|offline|cannot reach|could not start|could not read|could not complete|could not load|could not be loaded|failed to start)/.test(lower)) return PROVIDER_UNAVAILABLE
  if (/(provider reported|provider error)/.test(lower)) return PROVIDER_ERROR
  return null
}

const GENERIC: FriendlyError = {
  title: 'Something went wrong. Try again.',
  action: RETRY,
  tone: 'failure',
}

const UNDO_EXPIRED: FriendlyError = {
  title: 'The undo period has ended.',
  detail: 'The change is already applied.',
  tone: 'attention',
}

export function friendlyError(raw: FriendlyErrorInput): FriendlyError {
  const normalized = normalize(raw)
  if (!normalized) return { ...GENERIC }
  if (normalized.code.toLowerCase() === 'conflict' && /undo period/i.test(normalized.message)) return { ...UNDO_EXPIRED }
  const coded = normalized.code ? byCode(normalized.code, normalized.provider) : null
  if (coded) return { ...coded }
  const matched = byMessage(normalized.message, normalized.provider)
  if (matched) return { ...matched }
  return { ...GENERIC }
}

/** The single-line form used where a toast or status line takes only text. */
export function friendlyErrorText(raw: FriendlyErrorInput): string {
  const friendly = friendlyError(raw)
  return friendly.detail ? `${friendly.title} ${friendly.detail}` : friendly.title
}

/** A durable usage-limit state; missing or invalid resets never promise a retry. */
export function usageLimitLabel(reset: unknown): string {
  const date = typeof reset === 'string' ? new Date(reset) : null
  return date && Number.isFinite(date.getTime()) ? `Limited until ${date.toLocaleString()}` : 'Limited — try again later'
}
