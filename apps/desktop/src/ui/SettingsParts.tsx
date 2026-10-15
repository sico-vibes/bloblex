import type { ReactNode } from 'react'

/** A titled group of rows in a rounded card. Shared by Settings pages. */
export function SettingsGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="settings-group">
    <div className="settings-group-head"><h3>{title}</h3>{action}</div>
    <div className="settings-card">{children}</div>
  </section>
}

export function SettingsRow({ label, hint, children, stacked = false }: { label: ReactNode; hint?: string; children?: ReactNode; stacked?: boolean }) {
  return <div className={stacked ? 'settings-row stacked' : 'settings-row'}>
    <span className="settings-row-copy"><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
    {children && <span className="settings-row-control">{children}</span>}
  </div>
}
