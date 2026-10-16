// The Skills group on the bot page: every skill in the shared pool with a
// switch for this bot. A switch writes at once (`skills.toggle` with the bot's
// id); it is not part of the page's draft and save bar.
import { useCallback, useEffect, useState } from 'react'
import { rpc } from '../tauri'
import { SettingsRow } from './SettingsParts'
import { Skeleton } from './Skeleton'
import { isSkillRow, type SkillRow } from './SkillsPage'
import { useEntityNoun } from './vocabulary'
import './skills.css'

export const SKILLS_SECTION_ID = 'skills'

/** Whether this bot sees a skill: on in the pool and not switched off for it. */
export function skillOnForBot(skill: SkillRow, agentId: string): boolean {
  return skill.enabled && !(skill.disabledFor ?? []).includes(agentId)
}

export function BotSkillsGroup({ agentId, onOpenSkills }: { agentId: string; onOpenSkills?: () => void }) {
  const noun = useEntityNoun()
  const [skills, setSkills] = useState<SkillRow[] | null>(null)
  const [poolOn, setPoolOn] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [list, settings] = await Promise.all([
        rpc<{ skills?: unknown[] }>('skills.list'),
        rpc<Record<string, unknown>>('settings.get').catch((): Record<string, unknown> => ({})),
      ])
      const values: Record<string, unknown> = (settings as { settings?: Record<string, unknown> }).settings ?? settings
      setPoolOn(values['skills.enabled'] !== false)
      setSkills((Array.isArray(list.skills) ? list.skills : []).filter(isSkillRow))
      setProblem(null)
    } catch (reason) {
      setSkills([])
      setProblem(reason instanceof Error ? reason.message : 'Skills could not be loaded.')
    }
  }, [])
  useEffect(() => { if (agentId) void load() }, [agentId, load])

  const toggle = async (skill: SkillRow) => {
    setPending(skill.name)
    setProblem(null)
    try {
      await rpc('skills.toggle', { name: skill.name, enabled: !skillOnForBot(skill, agentId), agentId })
      await load()
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : 'That skill could not be changed.')
    } finally { setPending(null) }
  }

  return <section id={`bot-section-${SKILLS_SECTION_ID}`} className="settings-group blob-group" aria-label="Skills">
    <div className="settings-group-head">
      <h3>Skills</h3>
      {onOpenSkills && <button type="button" className="link-button bot-memory-link" onClick={onOpenSkills}>Open in Settings › Skills</button>}
    </div>
    <div className="settings-card">
      {skills === null && <div className="bot-skills-note"><Skeleton lines={2} /></div>}
      {skills !== null && !poolOn && <p className="bot-skills-note">Skills are off for every {noun}. Turn them on in Settings › Skills.</p>}
      {skills !== null && poolOn && skills.length === 0 && !problem && <p className="bot-skills-note">No shared skills yet. Import some in Settings › Skills.</p>}
      {skills !== null && poolOn && skills.length > 0 && <div className="bot-skills-list">
        {skills.map((skill) => {
          const on = skillOnForBot(skill, agentId)
          return <SettingsRow key={skill.name} label={skill.name} hint={skill.description} detail={skill.enabled ? undefined : 'Off for every ' + noun}>
            <button type="button" className={`toggle ${on ? 'on' : ''}`} role="switch" aria-label={`Let this ${noun} use ${skill.name}`} aria-checked={on} disabled={!skill.enabled || pending !== null} onClick={() => void toggle(skill)}><i /></button>
          </SettingsRow>
        })}
      </div>}
      {problem && <p className="blob-error bot-skills-note" role="alert">{problem}</p>}
    </div>
  </section>
}
