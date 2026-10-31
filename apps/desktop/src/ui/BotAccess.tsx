// Phase 5: a bot's account and the secrets it gets, saved straight to the daemon. The values
// stay in the Credential Manager: this page only ever sees names.
import { useCallback, useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { rpc } from '../tauri'
import type { Account } from './AccountsPage'
import type { SecretRow } from './SecretsPage'
import { Select } from './Select'
import './accounts.css'

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : typeof reason === 'string' && reason ? reason : fallback

/** Why this environment name can't be used, or null. The daemon checks again. */
export function envKeyProblem(key: string): string | null {
  if (!key) return 'Name the environment variable.'
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? null : 'An environment name has letters, numbers and underscores.'
}

export function BotAccess({ agentId, provider, locked = false }: { agentId: string; provider: string; locked?: boolean }) {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [secrets, setSecrets] = useState<SecretRow[]>([])
  const [accountId, setAccountId] = useState<string | null>(null)
  const [refs, setRefs] = useState<Record<string, string>>({})
  const [key, setKey] = useState('')
  const [secret, setSecret] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const load = useCallback(() => {
    void rpc<{ accounts?: Account[] }>('account.list', {}).then((reply) => setAccounts((reply?.accounts ?? []).filter((item) => item.provider === provider))).catch(() => undefined)
    void rpc<{ secrets?: SecretRow[] }>('secret.list', {}).then((reply) => setSecrets(reply?.secrets ?? [])).catch(() => undefined)
    void rpc<{ agent?: { accountId?: string | null; envRefs?: Record<string, string> | null } }>('agent.get', { agentId }).then((reply) => {
      setAccountId(reply?.agent?.accountId ?? null)
      setRefs(reply?.agent?.envRefs ?? {})
    }).catch(() => undefined)
  }, [agentId, provider])
  useEffect(load, [load])
  const save = async (params: Record<string, unknown>) => {
    setProblem(null)
    try { await rpc('agent.update', { agentId, ...params }); return true } catch (reason) { setProblem(messageOf(reason, 'That could not be saved.')); load(); return false }
  }
  const chooseAccount = (value: string) => { const next = value || null; setAccountId(next); void save({ accountId: next }) }
  const saveRefs = (next: Record<string, string>) => { setRefs(next); void save({ envRefs: next }) }
  const keyProblem = key ? envKeyProblem(key) : null
  if (!accounts.length && !secrets.length) return null
  return <section id="bot-section-access" className="settings-group blob-group" aria-label="Account and secrets">
    <div className="settings-group-head"><strong>Account and secrets</strong></div>
    {accounts.length > 0 && <div className="settings-row">
      <span>Account</span>
      <span className="settings-row-control"><Select ariaLabel="Account" variant="muted" value={accountId ?? ''} disabled={locked} onChange={chooseAccount} options={[{ value: '', label: 'Default account' }, ...accounts.map((item) => ({ value: item.id, label: item.name }))]} /></span>
    </div>}
    {Object.entries(refs).map(([name, value]) => <div key={name} className="bot-secret">
      <code>{name}</code><span>from {value}</span>
      <button type="button" className="icon-button" aria-label={`Stop giving ${name}`} title="Remove" disabled={locked} onClick={() => { const { [name]: _removed, ...rest } = refs; saveRefs(rest) }}><X size={14} aria-hidden="true" /></button>
    </div>)}
    {secrets.length > 0 && <form className="bot-secret-form" onSubmit={(event) => { event.preventDefault(); if (key && secret && !keyProblem) { saveRefs({ ...refs, [key]: secret }); setKey(''); setSecret('') } }}>
      <input className="text-input" value={key} spellCheck={false} placeholder="ENV_NAME" aria-label="Environment variable name" disabled={locked} aria-invalid={!!keyProblem} onChange={(event) => setKey(event.target.value)} />
      <Select ariaLabel="Secret to give" variant="muted" value={secret} disabled={locked} placeholder="Choose a secret" onChange={setSecret} options={secrets.map((item) => ({ value: item.name, label: item.name }))} />
      <button type="submit" className="secondary-button small" disabled={locked || !key || !secret || !!keyProblem}><Plus size={13} aria-hidden="true" />Give</button>
    </form>}
    {(keyProblem || problem) && <p className="new-project-error" role="alert">{keyProblem ?? problem}</p>}
  </section>
}
