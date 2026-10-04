import { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../ui/theme.css'
import '../ui/styles.css'
import '../ui/shell.css'
import { FirstRunOnboarding } from '../ui/FirstRunOnboarding'
import { LaunchIntro } from '../ui/LaunchIntro'
import type { LaunchCheck } from '../ui/launchChecks'
import type { Agent } from '../types'
import { launchFixtureData, launchFixtureModes } from './fixtureBridge'

function Preview() {
  const [mode, setMode] = useState<typeof launchFixtureModes[number]>('normal')
  const [name, setName] = useState('')
  const [slowReady, setSlowReady] = useState(false)
  useEffect(() => {
    setSlowReady(false)
    if (mode !== 'slow') return
    const timer = window.setTimeout(() => setSlowReady(true), 6_000)
    return () => window.clearTimeout(timer)
  }, [mode])
  const fixture = launchFixtureData(mode)
  const onboarding = mode.startsWith('onboarding-')
  return <>
    <nav className="launch-preview-switcher" aria-label="Preview fixtures">
      {launchFixtureModes.map((item) => <button key={item} className="secondary-button small" aria-pressed={item === mode} onClick={() => setMode(item)}>{item}</button>)}
    </nav>
    {onboarding
      ? <FirstRunOnboarding runtimes={fixture.runtimes} scanning={false} error={null} onScan={() => undefined} onCreate={async (runtime, agentName, color) => ({ id: 'fixture-agent', name: agentName, color, runtimeId: runtime.id } as unknown as Agent)} onFinish={() => setMode('normal')} onSaveName={setName} />
      : <LaunchIntro checks={(fixture.slow && !slowReady ? fixture.checks.map((check) => ({ ...check, state: 'running' })) : fixture.checks) as LaunchCheck[]} runtimes={fixture.runtimes} serviceDown={fixture.serviceDown} onRetry={() => setMode('slow')} onContinueOffline={() => setMode('normal')} onComplete={() => setMode('onboarding-none')} />}
    <span className="sr-only">Profile fixture name: {name || 'neutral default'}</span>
  </>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Preview />)
