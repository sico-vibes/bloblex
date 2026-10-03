import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react'
import { Check, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import type { Agent, Runtime, Session } from '../types'
import { rpc } from '../tauri'
import { ConfirmDialog } from './BlobPage'
import { Select } from './Select'
import { currencyDigits, formatCount, formatMinor, majorToMinor, minorToMajor, priceRuleParams } from './usageLimits'

type Row = Record<string, unknown>
type Props = { agents: readonly Agent[]; runtimes: readonly Runtime[]; sessions: readonly Session[] }
const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD']
const options = (items: readonly string[]) => items.map((value) => ({ value, label: value.replaceAll('_', ' ') }))

export function UsageLimitsSettings({ agents, runtimes, sessions }: Props) {
  const [budgets, setBudgets] = useState<Row[]>([])
  const [prices, setPrices] = useState<Row[]>([])
  const [subscriptions, setSubscriptions] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [budgetDraft, setBudgetDraft] = useState<Row | null>(null)
  const [priceDraft, setPriceDraft] = useState<Row | null>(null)
  const [priceFormModelKey, setPriceFormModelKey] = useState('')
  const [subscriptionOpen, setSubscriptionOpen] = useState(false)
  const [subscriptionDraft, setSubscriptionDraft] = useState<Row | null>(null)
  const [subscriptionCurrency, setSubscriptionCurrency] = useState('USD')
  const [subscriptionProvider, setSubscriptionProvider] = useState('')
  const [subscriptionPlanName, setSubscriptionPlanName] = useState('')
  const [subscriptionAmount, setSubscriptionAmount] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Row | null>(null)
  const [deletingBudget, setDeletingBudget] = useState(false)
  const budgetGroupRef = useRef<HTMLElement>(null)
  const addBudgetRef = useRef<HTMLButtonElement>(null)
  const returnBudgetFocus = useRef(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [budgetResult, priceResult, subscriptionResult] = await Promise.all([
        rpc<unknown>('budget.list'), rpc<unknown>('pricing.list'), rpc<unknown>('subscription.list'),
      ])
      setBudgets(listField(budgetResult, 'policies'))
      setPrices(listField(priceResult, 'rules'))
      setSubscriptions(listField(subscriptionResult, 'plans'))
    } catch (reason) { setError(messageOf(reason)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  useEffect(() => {
    if (!returnBudgetFocus.current || deleteTarget || loading) return
    const frame = requestAnimationFrame(() => {
      const target = budgetDraft ? budgetGroupRef.current : addBudgetRef.current
      target?.focus()
      returnBudgetFocus.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [budgetDraft, deleteTarget, loading])

  const mutate = async (action: () => Promise<unknown>, success: string): Promise<boolean> => {
    setSaving(true); setError(null); setNotice(null)
    try { await action(); setNotice(success); await load(); return true }
    catch (reason) { setError(messageOf(reason)); return false }
    finally { setSaving(false) }
  }
  const saveBudget = (event?: FormEvent) => {
    event?.preventDefault()
    const draft = budgetDraft
    if (!draft) return
    const metric = String(draft.metric ?? 'tokens')
    const currency = typeof draft.currency === 'string' ? draft.currency : 'USD'
    const limit = positiveInteger(draft.amount)
    if (!limit) { setError('Enter a whole number greater than zero.'); return }
    const scopeType = String(draft.scopeType ?? 'global')
    const scopeId = scopeType === 'global' ? null : String(draft.scopeId ?? '')
    if (scopeType !== 'global' && !scopeId) { setError('Choose a scope.'); return }
    const id = typeof draft.id === 'string' ? draft.id : crypto.randomUUID()
    void mutate(() => rpc('budget.set', { id, scopeType, scopeId, metric, period: draft.period, hardLimit: limit, currency, enabled: true, warningThresholds: [50, 80, 95] }), 'Budget saved.')
    setBudgetDraft(null)
  }
  const deleteBudget = async () => {
    if (deletingBudget) return
    const id = deleteTarget?.id
    if (typeof id !== 'string') return
    setDeletingBudget(true)
    await mutate(() => rpc('budget.delete', { policyId: id }), 'Budget removed.')
    setDeletingBudget(false)
    returnBudgetFocus.current = true
    setDeleteTarget(null)
  }

  const openPriceForm = (draft: Row) => {
    const modelKey = `${String(draft.provider ?? '')}:${String(draft.canonicalModelId ?? '')}`
    setPriceFormModelKey(modelKey)
    setPriceDraft({ ...draft, targetModelKey: modelKey })
  }

  const openSubscriptionForm = (plan?: Row) => {
    setSubscriptionDraft(plan ?? null)
    setSubscriptionCurrency(String(plan?.currency ?? 'USD'))
    setSubscriptionProvider(String(plan?.provider ?? ''))
    setSubscriptionPlanName(String(plan?.planName ?? ''))
    setSubscriptionAmount(plan ? minorToMajor(plan.monthlyMinor, String(plan.currency ?? 'USD')) : '')
    setSubscriptionOpen(true)
  }
  const savePrice = (event?: FormEvent) => {
    event?.preventDefault()
    const draft = priceDraft
    if (!draft) return
    const provider = String(draft.provider ?? '').trim()
    const model = String(draft.canonicalModelId ?? '').trim()
    if (!provider || !model || provider.length > 100 || model.length > 160) {
      setError('Enter a provider and model name within the character limits.')
      return
    }
    const currency = String(draft.currency ?? 'USD')
    const rates: Record<string, number | null> = {}
    for (const [field, key] of [['input', 'inputPerMillion'], ['output', 'outputPerMillion'], ['cacheRead', 'cacheReadPerMillion'], ['cacheWrite', 'cacheWritePerMillion']] as const) {
      const raw = String(draft[field] ?? '').trim()
      if (raw === '') {
        rates[key] = null
        continue
      }
      if (!matchesCurrencyPrecision(raw, currency)) {
        setError(currency === 'JPY' ? 'JPY rates must be whole numbers.' : `Use no more than ${currencyDigits(currency)} decimal places for ${currency}.`)
        return
      }
      const minor = majorToMinor(raw, currency, true)
      if (minor === null) {
        setError('Enter a valid non-negative rate.')
        return
      }
      rates[key] = minor
    }
    if (Object.values(rates).every((rate) => rate === null)) { setError('Enter at least one reported rate. Leave unknown rates blank.'); return }
    const rule = { ...priceRuleParams(draft), ...rates, id: typeof draft.id === 'string' ? draft.id : crypto.randomUUID(), provider, canonicalModelId: model, currency }
    void mutate(() => rpc('pricing.override', { rule }), 'Price override saved.')
    setPriceDraft(null)
  }
  const saveSubscription = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    const currency = subscriptionCurrency
    const provider = subscriptionProvider.trim()
    const planName = subscriptionPlanName.trim()
    if (!matchesCurrencyPrecision(subscriptionAmount, currency)) {
      setError(currency === 'JPY' ? 'JPY subscription fees must be whole numbers.' : `Use no more than ${currencyDigits(currency)} decimal places for ${currency}.`)
      return
    }
    const monthlyMinor = majorToMinor(subscriptionAmount, currency)
    if (!provider || !planName || monthlyMinor === null) { setError('Enter a provider, plan name, and a valid monthly fee.'); return }
    const existingId = typeof subscriptionDraft?.id === 'string' ? subscriptionDraft.id : ''
    void mutate(() => rpc('subscription.save', { plan: { id: existingId || crypto.randomUUID(), provider, planName, monthlyMinor, currency, renewalDay: 1 } }), 'Subscription saved.')
    setSubscriptionOpen(false)
  }

  const modelRows = knownModels(agents, prices, runtimes, sessions)
  return <div className="usage-limits-page">
    {error && <p className="settings-banner error" role="alert"><ShieldAlert size={15} />{error}</p>}
    {notice && <p className="settings-banner" role="status"><Check size={14} />{notice}</p>}
    {loading && <p className="settings-loading" role="status">Loading usage settings…</p>}
    {!loading && <>
      <SettingsGroup title="Budgets" sectionRef={budgetGroupRef} tabIndex={-1} action={!budgetDraft && <button ref={addBudgetRef} type="button" className="secondary-button small" onClick={() => setBudgetDraft(blankBudget())}><Plus size={13} />Add budget</button>}>
        {budgets.length === 0 && !budgetDraft && <p className="settings-empty">No budgets are configured.</p>}
        {budgets.map((budget) => <div className="settings-row" key={String(budget.id)}>
          <span className="settings-row-copy"><strong>{scopeLabel(budget, agents, runtimes)} · {budgetMetricLabel(budget.metric)} · {label(String(budget.period ?? 'day'))}</strong><small>{isCostMetric(budget.metric)
            ? <>Limit {formatMinor(budget.hardLimit, budget.currency)} · Usage unknown. Cost limits are not enforced before a turn yet.</>
            : <>Limit {formatCount(budget.hardLimit)} · Used {budgetUsed(budget) == null ? 'Unknown' : formatCount(budgetUsed(budget))} · Remaining {budget.remaining == null ? 'Unknown' : formatCount(budget.remaining)}</>}</small>{budget.period === 'turn' && !isCostMetric(budget.metric) && <small>Used and remaining describe the latest turn; each new turn starts with a fresh limit.</small>}</span>
          <span className="settings-value">{budgetWarning(budget)}</span>
          {budgetEditable(budget) && <button type="button" className="ghost-button small" onClick={() => setBudgetDraft({ ...budget, amount: String(budget.hardLimit) })}>Edit</button>}
          <button type="button" className="icon-button" aria-label={`Delete budget ${scopeLabel(budget, agents, runtimes)}`} onClick={() => setDeleteTarget(budget)}><Trash2 size={14} /></button>
        </div>)}
        {budgetDraft && <form className="settings-form" onSubmit={saveBudget}>
          <div className="settings-field-pair">
            <div className="settings-field"><span>Scope</span><Select ariaLabel="Budget scope" variant="field" align="left" value={String(budgetDraft.scopeType ?? 'global')} onChange={(value) => setBudgetDraft({ ...budgetDraft, scopeType: value, scopeId: '' })} options={[{ value: 'global', label: 'All agents' }, { value: 'agent', label: 'Coding agent' }, { value: 'runtime', label: 'Agent install' }]} /></div>
            {budgetDraft.scopeType !== 'global' && <div className="settings-field"><span>For</span><Select ariaLabel="Budget target" variant="field" align="left" value={String(budgetDraft.scopeId ?? '')} onChange={(value) => setBudgetDraft({ ...budgetDraft, scopeId: value })} options={budgetTargets(String(budgetDraft.scopeType), agents, runtimes)} /> </div>}
          </div>
          <div className="settings-field-pair">
            <div className="settings-field"><span>Metric</span><Select ariaLabel="Budget metric" variant="field" align="left" value={String(budgetDraft.metric ?? 'tokens')} onChange={(value) => setBudgetDraft({ ...budgetDraft, metric: value })} options={[{ value: 'tokens', label: 'Tokens' }, { value: 'input_tokens', label: 'Input tokens' }, { value: 'turns', label: 'Turns' }, { value: 'runtime_minutes', label: 'Runtime minutes' }]} /></div>
            <div className="settings-field"><span>Period</span><Select ariaLabel="Budget period" variant="field" align="left" value={String(budgetDraft.period ?? 'day')} onChange={(value) => setBudgetDraft({ ...budgetDraft, period: value })} options={options(['turn', 'day', 'week', 'month'])} /></div>
          </div>
          <label className="settings-field"><span>Limit</span><input className="text-input" aria-label="Budget limit" type="number" min="1" step="1" value={String(budgetDraft.amount ?? '')} onChange={(event) => setBudgetDraft({ ...budgetDraft, amount: event.target.value })} /></label>
          <div className="settings-form-actions"><button type="button" className="ghost-button small" onClick={() => setBudgetDraft(null)}>Cancel</button><button type="submit" className="primary-button small" disabled={saving} onClick={(event) => { event.preventDefault(); saveBudget() }}>Save budget</button></div>
        </form>}
      </SettingsGroup>

      <SettingsGroup title="Prices">
        {modelRows.length === 0 && <p className="settings-empty">Models appear here after a session reports them. No price, costs stay unknown.</p>}
        {modelRows.map(({ provider, model, price, override }) => <div className="settings-row" key={`${provider}:${model}`}>
          <span className="settings-row-copy"><strong>{model}</strong><small>{providerLabel(provider)} · {priceSourceLabel(price, override)}</small></span>
          {override && <button type="button" className="ghost-button small" onClick={() => openPriceForm({ ...override, provider, canonicalModelId: model, input: minorToMajor(override.inputPerMillion, String(override.currency ?? 'USD')), output: minorToMajor(override.outputPerMillion, String(override.currency ?? 'USD')), cacheRead: minorToMajor(override.cacheReadPerMillion, String(override.currency ?? 'USD')), cacheWrite: minorToMajor(override.cacheWritePerMillion, String(override.currency ?? 'USD')) })}>Edit price</button>}
          {override && <button type="button" className="ghost-button small danger-button" onClick={() => void mutate(() => rpc('pricing.override', { rule: { ...override, remove: true } }), 'Price override removed.')}>Remove override</button>}
          {!override && <button type="button" className="secondary-button small" onClick={() => openPriceForm({ provider, canonicalModelId: model, currency: 'USD', input: '', output: '', cacheRead: '', cacheWrite: '' })}>Set price</button>}
        </div>)}
        {priceDraft && <form key={priceFormModelKey} className="settings-form" onSubmit={savePrice}>
          <div className="settings-field-pair"><label className="settings-field"><span>Provider</span><input className="text-input" aria-label="Price provider" value={String(priceDraft.provider ?? '')} onChange={(event) => setPriceDraft({ ...priceDraft, provider: event.target.value })} /></label><label className="settings-field"><span>Model</span><input className="text-input" aria-label="Price model" value={String(priceDraft.canonicalModelId ?? '')} onChange={(event) => setPriceDraft({ ...priceDraft, canonicalModelId: event.target.value })} /></label></div>
          <div className="settings-field"><span>Currency</span><Select ariaLabel="Price currency" variant="field" align="left" value={String(priceDraft.currency ?? 'USD')} onChange={(value) => setPriceDraft({ ...priceDraft, currency: value })} options={currencyOptions()} /></div>
          <div className="settings-field-pair">{(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((field) => <label className="settings-field" key={field}><span>{label(field)} per million tokens</span><input className="text-input" aria-label={`${label(field)} rate per million tokens`} type="number" min="0" step={10 ** -currencyDigits(String(priceDraft.currency ?? 'USD'))} value={String(priceDraft[field] ?? '')} onChange={(event) => setPriceDraft({ ...priceDraft, [field]: event.target.value })} /></label>)}</div>
          <div className="settings-form-actions"><button type="button" className="ghost-button small" onClick={() => setPriceDraft(null)}>Cancel</button><button type="submit" className="primary-button small" disabled={saving} onClick={(event) => { event.preventDefault(); savePrice() }}>Save price</button></div>
        </form>}
      </SettingsGroup>

      <SettingsGroup title="Subscriptions" action={!subscriptionOpen && <button type="button" className="secondary-button small" onClick={() => openSubscriptionForm()}><Plus size={13} />Add subscription</button>}>
        <p className="settings-empty">Subscription fees are shown separately and never added to usage cost.</p>
        {subscriptions.map((plan) => <div className="settings-row" key={`${String(plan.provider)}:${String(plan.currency)}`}><span className="settings-row-copy"><strong>{String(plan.planName ?? plan.provider ?? 'Subscription')}</strong><small>{formatMinor(plan.monthlyMinor, plan.currency)} / month</small></span><button type="button" className="ghost-button small" onClick={() => { openSubscriptionForm(plan); setNotice(null) }}>Edit</button></div>)}
        {subscriptionOpen && <form className="settings-form" key={String(subscriptionDraft?.id ?? 'new')} onSubmit={saveSubscription}>
          <div className="settings-field-pair"><label className="settings-field"><span>Provider</span><input className="text-input" aria-label="Subscription provider" value={subscriptionProvider} onChange={(event) => setSubscriptionProvider(event.target.value)} /></label><label className="settings-field"><span>Plan name</span><input className="text-input" aria-label="Subscription plan name" value={subscriptionPlanName} onChange={(event) => setSubscriptionPlanName(event.target.value)} /></label></div>
          <div className="settings-field-pair"><label className="settings-field"><span>Monthly fee</span><input className="text-input" type="number" min={10 ** -currencyDigits(subscriptionCurrency)} step={10 ** -currencyDigits(subscriptionCurrency)} aria-label="Monthly fee" value={subscriptionAmount} onChange={(event) => setSubscriptionAmount(event.target.value)} /></label><div className="settings-field"><span>Currency</span><Select ariaLabel="Subscription currency" variant="field" align="left" value={subscriptionCurrency} onChange={setSubscriptionCurrency} options={currencyOptions()} /></div></div>
          <div className="settings-form-actions"><button type="button" className="ghost-button small" onClick={() => setSubscriptionOpen(false)}>Cancel</button><button type="submit" className="primary-button small" disabled={saving} onClick={(event) => { event.preventDefault(); saveSubscription() }}>Save subscription</button></div>
        </form>}
      </SettingsGroup>
    </>}
    {deleteTarget && <ConfirmDialog title="Delete this budget?" body="The budget and its remaining allowance will be removed." confirmLabel="Delete budget" cancelLabel="Cancel" confirmDisabled={deletingBudget} onConfirm={() => void deleteBudget()} onCancel={() => setDeleteTarget(null)} />}
  </div>
}

function SettingsGroup({ title, action, children, sectionRef, tabIndex }: { title: string; action?: ReactNode; children: ReactNode; sectionRef?: Ref<HTMLElement>; tabIndex?: number }) {
  return <section ref={sectionRef} tabIndex={tabIndex} className="settings-group"><div className="settings-group-head"><h3>{title}</h3>{action}</div><div className="settings-card">{children}</div></section>
}
function listField(value: unknown, field: string): Row[] { const row = asRecord(value); return Array.isArray(row[field]) ? (row[field] as unknown[]).filter((item): item is Row => !!item && typeof item === 'object' && !Array.isArray(item)) : [] }
function asRecord(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {} }
function label(value: string) { return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) }
function messageOf(reason: unknown) { return reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'The local daemon request failed.' }
function positiveInteger(value: unknown) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : null }
function matchesCurrencyPrecision(amount: string, currency: string) {
  const value = amount.trim()
  if (value === '') return true
  const fraction = value.split('.')[1] ?? ''
  return fraction.length <= currencyDigits(currency)
}
function budgetUsed(budget: Row) { return typeof budget.consumed === 'number' ? budget.consumed + (typeof budget.reserved === 'number' ? budget.reserved : 0) : null }
function budgetWarning(budget: Row) { if (isCostMetric(budget.metric) || typeof budget.remaining !== 'number' || typeof budget.hardLimit !== 'number' || budget.hardLimit <= 0) return ''; if (budget.remaining <= 0) return 'Over limit'; const thresholds = Array.isArray(budget.warningThresholds) ? budget.warningThresholds.map(Number).filter((value) => Number.isFinite(value) && value > 0 && value < 100) : []; const threshold = thresholds.length ? Math.min(...thresholds) : 50; return (budget.hardLimit - budget.remaining) / budget.hardLimit * 100 >= threshold ? 'Near limit' : '' }
function isCostMetric(metric: unknown) { return metric === 'cost_minor' || metric === 'estimated_cost_minor' || metric === 'actual_cost_minor' }
function budgetMetricLabel(metric: unknown) {
  if (metric === 'cost_minor' || metric === 'estimated_cost_minor' || metric === 'actual_cost_minor') return 'Cost'
  if (metric === 'input_tokens') return 'Input tokens'
  if (metric === 'runtime_minutes') return 'Runtime minutes'
  return label(String(metric ?? 'tokens'))
}
function budgetEditable(budget: Row) {
  return ['global', 'agent', 'runtime'].includes(String(budget.scopeType ?? 'global'))
    && ['tokens', 'input_tokens', 'turns', 'runtime_minutes'].includes(String(budget.metric ?? 'tokens'))
}
function blankBudget(): Row { return { scopeType: 'global', scopeId: '', metric: 'tokens', period: 'day', amount: '' } }
function currencyOptions() { return currencies.map((currency) => ({ value: currency, label: currency })) }
function providerLabel(provider: string) { return ({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' } as Record<string, string>)[provider] ?? label(provider) }
function budgetTargets(scope: string, _agents: readonly Agent[], runtimes: readonly Runtime[]) {
  if (scope === 'agent') return [
    { value: 'claude', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
    { value: 'opencode', label: 'OpenCode' },
  ]
  return [...runtimes]
    .sort((left, right) => runtimeInstallBase(left).localeCompare(runtimeInstallBase(right)))
    .map((runtime) => ({ value: runtime.id, label: runtimeInstallLabel(runtime, runtimes) }))
}
function runtimeInstallBase(runtime: Runtime) {
  const name = typeof runtime.name === 'string' ? runtime.name.trim() : ''
  const version = typeof runtime.version === 'string' ? runtime.version.trim() : ''
  const path = typeof runtime.executablePath === 'string' ? runtime.executablePath.trim() : ''
  return [providerLabel(runtime.provider), name && name !== runtime.provider ? name : '', version, path]
    .filter(Boolean)
    .join(' · ')
}
function runtimeInstallLabel(runtime: Runtime, allRuntimes: readonly Runtime[] = []) {
  const base = runtimeInstallBase(runtime)
  const duplicate = allRuntimes.some((other) => other.id !== runtime.id && runtimeInstallBase(other) === base)
  return duplicate ? `${base} · ${runtime.id}` : base
}
function scopeLabel(row: Row, _agents: readonly Agent[], runtimes: readonly Runtime[]) {
  const scope = String(row.scopeType ?? 'global')
  const id = typeof row.scopeId === 'string' ? row.scopeId : ''
  if (scope === 'global') return 'All agents'
  if (scope === 'agent') return `Coding agent · ${providerLabel(id)}`
  if (scope === 'runtime') return `Agent install · ${runtimeInstallLabel(runtimes.find((runtime) => runtime.id === id) ?? { id, provider: 'unknown' }, runtimes)}`
  if (scope === 'host') return `Host · ${id || 'All local hosts'}`
  if (scope === 'project') return `Project · ${id || 'All projects'}`
  if (scope === 'session') return `Conversation · ${id || 'All conversations'}`
  return `Unknown scope · ${scope}${id ? ` · ${id}` : ''}`
}
function knownModels(agents: readonly Agent[], prices: readonly Row[], runtimes: readonly Runtime[], sessions: readonly Session[]) {
  const models = new Map<string, { provider: string; model: string; price?: Row; override?: Row }>()
  for (const price of prices) {
    const provider = String(price.provider ?? '')
    const model = String(price.canonicalModelId ?? price.model ?? '')
    if (!model) continue
    const key = `${provider}:${model}`
    const source = String(price.source ?? price.priceSource ?? '').toLowerCase()
    const entry = models.get(key) ?? { provider, model }
    entry.price = price
    if (!source || source.includes('override') || source.includes('user')) entry.override = price
    models.set(key, entry)
  }
  for (const session of sessions) {
    const runtime = runtimes.find((item) => item.id === session.runtimeId)
    if (session.model && runtime) {
      const key = `${runtime.provider}:${session.model}`
      if (!models.has(key)) models.set(key, { provider: runtime.provider, model: session.model })
    }
  }
  for (const agent of agents) {
    const runtime = runtimes.find((item) => item.id === agent.runtimeId)
    if (agent.model && runtime) {
      const key = `${runtime.provider}:${agent.model}`
      if (!models.has(key)) models.set(key, { provider: runtime.provider, model: agent.model })
    }
  }
  return [...models.values()]
}
function priceSourceLabel(price?: Row, override?: Row) {
  if (override) return 'Your override'
  const source = String(price?.source ?? price?.priceSource ?? '').toLowerCase()
  if (source.includes('ship') || source.includes('estimate')) return 'Shipped estimate'
  return 'No price, costs stay unknown'
}
