import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateInfo } from '../updatesContract'
import { listenForUpdateAvailable, updatesGetState } from '../tauri'

export const DISMISSED_UPDATE_VERSION_KEY = 'bloblex.update.dismissedVersion'

export function readDismissedUpdateVersion(): string | null {
  try {
    const value = localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY)
    return typeof value === 'string' && value.trim() ? value : null
  } catch {
    return null
  }
}

export function rememberDismissedUpdateVersion(version: string) {
  try { localStorage.setItem(DISMISSED_UPDATE_VERSION_KEY, version) } catch { /* dismissal still applies in memory */ }
}

export function UpdateAvailableBanner({ version, onView, onLater }: { version: string; onView: () => void; onLater: () => void }) {
  return <div className="update-banner" role="status" data-update-banner>
    <p>Update {version} is available</p>
    <button type="button" className="pill-button" onClick={onView}>View</button>
    <button type="button" className="pill-button" onClick={onLater}>Later</button>
  </div>
}

export function useMainUpdateOffer(companion: boolean) {
  const [version, setVersion] = useState<string | null>(null)
  const dismissed = useRef<string | null>(readDismissedUpdateVersion())
  const devBuild = useRef(false)
  const ready = useRef(false)
  const pending = useRef<UpdateInfo | null>(null)
  const current = useRef<UpdateInfo | null>(null)

  const publish = useCallback((info: UpdateInfo | null) => {
    current.current = info
    if (!info || devBuild.current || dismissed.current === info.version) {
      setVersion(null)
      return
    }
    setVersion(info.version)
  }, [])

  useEffect(() => {
    if (companion) {
      setVersion(null)
      return
    }
    let cancelled = false
    let unlisten: (() => void) | undefined
    void (async () => {
      try {
        const state = await updatesGetState()
        if (cancelled) return
        ready.current = true
        devBuild.current = state?.devBuild === true
        if (devBuild.current) {
          setVersion(null)
          return
        }
        publish(pending.current ?? state?.available ?? null)
      } catch { /* the shell stays usable when the updater bridge is absent */ }
      try {
        unlisten = await listenForUpdateAvailable((info) => {
          if (cancelled || devBuild.current) return
          if (!ready.current) { pending.current = info; return }
          publish(info)
        })
      } catch { /* tests and preview can omit the listener */ }
    })()
    return () => { cancelled = true; unlisten?.() }
  }, [companion, publish])

  const dismiss = useCallback(() => {
    const shown = current.current?.version
    if (!shown) return
    dismissed.current = shown
    rememberDismissedUpdateVersion(shown)
    setVersion(null)
  }, [])

  return { version: companion ? null : version, dismiss }
}
