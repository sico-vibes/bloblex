import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import { labelize } from '../types'
import type { AgentDraft, BotSection, FieldErrors } from './agentForm'
import { applyTemplate, BOT_TEMPLATES } from './botTemplates'
import './botWizard.css'

const STEPS = [
  { id: 'start', title: 'Start from', blurb: 'Pick a starting point. Everything can be changed later.' },
  { id: 'name', title: 'Name it', blurb: 'A name teammates and you will recognise.' },
  { id: 'brain', title: 'Choose its brain', blurb: 'Which coding agent and model it works with, and how it should behave.' },
  { id: 'access', title: 'Access and look', blurb: 'How much it may do without asking, and how it appears.' },
  { id: 'review', title: 'Review', blurb: 'One last look before it joins your team.' },
] as const
type StepId = typeof STEPS[number]['id']

const SECTIONS_FOR: Partial<Record<StepId, BotSection[]>> = {
  name: ['profile', 'team'],
  brain: ['model'],
  access: ['permissions', 'look'],
}

/** Which draft errors block moving on from a step. */
function blockedBy(step: StepId, errors: FieldErrors): string | null {
  if (step === 'name') return errors.name ?? errors.description ?? null
  if (step === 'brain') return errors.runtimeId ?? errors.instructions ?? null
  if (step === 'access') return errors.color ?? null
  return null
}

/**
 * Guided creation: start from a template, name it, choose its brain, set
 * access and look, review. It edits the same draft and renders the same field
 * groups as the full form (through `renderSections`), so nothing is duplicated
 * and "Show all settings" is just the long form.
 */
export function BotWizard({ draft, errors, noun, ready, saving, providerName, onDraftChange, renderSections, onCreate, onAdvanced, onCancel }: {
  draft: AgentDraft
  errors: FieldErrors
  noun: string
  ready: boolean
  saving: boolean
  providerName: string
  onDraftChange: (draft: AgentDraft) => void
  renderSections: (sections: BotSection[]) => ReactNode
  onCreate: () => void
  onAdvanced: () => void
  onCancel: () => void
}) {
  const [index, setIndex] = useState(0)
  const [templateId, setTemplateId] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const step = STEPS[index]!
  const blocker = blockedBy(step.id, errors)
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }) }, [index])
  const next = () => { if (!blocker && index < STEPS.length - 1) setIndex(index + 1) }
  const back = () => { if (index > 0) setIndex(index - 1) }
  const pick = (id: string) => {
    const template = BOT_TEMPLATES.find((item) => item.id === id)
    if (!template) return
    setTemplateId(id)
    onDraftChange(applyTemplate(draft, template))
    setIndex(1)
  }

  return <section className="bot-wizard" aria-label={`New ${noun}`}>
    <ol className="bot-wizard-steps" aria-label="Steps">
      {STEPS.map((item, position) => <li key={item.id} className={position === index ? 'on' : position < index ? 'done' : ''} aria-current={position === index ? 'step' : undefined}>
        <button type="button" disabled={position > index} onClick={() => setIndex(position)}><span className="bot-wizard-dot">{position < index ? <Check size={11} aria-hidden="true" /> : position + 1}</span><span>{item.title}</span></button>
      </li>)}
    </ol>

    <header className="bot-wizard-head">
      <h2 tabIndex={-1} ref={headingRef}>{step.title}</h2>
      <p>{step.blurb}</p>
    </header>

    {step.id === 'start' && <div className="bot-wizard-templates" role="list">
      {BOT_TEMPLATES.map((template) => <button key={template.id} type="button" role="listitem" className={`bot-template ${templateId === template.id ? 'on' : ''}`} onClick={() => pick(template.id)}>
        <strong>{template.name}</strong>
        <small>{template.tagline}</small>
      </button>)}
    </div>}

    {SECTIONS_FOR[step.id] && <div className="bot-wizard-body">{renderSections(SECTIONS_FOR[step.id]!)}</div>}

    {step.id === 'review' && <dl className="bot-wizard-review">
      <div><dt>Name</dt><dd>{draft.name.trim() || '—'}{draft.role.trim() && <span className="bot-wizard-role">{draft.role.trim()}</span>}</dd></div>
      <div><dt>Description</dt><dd>{draft.description.trim() || 'None'}</dd></div>
      <div><dt>Brain</dt><dd>{providerName}{draft.model ? ` · ${draft.model}` : ' · default model'}{draft.thinking ? ` · ${labelize(draft.thinking)} effort` : ''}</dd></div>
      <div><dt>Instructions</dt><dd>{draft.instructions.trim() ? `${draft.instructions.trim().split(/\s+/).length} words` : 'None yet'}</dd></div>
      <div><dt>Approvals</dt><dd>{draft.approvalMode === 'auto' ? 'Auto-approve' : draft.approvalMode === 'accept_edits' ? 'Auto-accept edits' : draft.approvalMode === 'bypass' ? 'Full access' : 'Ask first'}</dd></div>
    </dl>}

    {blocker && <p className="bot-wizard-block" role="alert">{blocker}</p>}
    {step.id === 'review' && !ready && !blocker && <p className="bot-wizard-block" role="alert">Something above still needs attention. Go back and check the highlighted fields.</p>}

    <footer className="bot-wizard-foot">
      <button type="button" className="ghost-button small" onClick={index === 0 ? onCancel : back}>{index === 0 ? 'Cancel' : <><ArrowLeft size={13} aria-hidden="true" />Back</>}</button>
      <button type="button" className="ghost-button small bot-wizard-advanced" onClick={onAdvanced}>Show all settings</button>
      {step.id === 'review'
        ? <button type="button" className="primary-button" disabled={!ready || saving} onClick={onCreate}>{saving ? 'Creating…' : `Create ${noun}`}</button>
        : step.id === 'start'
          ? <button type="button" className="secondary-button small" onClick={() => pick('blank')}>Start blank</button>
          : <button type="button" className="primary-button small" disabled={!!blocker} onClick={next}>Next<ArrowRight size={13} aria-hidden="true" /></button>}
    </footer>
  </section>
}
