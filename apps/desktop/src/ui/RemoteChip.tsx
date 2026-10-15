import { useRemoteStatus } from '../remote/useRemote'
import { StatusDot } from './StatusDot'
import './remoteChip.css'

/**
 * A quiet one-line Remote status in the sidebar foot, the way a chat app shows
 * a background connection. It is a single button that opens Settings > Remote.
 * When this build cannot host devices (`remote.status` fails) it renders
 * nothing, so a real desktop build shows no dead control here.
 */
export function RemoteChip({ onOpen }: { onOpen: () => void }) {
  const { available, status } = useRemoteStatus()
  if (available !== true || !status) return null
  const online = status.link === 'online'
  const count = status.deviceCount
  const text = !status.enabled
    ? 'Remote off'
    : online
      ? `Remote on, ${count > 0 ? `${count} ${count === 1 ? 'device' : 'devices'}` : 'no devices'}`
      : 'Remote connecting'
  const summary = `${text}. Open Remote settings`
  return <button type="button" className={`remote-chip ${status.enabled ? 'on' : 'off'}`} data-tour="remote" aria-label={summary} title={summary} onClick={onOpen}>
    <StatusDot status={status.enabled ? 'working' : 'waiting'} label={text} className="remote-chip-dot" />
    <span className="remote-chip-text">{text}</span>
  </button>
}
