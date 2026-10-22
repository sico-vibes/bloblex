import { Skeleton } from './Skeleton'

/** Reserves the shape of settings rows while the real preferences load. */
export function SettingsSkeleton() {
  return <div className="settings-skeleton" role="status" aria-label="Loading settings" aria-busy="true">
    <span className="sr-only">Loading settings</span>
    {[0, 1, 2].map((group) => <div className="settings-skeleton-group" aria-hidden="true" key={group}>
      <Skeleton className="settings-skeleton-heading" />
      {[0, 1].map((row) => <div className="settings-skeleton-row" key={row}><Skeleton lines={2} /><Skeleton variant="pill" /></div>)}
    </div>)}
  </div>
}
