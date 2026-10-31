// Settings → Health check: the daemon's `doctor.run` report (coding agents, the
// database, the hook, Remote, the speech model), each with a fix when one exists.
// A fix only ever calls an existing safe daemon method named by the report.
import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react'
import { rpc } from '../tauri'
import { AbandonedWorktrees } from './AbandonedWorktrees'
import { ReportProblemDialog } from './ReportProblemDialog'
import { SettingsGroup, SettingsRow } from './SettingsParts'

export type HealthCheck = { id: string; area: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string; fix: { label: string; method: string; params?: Record<string, unknown> } | null }

const AREA_TITLES: Record<string, string> = { runtime: 'Coding agents', database: 'Database', hooks: 'Hook', remote: 'Remote', speech: 'Speech' }

function isCheck(value: unknown): value is HealthCheck {
  const check = value as Partial<HealthCheck> | null
  return !!check && typeof check.id === 'string' && typeof check.label === 'string' && ['ok', 'warn', 'fail'].includes(String(check.status))
}

export function HealthPage() {
  const [checks, setChecks] = useState<HealthCheck[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [fixing, setFixing] = useState<string | null>(null)
  const [reporting, setReporting] = useState(false)
  const run = useCallback(() => {
    setProblem(null)
    return rpc<{ checks?: unknown[] }>('doctor.run', {})
      .then((result) => setChecks((result?.checks ?? []).filter(isCheck)))
      .catch(() => { setChecks([]); setProblem('The health check could not run. Is the Bitbots service connected?') })
  }, [])
  useEffect(() => { void run() }, [run])
  const fix = async (check: HealthCheck) => {
    if (!check.fix) return
    setFixing(check.id)
    try { await rpc(check.fix.method, check.fix.params ?? {}) } catch { setProblem(`${check.fix.label} did not work. The report below is fresh.`) }
    finally { setFixing(null); void run() }
  }
  const areas = [...new Set((checks ?? []).map((check) => check.area))]
  const failing = (checks ?? []).filter((check) => check.status !== 'ok').length
  return <div className="health-page">
    <SettingsGroup title="Health check" action={<button type="button" className="ghost-button small" disabled={checks === null || !!fixing} onClick={() => { setChecks(null); void run() }}>Check again</button>}>
      <p className="settings-empty" role="status">{checks === null ? 'Checking…' : problem ?? (checks.length === 0 ? 'The service reported no checks.' : failing ? `${failing} ${failing === 1 ? 'thing needs' : 'things need'} attention.` : 'Everything looks healthy.')}</p>
    </SettingsGroup>
    {areas.map((area) => <SettingsGroup key={area} title={AREA_TITLES[area] ?? area}>
      <ul className="health-list">{(checks ?? []).filter((check) => check.area === area).map((check) => <li key={check.id} data-status={check.status}>
        {check.status === 'ok' ? <CircleCheck size={15} aria-hidden="true" /> : check.status === 'warn' ? <TriangleAlert size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
        <span className="health-copy"><strong>{check.label}</strong>{check.detail && <small>{check.detail}</small>}</span>
        {check.fix && check.status !== 'ok' && <button type="button" className="ghost-button small" disabled={!!fixing} onClick={() => void fix(check)}>{fixing === check.id ? 'Working…' : check.fix.label}</button>}
      </li>)}</ul>
    </SettingsGroup>)}
    <AbandonedWorktrees />
    <SettingsGroup title="Something still wrong?">
      <SettingsRow label="Report a problem" hint="Drafts a GitHub issue with your versions and these results. You read and edit it first, and nothing is sent until you choose.">
        <button type="button" className="secondary-button small" onClick={() => setReporting(true)}>Report a problem</button>
      </SettingsRow>
    </SettingsGroup>
    {reporting && <ReportProblemDialog onClose={() => setReporting(false)} />}
  </div>
}
