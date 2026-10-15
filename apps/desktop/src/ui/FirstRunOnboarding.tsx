import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Search } from 'lucide-react'
import { BlobCanvas } from '../blob/BlobCanvas'
import type { Agent, Runtime } from '../types'
import { Select } from './Select'
import { PROVIDER_GUIDES } from './providerGuides'
import { ProviderLogo, providerBrand } from './providerBrand'
import { runtimeAuthSummary } from './launchChecks'
import { rpc } from '../tauri'
import { parseModelCatalog, type CatalogModel } from '../executionContract'
import { preferredConcreteModel } from './modelPreferences'
import { LookPicker } from './LookPicker'
import { LookPreview } from './LookPreview'
import { setThemeStyle } from '../blob/bitbots'
import type { ThemeStyle } from './appearance'

const COLORS = ['#b7a7f4', '#e89191', '#82c9a5', '#e8b04b', '#77b9dc']
export function FirstRunOnboarding({ runtimes, scanning, error, onScan, onCreate, onFinish, onSaveName, initialStep }: {
  runtimes: Runtime[]; scanning: boolean; error: string | null; onScan: () => void; onCreate: (runtime: Runtime, name: string, color: string, modelId: string) => Promise<Agent | null>; onFinish: () => void; onSaveName: (name: string) => void; initialStep?: 0 | 1 | 2
}) {
  // -1 is the look step; the three steps after it keep their old numbers.
  const [step, setStep] = useState<number>(initialStep ?? -1)
  const [pickedLook, setPickedLook] = useState<ThemeStyle | null>(null)
  // The product's vocabulary stays "blob" in every look until the copy pass is done.
  const noun = 'blob'
  const Noun = 'Blob'
  const [name, setName] = useState('')
  const [agentName, setAgentName] = useState('')
  const [runtimeId, setRuntimeId] = useState('')
  const [models, setModels] = useState<CatalogModel[]>([])
  const [modelId, setModelId] = useState('')
  const [modelLoading, setModelLoading] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [color, setColor] = useState(COLORS[0])
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
  useEffect(() => { if (!runtimeId && runtimes[0]) setRuntimeId(runtimes[0].id) }, [runtimeId, runtimes])
  const finish = () => { onFinish(); }
  const continueName = (skip = false) => { onSaveName(skip ? '' : name.trim().slice(0, 40)); setStep(1) }
  const selectedRuntime = runtimes.find((runtime) => runtime.id === runtimeId)
  useEffect(() => {
    if (step !== 2 || !selectedRuntime) { setModels([]); setModelId(''); setModelLoading(false); setModelError(null); return }
    let cancelled = false
    setModelLoading(true)
    setModels([])
    setModelId('')
    setModelError(null)
    rpc('runtime.models', { runtimeId: selectedRuntime.id }).then((raw) => {
      if (cancelled) return
      const catalog = parseModelCatalog(raw)
      if (!catalog || !catalog.validated || catalog.fallback) {
        setModelError('A verified model list is unavailable. Scan again or choose another coding agent.')
        return
      }
      setModels(catalog.models)
      setModelId(preferredConcreteModel(selectedRuntime.provider, catalog.models)?.id ?? '')
    }).catch(() => {
      if (!cancelled) setModelError('Could not verify available models. Scan again or choose another coding agent.')
    }).finally(() => { if (!cancelled) setModelLoading(false) })
    return () => { cancelled = true }
  }, [runtimeId, selectedRuntime?.id, selectedRuntime?.provider, step])
  const create = async () => {
    if (!selectedRuntime || creating || !agentName.trim() || !modelId || modelLoading || !!modelError) return
    setCreating(true)
    const result = await onCreate(selectedRuntime, agentName.trim(), color, modelId)
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
  const colors = <div className="onboarding-colors" role="group" aria-label={Noun + ' colour'}>{COLORS.map((item) => <button key={item} type="button" aria-label={'Choose ' + item + ' colour'} aria-pressed={color === item} style={{ backgroundColor: item }} onClick={() => setColor(item)} />)}</div>
  return <main className="onboarding-screen" aria-labelledby="onboarding-title"><section className="onboarding-content">
    {step >= 0 && <div className="onboarding-character"><BlobCanvas color={color} size={112} mood={step === 1 ? (scanning ? 'tool_activity' : 'thinking') : celebrated ? 'success' : 'idle'} label="Bitbots onboarding companion" /></div>}
    <div className="onboarding-progress" role="group" aria-label={'Step ' + (step + 2) + ' of 4'}>{[-1, 0, 1, 2].map((index) => <span key={index} className={index === step ? 'active' : index < step ? 'done' : ''} />)}</div>
    {step === -1 && <section className="onboarding-step look-step"><h1 id="onboarding-title" tabIndex={-1} ref={headingRef}>Choose your look</h1><p>Pick how Bitbots looks and feels. You can switch any time in Settings.</p><LookPicker value={pickedLook} onChange={chooseLook} label="App look" /><LookPreview look={pickedLook} /><div className="onboarding-actions"><button className="primary-button" disabled={!pickedLook} onClick={() => setStep(0)}>Continue</button></div></section>}
    {step === 0 && <section className="onboarding-step"><h1 id="onboarding-title" tabIndex={-1} ref={headingRef}>What should we call you?</h1><p>This name stays on this device.</p><label className="onboarding-field">Your name<input ref={nameRef} className="text-input" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && name.trim()) continueName() }} /></label><div className="onboarding-actions"><button className="ghost-button" onClick={() => setStep(-1)}>Back</button><button className="ghost-button" onClick={() => continueName(true)}>Skip</button><button className="primary-button" disabled={!name.trim()} onClick={() => continueName()}>Continue</button></div></section>}
    {step === 1 && <section className="onboarding-step"><h1 id="onboarding-title" tabIndex={-1} ref={headingRef}>Coding agents</h1><p>Bitbots checks which coding agents are installed on this device.</p><div className="onboarding-runtimes" aria-live="polite">{(['claude', 'codex', 'opencode'] as const).map((provider) => {
      const guide = PROVIDER_GUIDES[provider]
      const providerName = providerBrand(provider).name
      const matches = runtimes.filter((runtime) => runtime.provider.toLowerCase() === provider)
      const notSignedIn = matches.some((runtime) => runtimeAuthSummary(runtime).state === 'unauthenticated')
          return <article key={provider} className="onboarding-runtime" data-provider={provider}>
            <div className="onboarding-runtime-heading"><div className="onboarding-provider"><ProviderLogo provider={provider} /><strong>{providerName}</strong></div><small>{matches.length ? matches.map((runtime) => [runtime.version ?? 'Version unavailable', runtimeAuthSummary(runtime).label].join(' · ')).join(', ') : 'Not found on this Windows device'}</small></div>
            {matches.length > 0 && <Check size={16} aria-label="Found" />}
            {!matches.length && <div className="onboarding-guide-block"><small>{guide.installSummary}</small>{guide.installCommands.map((item) => <div className="onboarding-command" key={item.label}><span>{item.label}</span><code>{item.command}</code><button type="button" className="secondary-button small" aria-label={'Copy ' + providerName + ' install command for ' + item.label} onClick={() => void copy(item.command)}><Copy size={13} />Copy</button><a className="onboarding-doc-link" href={item.docsUrl ?? guide.installDocsUrl}>Docs</a></div>)}</div>}
            {notSignedIn && <div className="onboarding-guide-block"><small>{guide.signInSummary}</small><div className="onboarding-command"><span>Sign in</span><code>{guide.signInCommand}</code><button type="button" className="secondary-button small" aria-label={'Copy ' + providerName + ' sign-in command'} onClick={() => void copy(guide.signInCommand)}><Copy size={13} />Copy</button><a className="onboarding-doc-link" href={guide.signInDocsUrl}>Sign-in docs</a></div></div>}
            {guide.versionCheckCommand
              ? <div className="onboarding-command onboarding-version"><span>Check version</span><code>{guide.versionCheckCommand}</code><button type="button" className="secondary-button small" aria-label={'Copy ' + providerName + ' version command'} onClick={() => void copy(guide.versionCheckCommand!)}><Copy size={13} />Copy</button><a className="onboarding-doc-link" href={guide.versionDocsUrl ?? guide.docsUrl}>Version docs</a></div>
              : <div className="onboarding-version-fallback"><small className="onboarding-version-note" role="note">Version check command not confirmed; see <a className="onboarding-doc-link" href={guide.docsUrl}>the official docs</a>.</small></div>}
          </article>
    })}</div>{copyNotice && <p role="status">{copyNotice}</p>}{error && <p role="alert">{error}</p>}<div className="onboarding-actions"><button className="ghost-button" onClick={() => setStep(0)}>Back</button><button className="secondary-button" onClick={onScan} disabled={scanning}><Search size={14} />{scanning ? 'Scanning…' : 'Scan again'}</button>{runtimes.length ? <button className="primary-button" onClick={() => setStep(2)}>Continue</button> : <button className="primary-button" onClick={finish}>Continue without an agent</button>}</div></section>}
    {step === 2 && <section className="onboarding-step"><h1 id="onboarding-title" tabIndex={-1} ref={headingRef}>Meet your first {noun}</h1><p>Give it a name and choose the model it will use.</p><label className="onboarding-field">Coding agent<Select ariaLabel="Coding agent" variant="field" value={runtimeId} onChange={(value) => setRuntimeId(value)} options={runtimes.map((runtime) => ({ value: runtime.id, label: providerBrand(runtime.provider).name, provider: runtime.provider }))} /></label><label className="onboarding-field">Model<Select ariaLabel="Model" variant="field" value={modelId} disabled={modelLoading || !!modelError || models.length === 0} onChange={setModelId} options={[{ value:'', label: modelLoading ? 'Loading models…' : 'Choose a model', disabled:true }, ...models.map((model) => ({ value:model.id, label:model.displayName, ...(model.group ? { group:model.group } : {}) }))]} /></label>{modelLoading && <p role="status">Loading verified models…</p>}{modelError && <p role="alert">{modelError}</p>}<label className="onboarding-field">{Noun} name<input className="text-input" value={agentName} maxLength={40} onChange={(event) => setAgentName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && agentName.trim() && selectedRuntime && modelId) { event.preventDefault(); void create() } }} /></label>{colors}{error && <p role="alert">{error}</p>}<div className="onboarding-actions"><button className="ghost-button" disabled={creating} onClick={() => setStep(1)}>Back</button><button className="primary-button" onClick={() => void create()} disabled={creating || !agentName.trim() || !selectedRuntime || !modelId || modelLoading || !!modelError}>{creating ? 'Creating…' : celebrated ? 'Ready' : 'Create ' + noun}</button></div></section>}
  </section></main>
}
