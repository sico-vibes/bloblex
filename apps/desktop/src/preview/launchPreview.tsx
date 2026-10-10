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

/** The real flow: checks finish one after another, then the mascot waves and the intro completes. */
function LiveLaunch() {
  const base = launchFixtureData('done')
  const [settled, setSettled] = useState(0)
  const [run, setRun] = useState(0)
  const [completed, setCompleted] = useState(false)
  useEffect(() => {
    setSettled(0)
    setCompleted(false)
    const timer = window.setInterval(() => setSettled((count) => { if (count >= base.checks.length) { window.clearInterval(timer); return count } return count + 1 }), 750)
    return () => window.clearInterval(timer)
  }, [run, base.checks.length])
  const checks = base.checks.map((check, index) => index < settled ? check : index === settled ? { ...check, state: 'running', detail: 'In progress' } : null).filter(Boolean) as LaunchCheck[]
  return completed
    ? <main className="launch-intro"><section className="launch-intro-content"><p className="launch-status">The intro completed and the app would open now.</p><button className="primary-button" onClick={() => setRun((value) => value + 1)}>Replay</button></section></main>
    : <LaunchIntro key={run} checks={checks} runtimes={base.runtimes} serviceDown={false} onRetry={() => undefined} onContinueOffline={() => undefined} onComplete={() => setCompleted(true)} />
}

function Preview() {
  if (new URLSearchParams(location.search).get('fixture') === 'live') return <LiveLaunch />
  const initial = new URLSearchParams(location.search).get('fixture')
  const [mode, setMode] = useState<typeof launchFixtureModes[number]>(launchFixtureModes.includes(initial as typeof launchFixtureModes[number]) ? initial as typeof launchFixtureModes[number] : 'done')
  const [name, setName] = useState('')
  const fixture = launchFixtureData(mode)
  const onboarding = mode.startsWith('onboarding-step-')
  const initialStep = onboarding ? Number(mode.slice(-1)) - 1 as 0 | 1 | 2 : 0
  return <>
    <nav className="launch-preview-switcher" aria-label="Preview fixtures">
      {launchFixtureModes.map((item) => <button key={item} className="secondary-button small" aria-pressed={item === mode} onClick={() => { setMode(item); history.replaceState(null, '', `?fixture=${item}`) }}>{item}</button>)}
    </nav>
    {onboarding
      ? <FirstRunOnboarding key={mode} initialStep={initialStep} runtimes={fixture.runtimes} scanning={false} error={null} onScan={() => undefined} onCreate={async (runtime, agentName, color) => ({ id: 'fixture-agent', name: agentName, color, runtimeId: runtime.id } as unknown as Agent)} onFinish={() => setMode('done')} onSaveName={setName} />
      : <LaunchIntro autoComplete={false} checks={fixture.checks as LaunchCheck[]} runtimes={fixture.runtimes} serviceDown={fixture.serviceDown} onRetry={() => setMode('in-progress')} onContinueOffline={() => setMode('done')} onComplete={() => setMode('onboarding-step-1')} />}
    <span className="sr-only">Profile fixture name: {name || 'neutral default'}</span>
  </>
}

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark'
ReactDOM.createRoot(document.getElementById('root')!).render(<Preview />)
