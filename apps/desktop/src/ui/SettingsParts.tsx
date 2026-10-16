import type { ReactNode } from 'react'
import { CircleHelp } from 'lucide-react'

/** A titled group of rows in a rounded card. Shared by Settings pages. */
export function SettingsGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="settings-group">
    <div className="settings-group-head"><h3>{title}</h3>{action}</div>
    <div className="settings-card">{children}</div>
  </section>
}

/**
 * A "?" that explains something on hover or keyboard focus. Explanations live
 * here rather than as a line of small print under every title.
 */
export function HelpTip({ text, id, align = 'center', placement = 'top' }: { text: ReactNode; id?: string; align?: 'center' | 'start' | 'end'; placement?: 'top' | 'bottom' }) {
  return <span className={`help-tip align-${align} place-${placement}`}>
    <button type="button" className="help-tip-trigger" aria-label="What does this do?"><CircleHelp size={14} aria-hidden="true" /></button>
    <span className="help-tip-bubble" role="tooltip" id={id}>{text}</span>
  </span>
}

/**
 * The title side of a row: the label, then a "?" for its explanation.
 * `detail` is for live values (a version, a folder, a status) that stay visible.
 */
export function RowCopy({ label, hint, hintId, detail, tipAlign = 'center' }: { label: ReactNode; hint?: ReactNode; hintId?: string; detail?: ReactNode; tipAlign?: 'center' | 'start' | 'end' }) {
  return <span className="settings-row-copy">
    <span className="settings-row-title"><strong>{label}</strong>{hint && <HelpTip text={hint} id={hintId} align={tipAlign} />}</span>
    {detail && <small>{detail}</small>}
  </span>
}

export function SettingsRow({ label, hint, detail, children, stacked = false }: { label: ReactNode; hint?: ReactNode; detail?: ReactNode; children?: ReactNode; stacked?: boolean }) {
  return <div className={stacked ? 'settings-row stacked' : 'settings-row'}>
    <RowCopy label={label} hint={hint} detail={detail} />
    {children && <span className="settings-row-control">{children}</span>}
  </div>
}
