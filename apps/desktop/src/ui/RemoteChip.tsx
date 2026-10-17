import { Globe, Smartphone } from 'lucide-react'
import { useRemoteStatus } from '../remote/useRemote'
import './remoteChip.css'

/** The words the sidebar banner shows for a Remote status. */
export function remoteBannerCopy(status: { enabled: boolean; link: string; deviceCount: number; connectedCount?: number }): { state: string; detail: string; tone: 'live' | 'waiting' | 'off' } {
  if (!status.enabled) return { state: 'Off', detail: 'Use your bots from your phone', tone: 'off' }
  if (status.link !== 'online') return { state: status.link === 'error' ? 'Problem' : 'Starting', detail: status.link === 'error' ? 'Open to see what to fix' : 'Connecting…', tone: 'waiting' }
  const connected = status.connectedCount ?? 0
  if (connected > 0) return { state: 'On', detail: `${connected} ${connected === 1 ? 'device' : 'devices'} connected`, tone: 'live' }
  if (status.deviceCount > 0) return { state: 'On', detail: `${status.deviceCount} paired, none connected`, tone: 'live' }
  return { state: 'On', detail: 'No devices yet', tone: 'live' }
}

/**
 * Remote in the sidebar foot: a small card like the usage meter, with the
 * method's icon, a status light and one line of detail. It opens Settings >
 * Remote. When this build cannot host devices it renders nothing.
 */
export function RemoteChip({ onOpen }: { onOpen: () => void }) {
  const { available, status } = useRemoteStatus()
  if (available !== true || !status) return null
  const copy = remoteBannerCopy(status)
  const native = (status as { method?: string }).method === 'native'
  const Icon = native ? Globe : Smartphone
  const summary = `Remote ${copy.state.toLowerCase()}, ${copy.detail}. Open Remote settings`
  return <button type="button" className={`remote-chip tone-${copy.tone}`} data-tour="remote" aria-label={summary} title={summary} onClick={onOpen}>
    <span className="remote-chip-icon" aria-hidden="true"><Icon size={14} /><i className="remote-chip-light" /></span>
    <span className="remote-chip-copy">
      <span className="remote-chip-title">Remote<em>{copy.state}</em></span>
      <small className="remote-chip-detail">{copy.detail}</small>
    </span>
  </button>
}
