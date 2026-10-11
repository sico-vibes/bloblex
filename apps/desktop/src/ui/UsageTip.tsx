import { Gauge, X } from 'lucide-react'
import { usageTipCopy, type UsageTip as UsageTipModel } from './usageTips'

export function UsageTip({ tip, onDismiss, onViewUsage }: { tip: UsageTipModel; onDismiss: () => void; onViewUsage?: () => void }) {
  return <div className="usage-tip" role="status" aria-label={`${tip.providerName} usage tip`}>
    <Gauge size={15} aria-hidden="true" />
    <span className="usage-tip-copy">{usageTipCopy(tip)}</span>
    {onViewUsage && <button type="button" className="usage-tip-view" onClick={onViewUsage}>View usage</button>}
    <button type="button" className="usage-tip-dismiss" aria-label="Dismiss usage tip" title="Dismiss usage tip" onClick={onDismiss}><X size={14} aria-hidden="true" /></button>
  </div>
}
