import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Search } from 'lucide-react'
import { BlobCanvas } from '../blob/BlobCanvas'
import type { Agent, Runtime } from '../types'
import { Select } from './Select'
import { PROVIDER_GUIDES } from './providerGuides'
import { ProviderLogo, providerBrand } from './providerBrand'
import { runtimeAuthSummary } from './launchChecks'
import { CheckAgainButton } from './ScanRecovery'
import { SignInHelp } from './SignInHelp'
import { friendlyError } from './errorCopy'
import { rpc } from '../tauri'
import { parseModelCatalog, type CatalogModel } from '../executionContract'
import { preferredConcreteModel } from './modelPreferences'
import { LookPicker } from './LookPicker'
import { LookPreview } from './LookPreview'
import { LookEditor } from './LookEditor'
import { Skeleton } from './Skeleton'
import { HelpTip } from './SettingsParts'
import { setThemeStyle } from '../blob/bitbots'
import { draftLook } from '../blob/look'
import { agentColorHex, previewHex } from './agentColor'
import { createDraft, type AgentDraft } from './agentForm'
import { useEntityNoun } from './vocabulary'
import type { ThemeStyle } from './appearance'

export function FirstRunOnboarding({ runtimes, scanning, error, onScan, onCreate, onFinish, onSaveName, initialStep }: {
  runtimes: Runtime[]; scanning: boolean; error: string | null; onScan: () => void; onCreate: (draft: AgentDraft) => Promise<Agent | null>; onFinish: () => void; onSaveName: (name: string) => void; initialStep?: 0 | 1 | 2
}) {
  // -1 is the look step; the three steps after it keep their old numbers.
  const [step, setStep] = useState<number>(initialStep ?? -1)
  const [pickedLook, setPickedLook] = useState<ThemeStyle | null>(null)
  const noun = useEntityNoun()
  const Noun = useEntityNoun({ capital: true })
  const [name, setName] = useState('')
  // The first bot is a full draft, so its look, colour, role and description are chosen here, not later.
  const [draft, setDraft] = useState<AgentDraft>(() => ({ ...createDraft(runtimes, null), color: 'violet', approvalMode: 'ask' }))
  const [models, setModels] = useState<CatalogModel[]>([])
  const [modelLoading, setModelLoading] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [celebrated, setCelebrated] = useState(false)
  const [copyNotice, setCopyNotice] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const celebrationTimer = useRef<number | null>(null)
  useEffect(() => { if (step === 0) nameRef.current?.focus(); else headingRef.current?.focus() }, [step])
  const chooseLook = (look: ThemeStyle) => {
    setPickedLook(look)
    setThemeStyle(look)
    void Promise.resolve().then(() => rpc('settings.set', { key: 'appearance.style', value: look })).catch(() => undefined)
  }
  useEffect(() => () => {
    if (celebrationTimer.current !== null) window.clearTimeout(celebrationTimer.current)
    celebrationTimer.current = null
  }, [step])
  useEffect(() => { if (!draft.runtimeId && runtimes[0]) setDraft((current) => ({ ...current, runtimeId: runtimes[0].id })) }, [draft.runtimeId, runtimes])
  const finish = () => { onFinish(); }
  const continueName = (skip = false) => { onSaveName(skip ? '' : name.trim().slice(0, 40)); setStep(1) }
  const selectedRuntime = runtimes.find((runtime) => runtime.id === draft.runtimeId)
  useEffect(() => {
    if (step !== 2 || !selectedRuntime) { setModels([]); setModelLoading(false); setModelError(null); return }
    let cancelled = false
    setModelLoading(true)
    setModels([])
    setDraft((current) => ({ ...current, model: null }))
    setModelError(null)
    rpc('runtime.models', { runtimeId: selectedRuntime.id }).then((raw) => {
      if (cancelled) return
      const catalog = parseModelCatalog(raw)
      if (!catalog || !catalog.validated || catalog.fallback) {
        setModelError('A verified model list is unavailable. Scan again or choose another coding agent.')
        return
      }
      setModels(catalog.models)
      const preferred = preferredConcreteModel(selectedRuntime.provider, catalog.models)?.id ?? null
      setDraft((current) => ({ ...current, model: preferred }))
    }).catch(() => {
      if (!cancelled) setModelError('Could not verify available models. Scan again or choose another coding agent.')
    }).finally(() => { if (!cancelled) setModelLoading(false) })
    return () => { cancelled = true }
  }, [draft.runtimeId, selectedRuntime?.id, selectedRuntime?.provider, step])
  const ready = !!selectedRuntime && !!draft.name.trim() && !!draft.model && !modelLoading && !modelError
  const create = async () => {
    if (!ready || creating) return
    setCreating(true)
    const result = await onCreate({ ...draft, name: draft.name.trim(), role: draft.role.trim(), description: draft.description.trim() })
    setCreating(false)
    if (result) {
      setCelebrated(true)
      if (celebrationTimer.current !== null) window.clearTimeout(celebrationTimer.current)
      celebrationTimer.current = window.setTimeout(() => { celebrationTimer.current = null; finish() }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650)
    }
  }
  const copy = async (value: string) => {
    if (!navigator.clipboard?.writeText) { setCopyNotice('Clipboard is unavailable.'); return }
    try { await navigator.clipboard.writeText(value); setCopyNotice('Command copied.') }
    catch { setCopyNotice('Could not copy the command.') }
  }
  const copyButton = (command: string, label: string) => <button type="button" className="icon-button tiny onboarding-copy" aria-label={label} title="Copy" onClick={() => void copy(command)}><Copy size={13} aria-hidden="true" /></button>
  const friendlyScanError = error ? friendlyError(error) : null
  const look = draftLook(draft, null)
  const colorHex = previewHex(draft.color, agentColorHex('violet'))
  return <main className="onboarding-screen" aria-labelledby="onboarding-title"><section className={`onboarding-content${step === 2 ? ' wide' : ''}`}>
    {step >= 0 && step < 2 && <div className="onboarding-character"><BlobCanvas color={colorHex} size={112} mood={step === 1 ? (scanning ? 'tool_activity' : 'thinking') : 'idle'} label="Bitbots onboarding companion" /></div>}
    <div className="onboarding-progress" role="group" aria-label={'Step ' + (step + 2) + ' of 4'}>{[-1, 0, 1, 2].map((index) => <span key={index} className={index === step ? 'active' : index < step ? 'done' : ''} />)}</div>
    {step === -1 && <section className="onboarding-step look-step"><h1 id="onboarding-title" tabIndex={-1} ref={headingRef}>Choose your look</h1><p>Pick how Bitbots looks and feels. You can switch any time in Settings.</p><LookPicker value={pickedLook} onChange={chooseLook} label="App look" /><LookPreview look={pickedLook} /><div className="onboarding-actions"><button className="primary-button" disabled={!pickedLook} onClick={() => setStep(0)}>Continue</button></div></section>}
    {step === 0 && <section className="onboarding-step"><h1 id="onboarding-title" tabIndex={-1} ref={headingRef}>What should we call you?</h1><p>This name stays on this device.</p><label className="onboarding-field">Your name<input ref={nameRef} className="text-input" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && name.trim()) continueName() }} /></label><div className="onboarding-actions"><button className="ghost-button" onClick={() => setStep(-1)}>Back</button><button className="ghost-button" onClick={() => continueName(true)}>Skip</button><button className="primary-button" disabled={!name.trim()} onClick={() => continueName()}>Continue</button></div></section>}
    {step === 1 && <section className="onboarding-step"><h1 id="onboarding-title" tabIndex={-1} ref={headingRef}>Coding agents</h1><p>Bitbots checks which coding agents are installed on this device.</p><div className="onboarding-runtimes" aria-live="polite" aria-busy={scanning || undefined}>{scanning && runtimes.length === 0 && <Skeleton variant="row" lines={3} />}{(['claude', 'codex', 'opencode'] as const).map((provider) => {
      const guide = PROVIDER_GUIDES[provider]
      const providerName = providerBrand(provider).name
      const matches = runtimes.filter((runtime) => runtime.provider.toLowerCase() === provider)
      const found = matches.length > 0
      const notSignedIn = matches.some((runtime) => runtimeAuthSummary(runtime).state === 'unauthenticated')
      const status = found ? matches.map((runtime) => [runtime.version ?? 'Version unavailable', runtimeAuthSummary(runtime).label].join(' · ')).join(', ') : 'Not found on this Windows device'
      return <article key={provider} className={`onboarding-runtime ${found ? 'found' : 'missing'}`} data-provider={provider}>
        <div className="onboarding-runtime-row">
          <ProviderLogo provider={provider} size={22} />
          <div className="onboarding-runtime-copy">
            <strong>{providerName}</strong>
            <small>{status}{found && (guide.versionCheckCommand
              ? <HelpTip align="start" text={<>To check the version yourself, run <code>{guide.versionCheckCommand}</code>. <a className="onboarding-doc-link" href={guide.versionDocsUrl ?? guide.docsUrl}>Version docs</a></>} />
              : <HelpTip align="start" text={<span className="onboarding-version-note" role="note">Version check command not confirmed; see <a className="onboarding-doc-link" href={guide.docsUrl}>the official docs</a>.</span>} />)}</small>
          </div>
          {found && <span className={`onboarding-runtime-state ${notSignedIn ? 'warn' : 'ok'}`}>{notSignedIn ? 'Sign-in needed' : <><Check size={12} aria-hidden="true" />Ready</>}</span>}
          <CheckAgainButton compact name={providerName} found={found} scanning={scanning} onScan={onScan} />
        </div>
        {!found && <SignInHelp provider={provider} mode="install" onChecked={onScan} />}
        {notSignedIn && <SignInHelp provider={provider} runtimeId={matches[0]?.id} onChecked={onScan} />}
        {!found && <div className="onboarding-guide-block"><small>{guide.installSummary}</small>{guide.installCommands.map((item) => <div className="onboarding-command" key={item.label}><span>{item.label}</span><code>{item.command}</code>{copyButton(item.command, 'Copy ' + providerName + ' install command for ' + item.label)}<a className="onboarding-doc-link" href={item.docsUrl ?? guide.installDocsUrl}>Docs</a></div>)}</div>}
        {notSignedIn && <div className="onboarding-guide-block"><small>{guide.signInSummary}</small><div className="onboarding-command"><span>Sign in</span><code>{guide.signInCommand}</code>{copyButton(guide.signInCommand, 'Copy ' + providerName + ' sign-in command')}<a className="onboarding-doc-link" href={guide.signInDocsUrl}>Docs</a></div></div>}
      </article>
    })}</div>{copyNotice && <p role="status" className="onboarding-notice">{copyNotice}</p>}{friendlyScanError && <p role="alert">{friendlyScanError.title}{friendlyScanError.detail ? ' ' + friendlyScanError.detail : ''}</p>}<div className="onboarding-actions split"><button className="ghost-button" onClick={() => setStep(0)}>Back</button><button className="secondary-button" onClick={onScan} disabled={scanning}><Search size={14} />{scanning ? 'Scanning…' : 'Scan again'}</button>{runtimes.length ? <button className="primary-button" onClick={() => setStep(2)}>Continue</button> : <button className="primary-button" onClick={finish}>Continue without an agent</button>}</div></section>}
    {step === 2 && <section className="onboarding-step onboarding-bot-step"><h1 id="onboarding-title" tabIndex={-1} ref={headingRef}>Meet your first {noun}</h1><p>Give it a look, a name and the model it will use. You can change any of it later.</p>
      <div className="onboarding-bot-layout">
        <div className="onboarding-bot-look">
          <LookEditor look={look} color={draft.color} colorHex={colorHex} name={draft.name.trim() || `New ${noun}`} onLookChange={(next) => setDraft({ ...draft, look: next })} onColorChange={(next) => setDraft({ ...draft, color: next })} />
        </div>
        <div className="onboarding-bot-fields">
          <label className="onboarding-field">{Noun} name<input className="text-input" value={draft.name} maxLength={40} onChange={(event) => setDraft({ ...draft, name: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter' && ready) { event.preventDefault(); void create() } }} /></label>
          <label className="onboarding-field"><span className="onboarding-field-title">Role<small>Optional</small></span><input className="text-input" value={draft.role} maxLength={40} placeholder="Engineer, Reviewer, CTO…" onChange={(event) => setDraft({ ...draft, role: event.target.value })} /></label>
          <label className="onboarding-field">Coding agent<Select ariaLabel="Coding agent" variant="field" value={draft.runtimeId} onChange={(value) => setDraft({ ...draft, runtimeId: value, model: null })} options={runtimes.map((runtime) => ({ value: runtime.id, label: providerBrand(runtime.provider).name, provider: runtime.provider }))} /></label>
          <label className="onboarding-field">Model{modelLoading
            ? <div className="onboarding-model-loading" role="status" aria-busy="true" aria-label="Loading models"><Skeleton variant="row" lines={1} /><span className="sr-only">Loading verified models…</span></div>
            : <Select ariaLabel="Model" variant="field" searchable={8} searchPlaceholder="Search models" placeholder="Choose a model" value={draft.model ?? ''} disabled={!!modelError || models.length === 0} onChange={(value) => setDraft({ ...draft, model: value || null })} options={models.map((model, index) => ({ value: model.id, label: model.displayName, ...(model.group && model.group !== models[index - 1]?.group ? { group: model.group } : {}) }))} />}</label>
          {modelError && <p role="alert" className="onboarding-error">{modelError}</p>}
          <label className="onboarding-field"><span className="onboarding-field-title">Description<small>Optional</small></span><textarea className="text-input" rows={2} maxLength={255} value={draft.description} placeholder={`What this ${noun} is good at`} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        </div>
      </div>
      {error && <p role="alert" className="onboarding-error">{error}</p>}
      <div className="onboarding-actions split"><button className="ghost-button" disabled={creating} onClick={() => setStep(1)}>Back</button><button className="primary-button" onClick={() => void create()} disabled={creating || !ready}>{creating ? 'Creating…' : celebrated ? 'Ready' : 'Create ' + noun}</button></div>
    </section>}
  </section></main>
}
