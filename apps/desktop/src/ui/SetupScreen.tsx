import type { Runtime } from '../types'
import { providerDisplayName } from './SettingsSheet'

export function SetupScreen({ runtimes, onCreate, onScan, onCustom, scanning = false, error = null, creatingRuntimeIds = [] }: {
  runtimes: readonly Runtime[]
  onCreate: (runtime: Runtime) => void
  onScan: () => void
  onCustom: () => void
  scanning?: boolean
  error?: string | null
  creatingRuntimeIds?: readonly string[]
}) {
  return <section className="setup-screen" aria-labelledby="setup-title">
    <div className="setup-content">
      <p className="setup-eyebrow">Bloblex</p>
      <h1 id="setup-title">Your agents are ready when you are.</h1>
      <p className="setup-copy">Choose an installed coding agent to create your first blob.</p>
      {error && <div className="inline-error setup-error" role="alert"><span>{error}</span></div>}
      <div className="setup-agent-list" aria-label="Detected coding agents">
        {runtimes.map((runtime) => {
          const name = providerDisplayName(runtime.provider)
          const signedOut = runtime.authState === 'unauthenticated'
          return <article className="setup-agent-row" key={runtime.id}>
            <span className="setup-agent-mark" aria-hidden="true">{name.slice(0, 1)}</span>
            <span className="setup-agent-copy"><strong>{name}</strong><small>{runtime.version ?? 'Version unavailable'} · {runtime.authState ?? 'Sign-in status unavailable'}</small>{signedOut && <small>Sign in with the {name} command line tool, then scan again.</small>}</span>
            <button type="button" className="primary-button small" aria-label={`Create a ${name} blob`} disabled={creatingRuntimeIds.includes(runtime.id)} onClick={() => onCreate(runtime)}>{creatingRuntimeIds.includes(runtime.id) ? 'Creating…' : 'Create blob'}</button>
          </article>
        })}
      </div>
      <div className="setup-actions">
        <button type="button" className="secondary-button" onClick={onScan} disabled={scanning}>{scanning ? 'Scanning…' : 'Scan again'}</button>
        <button type="button" className="ghost-button" onClick={onCustom}>Create a custom blob</button>
      </div>
    </div>
  </section>
}
