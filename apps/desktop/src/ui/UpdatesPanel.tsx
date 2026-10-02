import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BETA_CHANNEL_EXPLANATION, CHECKING_UPDATES_MESSAGE, DEV_BUILD_UPDATES_MESSAGE, NO_STABLE_RELEASE_MESSAGE,
  STABLE_CHANNEL_EXPLANATION, UP_TO_DATE_MESSAGE, UPDATE_FAILED_MESSAGE,
  countInstallAffectedSessions, describeUpdateProgress, displayUpdateFailure, formatUpdateTimestamp, installImpactCopy,
  parseUpdateChannel, updateErrorMessage,
  type UpdateChannel, type UpdateInfo, type UpdateProgress, type UpdatesState,
} from '../updatesContract'
import { listenForUpdateProgress, updatesCheck, updatesGetState, updatesInstall, updatesSetPreferences } from '../tauri'
import { useDialogAccessibility } from './dialogFocus'
import { Select } from './Select'

type CheckKind = 'idle' | 'checking' | 'up_to_date' | 'available' | 'no_stable_release' | 'error'

export function UpdatesPanel({ sessions = [], permissions = [] }: {
  sessions?: readonly { id?: string; state?: string | null }[]
  permissions?: readonly { sessionId?: string; status?: unknown }[]
}) {
  const [state, setState] = useState<UpdatesState | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [checkKind, setCheckKind] = useState<CheckKind>('idle')
  const [statusText, setStatusText] = useState('')
  const [offer, setOffer] = useState<UpdateInfo | null>(null)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [installing, setInstalling] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const installingRef = useRef(false)
  const reducedMotion = usePrefersReducedMotion()

  const applyState = useCallback((next: UpdatesState) => {
    setState(next)
    setOffer(next.devBuild ? null : next.available)
    if (next.devBuild) {
      setCheckKind('idle')
      setStatusText(DEV_BUILD_UPDATES_MESSAGE)
      return
    }
    if (next.available) {
      setCheckKind('available')
      setStatusText(availableSummary(next.available))
    }
  }, [])

  const load = useCallback(async () => {
    setLoadFailed(false)
    try {
      const next = await updatesGetState()
      if (!next) {
        setState(null)
        setOffer(null)
        setLoadFailed(true)
        setStatusText(UPDATE_FAILED_MESSAGE)
        return
      }
      applyState(next)
    } catch (reason) {
      setLoadFailed(true)
      setStatusText(displayUpdateFailure(reason))
    } finally {
      setLoaded(true)
    }
  }, [applyState])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!installing || !progress) return
    setStatusText(describeUpdateProgress(progress).label)
  }, [installing, progress])

  useEffect(() => {
    if (typeof listenForUpdateProgress !== 'function') return
    let cancelled = false
    let unlisten: (() => void) | undefined
    void listenForUpdateProgress((next) => { if (!cancelled && installingRef.current) setProgress(next) })
      .then((stop) => { if (cancelled) stop(); else unlisten = stop })
      .catch(() => undefined)
    return () => { cancelled = true; unlisten?.() }
  }, [])

  const devBuild = state?.devBuild === true
  const controlsDisabled = devBuild || installing || saving || !loaded
  const channel = state?.channel ?? 'beta'
  const shownProgress = progress && installing ? describeUpdateProgress(progress) : null
  const lastChecked = formatUpdateTimestamp(state?.lastCheckedAt ?? null) ?? 'Not checked yet'
  const version = state?.currentVersion?.trim() || 'Unknown'
  const checkLabel = checkKind === 'checking' ? 'Checking…' : checkKind === 'error' || loadFailed ? 'Retry' : 'Check now'

  const runCheck = async () => {
    if (devBuild || installingRef.current) return
    setCheckKind('checking')
    setStatusText(CHECKING_UPDATES_MESSAGE)
    setLoadFailed(false)
    try {
      const result = await updatesCheck()
      setState((current) => current ? { ...current, lastCheckedAt: result.checkedAt || current.lastCheckedAt } : current)
      if (result.status === 'up_to_date') {
        setOffer(null)
        setCheckKind('up_to_date')
        setStatusText(UP_TO_DATE_MESSAGE)
        return
      }
      if (result.status === 'no_stable_release') {
        setOffer(null)
        setCheckKind('no_stable_release')
        setStatusText(NO_STABLE_RELEASE_MESSAGE)
        return
      }
      if (result.status === 'available' && result.update) {
        setOffer(result.update)
        setCheckKind('available')
        setStatusText(availableSummary(result.update))
        return
      }
      setCheckKind('error')
      setStatusText(updateErrorMessage(result.error))
    } catch (reason) {
      setCheckKind('error')
      setStatusText(displayUpdateFailure(reason))
    }
  }

  const persist = async (patch: { channel?: UpdateChannel; autoCheck?: boolean }) => {
    if (!state || devBuild || installingRef.current) return
    setSaving(true)
    try {
      const next = await updatesSetPreferences(patch)
      applyState(next)
      if (!next.devBuild && !next.available) {
        setCheckKind('idle')
        setStatusText('')
      }
    } catch (reason) {
      setCheckKind('error')
      setStatusText(displayUpdateFailure(reason))
    } finally {
      setSaving(false)
    }
  }

  const beginInstall = () => {
    if (devBuild || installingRef.current || !offer) return
    if (countInstallAffectedSessions(sessions, permissions) > 0) { setConfirming(true); return }
    void runInstall()
  }

  const runInstall = async () => {
    if (installingRef.current) return
    installingRef.current = true
    setConfirming(false)
    setInstalling(true)
    setProgress({ phase: 'downloading', downloadedBytes: 0, totalBytes: null })
    try {
      await updatesInstall()
      setProgress((current) => current?.phase === 'installing' ? current : { phase: 'installing', downloadedBytes: current?.downloadedBytes ?? 0, totalBytes: current?.totalBytes ?? null })
    } catch (reason) {
      installingRef.current = false
      setInstalling(false)
      setProgress(null)
      setCheckKind('error')
      setStatusText(displayUpdateFailure(reason))
    }
  }

  return <section className="settings-group" data-settings-section="updates" aria-labelledby="settings-updates-title">
    <div className="settings-group-head"><h3 id="settings-updates-title">Updates</h3></div>
    <div className="settings-card">
      {devBuild && <p className="update-dev-note">{DEV_BUILD_UPDATES_MESSAGE}</p>}
      <div className="settings-row update-summary">
        <span className="settings-row-copy">
          <strong>Current version <span data-update-version>{loaded ? version : '…'}</span></strong>
          <small>{state && lastChecked !== 'Not checked yet' ? <>Last checked <span data-update-last-checked>{lastChecked}</span></> : <span data-update-last-checked>Not checked yet</span>}</small>
        </span>
        <span className="settings-row-control">
          {offer && !devBuild && <button type="button" className="primary-button small" aria-label="Install and restart" disabled={installing} onClick={beginInstall}>Install and restart</button>}
          <button type="button" className="secondary-button small" data-update-check disabled={controlsDisabled || checkKind === 'checking'} onClick={() => { if (!state) void load(); else void runCheck() }}>{checkLabel}</button>
        </span>
      </div>
      {(statusText || (checkKind === 'available' && offer && !devBuild) || shownProgress) && <div className="update-results">
        <p className="update-status" role="status" aria-live="polite" aria-busy={checkKind === 'checking' || installing} data-update-status>{statusText}</p>
        {checkKind === 'available' && offer && !devBuild && <UpdateOffer info={offer} />}
        {shownProgress && <div className={`update-progress${shownProgress.percent == null && !reducedMotion ? ' is-indeterminate' : ''}${reducedMotion ? ' is-reduced-motion' : ''}`} role="progressbar" aria-label={progress?.phase === 'installing' ? 'Installing update' : 'Downloading update'} aria-valuemin={0} {...(shownProgress.percent == null ? {} : { 'aria-valuemax': 100, 'aria-valuenow': shownProgress.percent })}>
          <span style={shownProgress.percent == null ? undefined : { width: `${shownProgress.percent}%` }} />
        </div>}
      </div>}
      {!(statusText || (checkKind === 'available' && offer && !devBuild) || shownProgress) && <p className="sr-only" role="status" aria-live="polite" data-update-status />}
      <div className="settings-row">
        <span className="settings-row-copy"><strong>Channel</strong><small id="update-channel-hint">{channel === 'stable' ? STABLE_CHANNEL_EXPLANATION : BETA_CHANNEL_EXPLANATION}</small></span>
        <span className="settings-row-control">
          <Select ariaLabel="Update channel" describedBy="update-channel-hint" variant="muted" value={channel} disabled={controlsDisabled || !state} onChange={(value) => { const next = parseUpdateChannel(value); if (next) void persist({ channel: next }) }} options={[{ value: 'stable', label: 'Stable' }, { value: 'beta', label: 'Beta' }]} />
        </span>
      </div>
      <div className="settings-row">
        <span className="settings-row-copy"><strong>Check for updates automatically</strong><small>Looks in the background. You still choose when to install.</small></span>
        <span className="settings-row-control"><button type="button" className={`toggle ${state?.autoCheck !== false ? 'on' : ''}`} role="switch" aria-label="Check for updates automatically" aria-checked={state?.autoCheck !== false} disabled={controlsDisabled || !state} onClick={() => void persist({ autoCheck: state?.autoCheck === false })}><i /></button></span>
      </div>
    </div>
    {confirming && <InstallConfirmDialog count={countInstallAffectedSessions(sessions, permissions)} onCancel={() => setConfirming(false)} onConfirm={() => void runInstall()} />}
  </section>
}

function UpdateOffer({ info }: { info: UpdateInfo }) {
  const published = formatUpdateTimestamp(info.pubDate)
  return <div className="update-offer" data-update-offer>
    <p><strong>Update {info.version} is available</strong>{published ? <span> · {published}</span> : null}</p>
    {info.notes ? <p className="update-notes">{info.notes}</p> : null}
  </div>
}

function InstallConfirmDialog({ count, onConfirm, onCancel }: { count: number; onConfirm: () => void; onCancel: () => void }) {
  const ref = useDialogAccessibility(onCancel)
  const sent = useRef(false)
  return <div className="sheet-backdrop update-confirm-backdrop">
    <section ref={ref} className="blob-dialog" role="dialog" aria-modal="true" aria-labelledby="update-install-title" tabIndex={-1} data-update-confirm>
      <h2 id="update-install-title">Install and restart?</h2>
      <p data-update-impact>{installImpactCopy(count)}</p>
      <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" data-dialog-initial-focus onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-button" onClick={() => { if (sent.current) return; sent.current = true; onConfirm() }}>Install and restart</button>
      </div>
    </section>
  </div>
}

function availableSummary(info: UpdateInfo) {
  const published = formatUpdateTimestamp(info.pubDate)
  return published ? `Update ${info.version} is available. Published ${published}.` : `Update ${info.version} is available.`
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => prefersReducedMotion())
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    const apply = () => setReduced(query.matches)
    apply()
    query.addEventListener?.('change', apply)
    return () => query.removeEventListener?.('change', apply)
  }, [])
  return reduced
}

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}
