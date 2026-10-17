// First-scan recovery: when a scan finds nothing, the install command is not the
// end of the story. Each provider gets a Check again button that remembers when
// it last ran and shows an inline result.

import { useEffect, useRef, useState } from 'react'
import { Check, Copy, RefreshCw } from 'lucide-react'
import type { Runtime } from '../types'
import { PROVIDER_GUIDES } from './providerGuides'
import { ProviderLogo, providerBrand } from './providerBrand'
import { friendlyError } from './errorCopy'
import { SignInHelp } from './SignInHelp'

export const SCAN_PROVIDERS = ['claude', 'codex', 'opencode'] as const
export type ScanProvider = (typeof SCAN_PROVIDERS)[number]

export function checkTimeLabel(at: number): string {
  return `Checked ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/** A per-provider re-check that remembers its last run and reports the result inline. */
export function CheckAgainButton({ name, found, scanning, onScan, compact = false }: { name: string; found: boolean; scanning: boolean; onScan: () => void; compact?: boolean }) {
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [result, setResult] = useState<'found' | 'not-found' | null>(null)
  const pending = useRef(false)
  const wasScanning = useRef(scanning)
  useEffect(() => {
    if (wasScanning.current && !scanning && pending.current) {
      pending.current = false
      setResult(found ? 'found' : 'not-found')
    }
    wasScanning.current = scanning
  }, [scanning, found])
  const resultText = result === 'found' ? `Found ${name}` : result === 'not-found' ? 'Still not found' : ''
  // Compact: one icon button whose tooltip carries when it last ran and what it found.
  if (compact) return <div className="scan-check compact">
    <button type="button" className="icon-button small" aria-label={`Check ${name} again`} title={[scanning && pending.current ? 'Checking…' : 'Check again', checkedAt !== null ? checkTimeLabel(checkedAt) : '', resultText].filter(Boolean).join(' · ')} disabled={scanning} onClick={() => { pending.current = true; setCheckedAt(Date.now()); setResult(null); onScan() }}>
      <RefreshCw size={14} className={scanning && pending.current ? 'spinning' : ''} aria-hidden="true" />
    </button>
    <span className="sr-only" role="status" aria-live="polite">{resultText}</span>
  </div>
  return <div className="scan-check">
    <button type="button" className="secondary-button small" disabled={scanning} onClick={() => { pending.current = true; setCheckedAt(Date.now()); setResult(null); onScan() }}>{scanning && pending.current ? 'Checking…' : 'Check again'}</button>
    {checkedAt !== null && <small className="scan-check-time">{checkTimeLabel(checkedAt)}</small>}
    <span className="scan-check-result" role="status" aria-live="polite">{result === 'found' ? `Found ${name}` : result === 'not-found' ? 'Still not found' : ''}</span>
  </div>
}

function CopyCommandButton({ command, label }: { command: string; label: string }) {
  const [notice, setNotice] = useState('')
  return <>
    <button type="button" className="secondary-button small" aria-label={`Copy ${label} command`} onClick={async () => {
      if (!navigator.clipboard?.writeText) { setNotice('Clipboard is unavailable.'); return }
      try { await navigator.clipboard.writeText(command); setNotice('Command copied.') } catch { setNotice('Could not copy the command.') }
    }}><Copy size={13} />Copy</button>
    <span className="sr-only" role="status">{notice}</span>
  </>
}

/**
 * The empty-scan recovery block: one row per provider with its install command,
 * a Copy button and a Check again. Used by Settings → Agents; the onboarding
 * step reuses `CheckAgainButton` directly because it already lists commands.
 */
export function ScanRecovery({ runtimes, scanning, error, onScan }: {
  runtimes: readonly Runtime[]
  scanning: boolean
  error: string | null
  onScan: () => void
}) {
  const friendly = error ? friendlyError(error) : null
  return <div className="scan-recovery">
    <p className="scan-recovery-intro">No coding agents were found. Install one of these, then check again.</p>
    {friendly && <p className="scan-recovery-error" role="alert">{friendly.title}{friendly.detail ? ` ${friendly.detail}` : ''}</p>}
    {SCAN_PROVIDERS.map((provider) => {
      const guide = PROVIDER_GUIDES[provider]
      const name = providerBrand(provider).name
      const found = runtimes.some((runtime) => runtime.provider.toLowerCase() === provider)
      return <article key={provider} className="scan-recovery-provider" data-provider={provider}>
        <div className="scan-recovery-head"><ProviderLogo provider={provider} /><strong>{name}</strong>{found && <Check size={15} aria-label="Found" />}</div>
        <small>{guide.installSummary}</small>
        {!found && <SignInHelp provider={provider} mode="install" compact />}
        {guide.installCommands.map((item) => <div className="scan-recovery-command" key={item.label}>
          <span>{item.label}</span><code>{item.command}</code>
          <CopyCommandButton command={item.command} label={`${name} ${item.label}`} />
          <a className="onboarding-doc-link" href={item.docsUrl ?? guide.installDocsUrl}>Docs</a>
        </div>)}
        <CheckAgainButton name={name} found={found} scanning={scanning} onScan={onScan} />
      </article>
    })}
  </div>
}
