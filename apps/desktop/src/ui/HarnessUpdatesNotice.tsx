import { useEffect, useMemo, useState } from 'react'
import { Check, RefreshCw, TriangleAlert } from 'lucide-react'
import type { Runtime } from '../types'
import { harnessLatestVersion, harnessUpdate } from '../tauri'
import { ProviderLogo } from './providerBrand'
import { SettingsGroup } from './SettingsParts'
import './HarnessUpdatesNotice.css'

type UpdateRow = { runtime: Runtime; latest: string }
type RowState = { status: 'updating' } | { status: 'updated'; version: string } | { status: 'failed'; message: string }

function versionParts(value: string) {
  const match = value.match(/\d+(?:\.\d+){1,3}/)
  return match?.[0].split('.').map(Number) ?? null
}

function isNewer(latest: string, installed: string) {
  const next = versionParts(latest)
  const current = versionParts(installed)
  if (!next || !current) return false
  for (let index = 0; index < Math.max(next.length, current.length); index += 1) {
    const difference = (next[index] ?? 0) - (current[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

function providerName(provider: string) {
  if (provider === 'claude') return 'Claude Code'
  if (provider === 'codex') return 'Codex'
  if (provider === 'opencode') return 'OpenCode'
  return provider
}

export function HarnessUpdatesNotice({ runtimes, onRefresh }: { runtimes: Runtime[]; onRefresh: () => void | Promise<void> }) {
  const installed = useMemo(() => runtimes.filter((runtime) => ['claude', 'codex', 'opencode'].includes(runtime.provider) && runtime.version), [runtimes])
  const [offers, setOffers] = useState<UpdateRow[]>([])
  const [states, setStates] = useState<Record<string, RowState>>({})

  useEffect(() => {
    let cancelled = false
    setOffers([])
    void Promise.all(installed.map(async (runtime) => {
      try {
        const latest = await harnessLatestVersion(runtime.provider)
        return isNewer(latest, runtime.version ?? '') ? { runtime, latest } : null
      } catch {
        return null
      }
    })).then((results) => {
      if (!cancelled) setOffers(results.filter((row): row is UpdateRow => row !== null))
    })
    return () => { cancelled = true }
  }, [installed])

  const update = async (offer: UpdateRow) => {
    setStates((current) => ({ ...current, [offer.runtime.provider]: { status: 'updating' } }))
    try {
      const result = await harnessUpdate(offer.runtime.provider, offer.runtime.version ?? '')
      setStates((current) => ({ ...current, [offer.runtime.provider]: { status: 'updated', version: result.version } }))
      setOffers((current) => current.filter((row) => row.runtime.provider !== offer.runtime.provider))
      await onRefresh()
    } catch (error) {
      setStates((current) => ({ ...current, [offer.runtime.provider]: { status: 'failed', message: error instanceof Error ? error.message : 'Update failed. Try again.' } }))
    }
  }

  if (offers.length === 0 && Object.values(states).every((state) => state.status !== 'updated')) return null
  return <div className="harness-updates-group">
    <SettingsGroup title={offers.length ? 'Harness update available' : 'Harness updated'}>
      <p className="harness-updates-note">New models often need the latest version.</p>
      {offers.map((offer) => {
        const state = states[offer.runtime.provider]
        return <div className={`harness-update-row${state?.status === 'failed' ? ' has-error' : ''}`} key={offer.runtime.id}>
          <ProviderLogo provider={offer.runtime.provider} />
          <span className="harness-update-copy"><strong>{providerName(offer.runtime.provider)}</strong><small>{offer.runtime.version} <span aria-hidden="true">→</span> {offer.latest}</small></span>
          {state?.status === 'updating'
            ? <button type="button" className="secondary-button small" disabled aria-busy="true"><RefreshCw size={13} className="spinning" />Updating</button>
            : <button type="button" className="secondary-button small" onClick={() => void update(offer)}>{state?.status === 'failed' ? 'Retry' : 'Update'}</button>}
          {state?.status === 'failed' && <span className="harness-update-error" role="alert"><TriangleAlert size={13} />{state.message}</span>}
        </div>
      })}
      {Object.entries(states).filter(([, state]) => state.status === 'updated').map(([provider, state]) => state.status === 'updated' && <p className="harness-update-success" role="status" key={provider}><Check size={13} />{providerName(provider)} updated to {state.version}.</p>)}
    </SettingsGroup>
  </div>
}
