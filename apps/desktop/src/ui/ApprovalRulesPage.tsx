// Settings → Approvals: the "Always allow" rules saved from approval cards, per bot,
// each removable. The daemon owns them (`permission.rules.list` / `.update` / `.delete`)
// and applies them only in a bot's own attended conversations, never in Plan mode.
// Phase 1A: a rule is for one project or for every project, and can be moved between them.
import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { Agent, Project } from '../types'
import { listenForDaemonEvents, rpc } from '../tauri'
import { SettingsGroup, SettingsRow } from './SettingsParts'
import { Select } from './Select'

export type ApprovalRule = { id: string; agentId: string; kind: string; label: string; createdAt?: string; projectId?: string | null; projectName?: string | null }

function isRule(value: unknown): value is ApprovalRule {
  const rule = value as Partial<ApprovalRule> | null
  return !!rule && typeof rule.id === 'string' && typeof rule.agentId === 'string' && typeof rule.label === 'string'
}

export function ApprovalRulesPage({ agents, projects = [] }: { agents: Agent[]; projects?: readonly Project[] }) {
  const [rules, setRules] = useState<ApprovalRule[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const load = useCallback(() => rpc<{ rules?: unknown[] }>('permission.rules.list', {})
    .then((result) => { setRules((result?.rules ?? []).filter(isRule)); setProblem(null) })
    .catch(() => { setRules([]); setProblem('Saved approvals could not be read.') }), [])
  useEffect(() => {
    void load()
    let stop: (() => void) | undefined
    let live = true
    void listenForDaemonEvents((event) => { if (event.type === 'permission.rules.changed') void load() }).then((unlisten) => { if (live) stop = unlisten; else unlisten() })
    return () => { live = false; stop?.() }
  }, [load])
  const remove = async (rule: ApprovalRule) => {
    setRemoving(rule.id)
    try { await rpc('permission.rules.delete', { id: rule.id }); setRules((current) => current?.filter((item) => item.id !== rule.id) ?? current) }
    catch { setProblem('That approval could not be removed. Try again.') }
    finally { setRemoving(null) }
  }
  const rescope = async (rule: ApprovalRule, projectId: string | null) => {
    setRemoving(rule.id)
    try { await rpc('permission.rules.update', projectId ? { id: rule.id, scope: 'project', projectId } : { id: rule.id, scope: 'bot' }); await load() }
    catch { setProblem('That approval could not be changed. Try again.') }
    finally { setRemoving(null) }
  }
  const nameOf = (agentId: string) => agents.find((agent) => agent.id === agentId)?.name ?? 'A removed bot'
  const byBot = new Map<string, ApprovalRule[]>()
  for (const rule of rules ?? []) byBot.set(rule.agentId, [...(byBot.get(rule.agentId) ?? []), rule])
  return <div className="approval-rules-page">
    <SettingsGroup title="Always allowed">
      <p className="settings-empty">When you choose Always allow on an approval, that bot can do the same thing again without asking, in that project or in every project. It applies in the bot's own conversations, never in Plan mode or scheduled runs.</p>
      {problem && <p className="settings-empty" role="alert">{problem}</p>}
      {rules === null ? <p className="settings-empty" role="status">Reading saved approvals…</p>
        : rules.length === 0 ? <p className="settings-empty">Nothing is always allowed yet.</p>
        : [...byBot].map(([agentId, items]) => <SettingsRow key={agentId} label={nameOf(agentId)} stacked>
          <ul className="approval-rule-list">{items.map((rule) => <li key={rule.id}>
            <span className="approval-rule-label">{rule.label}</span>
            {/* Phase 1A: a daemon that scopes rules always sends projectId (null for every project); an older one can't rescope. */}
            {'projectId' in rule && <Select ariaLabel={`Where ${nameOf(agentId)} may always ${rule.label}`} variant="muted" value={rule.projectId ?? ''} disabled={removing === rule.id} onChange={(value) => void rescope(rule, value || null)} options={[
              { value: '', label: 'Every project' },
              ...(rule.projectId && !projects.some((project) => project.id === rule.projectId) ? [{ value: rule.projectId, label: rule.projectName ?? 'A removed project' }] : []),
              ...projects.map((project) => ({ value: project.id, label: `Only ${project.name}` })),
            ]} />}
            <button type="button" className="ghost-button small" disabled={removing === rule.id} aria-label={`Stop always allowing ${rule.label} for ${nameOf(agentId)}`} onClick={() => void remove(rule)}><Trash2 size={13} aria-hidden="true" />Remove</button>
          </li>)}</ul>
        </SettingsRow>)}
    </SettingsGroup>
  </div>
}
