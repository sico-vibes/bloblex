import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Search } from 'lucide-react'
import { BlobCanvas } from '../blob/BlobCanvas'
import type { Agent, Runtime } from '../types'
import { Select } from './Select'
import { PROVIDER_GUIDES } from './providerGuides'

const COLORS = ['#b7a7f4', '#e89191', '#82c9a5', '#e8b04b', '#77b9dc']
export function FirstRunOnboarding({ runtimes, scanning, error, onScan, onCreate, onFinish, onSaveName }: {
  runtimes: Runtime[]; scanning: boolean; error: string | null; onScan: () => void; onCreate: (runtime: Runtime, name: string, color: string) => Promise<Agent | null>; onFinish: () => void; onSaveName: (name: string) => void
}) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [agentName, setAgentName] = useState('')
  const [runtimeId, setRuntimeId] = useState('')
  const [color, setColor] = useState(COLORS[0])
  const [creating, setCreating] = useState(false)
  const [celebrated, setCelebrated] = useState(false)
  const [copyNotice, setCopyNotice] = useState('')
  const [previewCreatedAt] = useState(() => new Date().toISOString())
  const nameRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const celebrationTimer = useRef<number | null>(null)
  useEffect(() => { if (step === 0) nameRef.current?.focus(); else headingRef.current?.focus() }, [step])
  useEffect(() => () => {
    if (celebrationTimer.current !== null) window.clearTimeout(celebrationTimer.current)
    celebrationTimer.current = null
  }, [step])
  useEffect(() => { if (!runtimeId && runtimes[0]) setRuntimeId(runtimes[0].id) }, [runtimeId, runtimes])
  const finish = () => { onFinish(); }
  const continueName = (skip = false) => { onSaveName(skip ? '' : name.trim().slice(0, 40)); setStep(1) }
  const selectedRuntime = runtimes.find((runtime) => runtime.id === runtimeId)
  const create = async () => {
    if (!selectedRuntime || creating || !agentName.trim()) return
    setCreating(true)
    const result = await onCreate(selectedRuntime, agentName.trim(), color)
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
  const colors = <div className="onboarding-colors" role="group" aria-label="Blob colour">{COLORS.map((item) => <button key={item} type="button" aria-label={'Choose ' + item + ' colour'} aria-pressed={color === item} style={{ backgroundColor: item }} onClick={() => setColor(item)} />)}</div>
  return <main className="onboarding-screen" aria-labelledby="onboarding-title"><section className="onboarding-content">
    <div className="onboarding-character"><BlobCanvas color={color} size={130} mood={step === 1 ? (scanning ? 'tool_activity' : 'thinking') : celebrated ? 'success' : 'idle'} greeting={step === 0 || celebrated} outfit="auto" createdAt={step === 2 || celebrated ? previewCreatedAt : null} label="Bloblex onboarding companion" /></div>
    <div className="onboarding-progress" aria-label={'Step ' + (step + 1) + ' of 3'}>{[0, 1, 2].map((index) => <span key={index} className={index === step ? 'active' : index < step ? 'done' : ''} />)}</div>
    {step === 0 && <section className="onboarding-step"><h1 id="onboarding-title" tabIndex={-1} ref={headingRef}>What should we call you?</h1><p>This name stays on this device.</p><label className="onboarding-field">Your name<input ref={nameRef} className="text-input" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && name.trim()) continueName() }} /></label><div className="onboarding-actions"><button className="ghost-button" onClick={() => continueName(true)}>Skip</button><button className="primary-button" disabled={!name.trim()} onClick={() => continueName()}>Continue</button></div></section>}
    {step === 1 && <section className="onboarding-step"><h1 id="onboarding-title" tabIndex={-1} ref={headingRef}>Coding agents</h1><p>Bloblex checks which coding agents are installed on this device.</p><div className="onboarding-runtimes" aria-live="polite">{(['claude', 'codex', 'opencode'] as const).map((provider) => {
      const guide = PROVIDER_GUIDES[provider]
      const matches = runtimes.filter((runtime) => runtime.provider.toLowerCase() === provider)
          const notSignedIn = matches.some((runtime) => runtime.authState === 'unauthenticated')
          return <article key={provider} className="onboarding-runtime" data-provider={provider}>
            <div className="onboarding-runtime-heading"><strong>{guide.name}</strong><small>{matches.length ? matches.map((runtime) => [runtime.version ?? 'Version unavailable', runtime.authState === 'authenticated' ? 'Signed in' : runtime.authState === 'unauthenticated' ? 'Not signed in' : 'Sign-in status unknown'].join(' · ')).join(', ') : 'Not found on this Windows device'}</small></div>
            {matches.length > 0 && <Check size={16} aria-label="Found" />}
            {!matches.length && <div className="onboarding-guide-block"><small>{guide.installSummary}</small>{guide.installCommands.map((item) => <div className="onboarding-command" key={item.label}><span>{item.label}</span><code>{item.command}</code><button type="button" className="secondary-button small" aria-label={'Copy ' + guide.name + ' install command for ' + item.label} onClick={() => void copy(item.command)}><Copy size={13} />Copy</button><a className="onboarding-doc-link" href={item.docsUrl ?? guide.installDocsUrl}>Docs</a></div>)}</div>}
            {notSignedIn && <div className="onboarding-guide-block"><small>{guide.signInSummary}</small><div className="onboarding-command"><span>Sign in</span><code>{guide.signInCommand}</code><button type="button" className="secondary-button small" aria-label={'Copy ' + guide.name + ' sign-in command'} onClick={() => void copy(guide.signInCommand)}><Copy size={13} />Copy</button><a className="onboarding-doc-link" href={guide.signInDocsUrl}>Sign-in docs</a></div></div>}
            {guide.versionCheckCommand
              ? <div className="onboarding-command onboarding-version"><span>Check version</span><code>{guide.versionCheckCommand}</code><button type="button" className="secondary-button small" aria-label={'Copy ' + guide.name + ' version command'} onClick={() => void copy(guide.versionCheckCommand!)}><Copy size={13} />Copy</button><a className="onboarding-doc-link" href={guide.versionDocsUrl ?? guide.docsUrl}>Version docs</a></div>
              : <div className="onboarding-version-fallback"><small className="onboarding-version-note" role="note">Version check command not confirmed; see <a className="onboarding-doc-link" href={guide.docsUrl}>the official docs</a>.</small></div>}
          </article>
    })}</div>{copyNotice && <p role="status">{copyNotice}</p>}{error && <p role="alert">{error}</p>}<div className="onboarding-actions"><button className="ghost-button" onClick={() => setStep(0)}>Back</button><button className="secondary-button" onClick={onScan} disabled={scanning}><Search size={14} />{scanning ? 'Scanning…' : 'Scan again'}</button>{runtimes.length ? <button className="primary-button" onClick={() => setStep(2)}>Continue</button> : <button className="primary-button" onClick={finish}>Continue without an agent</button>}</div></section>}
    {step === 2 && <section className="onboarding-step"><h1 id="onboarding-title" tabIndex={-1} ref={headingRef}>Meet your first blob</h1><p>Give it a name and colour. You can change these later.</p><label className="onboarding-field">Coding agent<Select ariaLabel="Coding agent" variant="field" value={runtimeId} onChange={(value) => setRuntimeId(value)} options={runtimes.map((runtime) => ({ value: runtime.id, label: PROVIDER_GUIDES[runtime.provider.toLowerCase() as keyof typeof PROVIDER_GUIDES]?.name ?? runtime.provider }))} /></label><label className="onboarding-field">Blob name<input className="text-input" value={agentName} maxLength={40} onChange={(event) => setAgentName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && agentName.trim() && selectedRuntime) { event.preventDefault(); void create() } }} /></label>{colors}{error && <p role="alert">{error}</p>}<div className="onboarding-actions"><button className="ghost-button" disabled={creating} onClick={() => setStep(1)}>Back</button><button className="primary-button" onClick={() => void create()} disabled={creating || !agentName.trim() || !selectedRuntime}>{creating ? 'Creating…' : celebrated ? 'Ready' : 'Create blob'}</button></div></section>}
  </section></main>
}
