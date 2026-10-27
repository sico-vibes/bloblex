// Settings › Manager › Hand-offs: one switch that stops the Manager from starting NEW assignments. It never
// touches work that is already running or queued, approvals, questions, replies or a Stop.
import { useEffect, useState } from 'react'
import { rpc } from '../tauri'
import { rpcFailure } from '../executionContract'
import { SettingsGroup, SettingsRow } from './SettingsParts'

export const DELEGATION_PAUSED_SETTING = 'delegation.paused'

export function DelegationPause({ connected }: { connected: boolean }) {
  const [paused, setPaused] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    if (!connected) return
    let active = true
    void rpc<Record<string, unknown>>('settings.get').then((settings) => { if (active) setPaused(settings[DELEGATION_PAUSED_SETTING] === true) }).catch(() => { if (active) setPaused(false) })
    return () => { active = false }
  }, [connected])
  const toggle = async () => {
    if (paused === null || saving) return
    const next = !paused
    setSaving(true)
    setProblem(null)
    try {
      await rpc('settings.set', { key: DELEGATION_PAUSED_SETTING, value: next })
      setPaused(next)
    } catch (reason) { setProblem(rpcFailure(reason).message) } finally { setSaving(false) }
  }
  return <SettingsGroup title="Hand-offs">
    <SettingsRow label="Pause new hand-offs" hint="While paused, the Manager cannot start new work with a teammate and is told why. Work that is already running or queued, approvals, questions and Stop are not affected.">
      <button type="button" className={`toggle ${paused ? 'on' : ''}`} role="switch" aria-label="Pause new hand-offs from the Manager" aria-checked={paused === true} disabled={!connected || paused === null || saving} onClick={() => void toggle()}><i /></button>
    </SettingsRow>
    {problem && <p className="settings-banner error" role="alert">{problem}</p>}
  </SettingsGroup>
}
