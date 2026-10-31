// Phase 5: Settings > Accounts. Who each coding agent is signed in as, extra accounts in their
// own config folders, and models a catalog doesn't list. Bitbots reads a name from the agent's
// own command, never a token, and the owner signs in with the agent's own command.
import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import type { Runtime } from '../types'
import { rpc } from '../tauri'
import { ConfirmDialog } from './BlobPage'
import { providerBrand, ProviderLogo } from './providerBrand'
import { Select } from './Select'
import { SettingsGroup, SettingsRow } from './SettingsParts'
import { useEntityNoun } from './vocabulary'
import './accounts.css'

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : typeof reason === 'string' && reason ? reason : fallback

export type RuntimeAccount = { label: string | null; plan: string | null; source: string | null }
export type Account = { id: string; provider: string; name: string; signedIn: boolean; label: string | null; plan: string | null; bots: number }
export type CustomModel = { id: string; provider: string; modelId: string; label: string; efforts: string[] }

/** One line for who's signed in. An unknown name stays unknown. */
export function accountLine(account: Pick<RuntimeAccount, 'label' | 'plan'> | null | undefined, signedIn = true): string {
  if (!signedIn) return 'Not signed in'
  const parts = [account?.label || 'Signed in', account?.plan].filter(Boolean)
  return parts.join(' · ')
}

/** Why this custom model can't be saved, or null. The daemon checks again. */
export function customModelProblem(modelId: string, label: string, efforts: string): string | null {
  const id = modelId.trim()
  if (!id) return 'Enter the model id.'
  if (id.length > 200 || /\s/.test(id)) return 'A model id has no spaces and is at most 200 characters.'
  if (label.trim().length > 80) return 'Keep the name to 80 characters.'
  const list = parseEfforts(efforts)
  if (list.length > 8) return 'List at most 8 effort levels.'
  if (list.some((item) => item.length > 24)) return 'An effort level is at most 24 characters.'
  return null
}

export const parseEfforts = (text: string) => [...new Set(text.split(',').map((item) => item.trim()).filter(Boolean))]

const providersOf = (runtimes: readonly Runtime[]) => runtimes.filter((runtime, index) => !!runtime.provider && runtimes.findIndex((other) => other.provider === runtime.provider) === index)

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return <div className="account-command">
    <code>{command}</code>
    <button type="button" className="icon-button" aria-label="Copy the command" title="Copy" onClick={() => { void navigator.clipboard.writeText(command).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }).catch(() => undefined) }}>{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}</button>
  </div>
}

function AccountRow({ account, onChanged, onProblem }: { account: Account; onChanged: () => void; onProblem: (message: string | null) => void }) {
  const noun = useEntityNoun()
  const nouns = useEntityNoun({ plural: true })
  const [command, setCommand] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(account.name)
  const [deleting, setDeleting] = useState(false)
  const act = async (method: string, params: Record<string, unknown>, fallback: string) => {
    onProblem(null)
    try { await rpc(method, { id: account.id, ...params }); onChanged() } catch (reason) { onProblem(messageOf(reason, fallback)) }
  }
  const save = () => { const name = draft.trim(); setRenaming(false); if (name && name !== account.name) void act('account.rename', { name }, 'That name could not be saved.') }
  const showSignIn = async () => {
    onProblem(null)
    try { setCommand((await rpc<{ command: string }>('account.signIn', { id: account.id })).command) } catch (reason) { onProblem(messageOf(reason, 'The sign-in command could not be made.')) }
  }
  return <div className="account-row">
    <div className="account-row-main">
      <span className="account-row-copy">
        {renaming
          ? <input className="remote-rename" aria-label={`Name for ${account.name}`} value={draft} maxLength={60} autoFocus onChange={(event) => setDraft(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === 'Enter') save(); if (event.key === 'Escape') { setDraft(account.name); setRenaming(false) } }} />
          : <strong>{account.name}</strong>}
        <small>{accountLine(account, account.signedIn)} · {account.bots === 1 ? `1 ${noun}` : `${account.bots} ${nouns}`}</small>
      </span>
      <button type="button" className="secondary-button small" onClick={() => void showSignIn()}>{account.signedIn ? 'Sign in again' : 'Sign in'}</button>
      <button type="button" className="icon-button" aria-label={`Check ${account.name} now`} title="Check now" onClick={() => void act('account.check', {}, 'That account could not be checked.')}><RefreshCw size={14} aria-hidden="true" /></button>
      {!renaming && <button type="button" className="icon-button" aria-label={`Rename ${account.name}`} title="Rename" onClick={() => { setDraft(account.name); setRenaming(true) }}><Pencil size={14} aria-hidden="true" /></button>}
      <button type="button" className="icon-button" aria-label={`Delete ${account.name}`} title="Delete" onClick={() => setDeleting(true)}><Trash2 size={14} aria-hidden="true" /></button>
    </div>
    {command && <div className="account-sign-in">
      <small>Run this in a terminal, then check again.</small>
      <CopyCommand command={command} />
      <button type="button" className="icon-button" aria-label="Hide the command" onClick={() => setCommand(null)}><X size={14} aria-hidden="true" /></button>
    </div>}
    {deleting && <ConfirmDialog title={`Delete ${account.name}?`} body={`Its sign-in is deleted from this computer.${account.bots ? ` ${account.bots === 1 ? `1 ${noun} goes` : `${account.bots} ${nouns} go`} back to the default account.` : ''}`} confirmLabel="Delete" cancelLabel="Keep it" tone="warning"
      onConfirm={() => { setDeleting(false); void act('account.delete', { confirm: true }, 'That account could not be deleted.') }} onCancel={() => setDeleting(false)} />}
  </div>
}

function AddAccount({ provider, onAdded, onProblem }: { provider: string; onAdded: () => void; onProblem: (message: string | null) => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const add = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true); onProblem(null)
    try { await rpc('account.create', { provider, name: trimmed }); setName(''); onAdded() } catch (reason) { onProblem(messageOf(reason, 'That account could not be added.')) } finally { setBusy(false) }
  }
  return <form className="account-add" onSubmit={(event) => { event.preventDefault(); void add() }}>
    <input className="text-input" value={name} maxLength={60} placeholder="Work account" aria-label={`Name for a new ${providerBrand(provider).name} account`} onChange={(event) => setName(event.target.value)} />
    <button type="submit" className="secondary-button small" disabled={busy || !name.trim()}><Plus size={13} aria-hidden="true" />Add account</button>
  </form>
}

function CustomModels({ provider }: { provider: string }) {
  const [models, setModels] = useState<CustomModel[]>([])
  const [modelId, setModelId] = useState('')
  const [label, setLabel] = useState('')
  const [efforts, setEfforts] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const load = useCallback(() => { void rpc<{ models?: CustomModel[] }>('model.custom.list', { provider }).then((reply) => setModels(reply?.models ?? [])).catch(() => undefined) }, [provider])
  useEffect(load, [load])
  const local = modelId.trim() ? customModelProblem(modelId, label, efforts) : null
  const save = async () => {
    const reason = customModelProblem(modelId, label, efforts)
    if (reason) { setProblem(reason); return }
    setProblem(null)
    try {
      await rpc('model.custom.save', { id: null, provider, modelId: modelId.trim(), label: label.trim() || modelId.trim(), efforts: parseEfforts(efforts) })
      setModelId(''); setLabel(''); setEfforts(''); load()
    } catch (error) { setProblem(messageOf(error, 'That model could not be saved.')) }
  }
  return <div className="custom-models">
    {models.map((model) => <div key={model.id} className="custom-model">
      <span><strong>{model.label || model.modelId}</strong><small><code>{model.modelId}</code>{model.efforts.length ? ` · ${model.efforts.join(', ')}` : ''}</small></span>
      <button type="button" className="icon-button" aria-label={`Remove ${model.label || model.modelId}`} title="Remove" onClick={() => { void rpc('model.custom.delete', { id: model.id }).then(load).catch((error) => setProblem(messageOf(error, 'That model could not be removed.'))) }}><X size={14} aria-hidden="true" /></button>
    </div>)}
    <form className="custom-model-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <input className="text-input" value={modelId} spellCheck={false} placeholder="Model id" aria-label="Model id" aria-invalid={!!local} onChange={(event) => setModelId(event.target.value)} />
      <input className="text-input" value={label} maxLength={80} placeholder="Name (optional)" aria-label="Model name" onChange={(event) => setLabel(event.target.value)} />
      <input className="text-input" value={efforts} spellCheck={false} placeholder="Effort levels (low, high)" aria-label="Effort levels, separated by commas" onChange={(event) => setEfforts(event.target.value)} />
      <button type="submit" className="secondary-button small" disabled={!modelId.trim() || !!local}><Plus size={13} aria-hidden="true" />Add</button>
    </form>
    {(local || problem) && <p className="new-project-error" role="alert">{local ?? problem}</p>}
  </div>
}

export function AccountsPage({ runtimes }: { runtimes: readonly Runtime[] }) {
  const nouns = useEntityNoun({ plural: true })
  const [accounts, setAccounts] = useState<Account[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [modelProvider, setModelProvider] = useState<string>('')
  const providers = providersOf(runtimes)
  const load = useCallback(() => { void rpc<{ accounts?: Account[] }>('account.list', {}).then((reply) => setAccounts(reply?.accounts ?? [])).catch(() => undefined) }, [])
  useEffect(load, [load])
  const chosen = modelProvider || providers[0]?.provider || ''
  return <>
    <p className="settings-intro">Each coding agent keeps its own sign-in. Add an account to give some {nouns} a different one, then choose it in that bot's settings. Bitbots reads the name from the agent's own command and never handles a token.</p>
    {providers.map((runtime) => {
      const provider = runtime.provider ?? ''
      const account = runtime.account as RuntimeAccount | null | undefined
      return <SettingsGroup key={provider} title={providerBrand(provider).name}>
        <SettingsRow label="Default account" hint="The agent's own sign-in on this computer.">
          <span className="account-default"><ProviderLogo provider={provider} size={14} />{accountLine(account)}</span>
        </SettingsRow>
        {accounts.filter((item) => item.provider === provider).map((item) => <AccountRow key={item.id} account={item} onChanged={load} onProblem={setProblem} />)}
        <AddAccount provider={provider} onAdded={load} onProblem={setProblem} />
      </SettingsGroup>
    })}
    {!providers.length && <p className="settings-empty">No coding agents found yet.</p>}
    {problem && <p className="new-project-error" role="alert">{problem}</p>}
    {providers.length > 0 && <SettingsGroup title="Custom models">
      <SettingsRow label="Models a catalog doesn't list" hint="Bitbots passes the id to the agent as it is. If the agent refuses it, the turn says why.">
        <Select ariaLabel="Coding agent for custom models" variant="muted" value={chosen} onChange={setModelProvider} options={providers.map((runtime) => ({ value: runtime.provider ?? '', label: providerBrand(runtime.provider ?? '').name }))} />
      </SettingsRow>
      {chosen && <CustomModels key={chosen} provider={chosen} />}
    </SettingsGroup>}
  </>
}
