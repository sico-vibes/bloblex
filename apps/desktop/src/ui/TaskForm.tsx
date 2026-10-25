// The task form: every field the daemon lets the owner set on a draft (text, images, project, bot, when it runs, time limit).
// One form serves "New task" and editing a draft, so the two cannot drift apart.
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { ImagePlus } from 'lucide-react'
import type { Agent, BoardTask, Project } from '../types'
import { stagePromptAttachment } from '../tauri'
import { rpcFailure } from '../executionContract'
import { AttachmentTray, MAX_COMPOSER_ATTACHMENTS, prepareImageBytes, type ComposerAttachment } from './ComposerControls'
import { ScheduleWhen } from './ScheduleWhen'
import { Select } from './Select'
import { defaultDraft, draftToSchedule, localTimeZone, scheduleToDraft, type ScheduleDraft, type SchedulePreset } from './automationSchedule'
import { previewSchedule } from './schedulePreview'
import { SCHEDULE_DISCLAIMER, SCHEDULE_OUTCOME_LABEL, TIME_LIMIT_CHOICES, assignableAgents } from './taskModel'
import type { TaskInput } from './useTasks'

type When = 'now' | 'once' | 'repeat'
type ImageDraft = ComposerAttachment & { storedId?: string }

const REPEAT_PRESETS: readonly SchedulePreset[] = ['daily', 'weekdays', 'weekly', 'hours', 'custom']
const WHEN_OPTIONS: ReadonlyArray<{ value: When; label: string }> = [{ value: 'now', label: 'Now' }, { value: 'once', label: 'Once' }, { value: 'repeat', label: 'Repeat' }]

function initialWhen(task: BoardTask | null | undefined): When {
  return task?.schedule?.kind === 'once' ? 'once' : task?.schedule?.kind === 'cron' ? 'repeat' : 'now'
}

export function TaskForm({ task, agents, projects, connected, heading, headingId, submitLabel, startLabel, onCancel, onSubmit, loadImage, onDiscard }: {
  task?: BoardTask | null
  agents: readonly Agent[]
  projects: readonly Project[]
  connected: boolean
  heading: string
  headingId: string
  submitLabel: string
  /** Shown instead of `submitLabel` while "Now" and a bot are chosen: saving also starts the task. */
  startLabel: string
  onCancel: () => void
  /** `start` is the bot to hand the task to straight away ("Now" with a bot chosen), else null. */
  onSubmit: (input: TaskInput, start: Agent | null) => Promise<void>
  loadImage?: (taskId: string, imageId: string) => Promise<string>
  /** Drops the draft (only an existing task has one). */
  onDiscard?: () => Promise<void>
}) {
  const bots = useMemo(() => assignableAgents(agents), [agents])
  const [title, setTitle] = useState(task?.title ?? '')
  const [brief, setBrief] = useState(task?.brief ?? '')
  const [doneGoal, setDoneGoal] = useState(task?.doneGoal ?? '')
  const [reportBack, setReportBack] = useState(task?.reportBack ?? '')
  const [projectId, setProjectId] = useState(task?.projectId ?? '')
  const [botId, setBotId] = useState(task?.scheduleAgentId ?? task?.assigneeAgentId ?? '')
  const [when, setWhen] = useState<When>(initialWhen(task))
  const [draft, setDraft] = useState<ScheduleDraft>(() => task?.schedule ? scheduleToDraft(task.schedule.kind === 'once' ? { kind: 'once', at: task.schedule.at } : task.schedule) : { ...defaultDraft(localTimeZone()), preset: 'daily' })
  const [limit, setLimit] = useState(String(task?.maxRuntimeSecs ?? 1800))
  const [estimate, setEstimate] = useState(task?.estimateMinutes ? String(task.estimateMinutes) : '')
  const [images, setImages] = useState<ImageDraft[]>(() => (task?.images ?? []).map((image) => ({ id: `stored:${image.id}`, storedId: image.id, name: image.name, previewUrl: '', path: null, status: 'ready' as const })))
  const imagesRef = useRef(images)
  imagesRef.current = images
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // Kept images show their stored thumbnail; each is fetched once.
  const taskId = task?.id
  useEffect(() => {
    if (!taskId || !loadImage) return
    let live = true
    for (const image of images) {
      if (!image.storedId || image.previewUrl) continue
      void loadImage(taskId, image.storedId).then((url) => { if (live) setImages((current) => current.map((item) => item.id === image.id ? { ...item, previewUrl: url } : item)) }).catch(() => undefined)
    }
    return () => { live = false }
  }, [taskId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { for (const image of imagesRef.current) if (image.previewUrl.startsWith('blob:')) URL.revokeObjectURL(image.previewUrl) }, [])

  const addFiles = (files: File[]) => {
    const pictures = files.filter((file) => file.type.startsWith('image/'))
    if (files.length && !pictures.length) { setFailure('Only images can be attached.'); return }
    const room = Math.max(0, MAX_COMPOSER_ATTACHMENTS - imagesRef.current.length)
    if (pictures.length > room) setFailure(`A task can include up to ${MAX_COMPOSER_ATTACHMENTS} images.`)
    else setFailure(null)
    for (const file of pictures.slice(0, room)) {
      const id = `new:${Date.now()}-${Math.random().toString(36).slice(2)}`
      const name = file.name && file.name !== 'image.png' ? file.name : `Pasted image ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.png`
      setImages((current) => [...current, { id, name, previewUrl: URL.createObjectURL(file), path: null, status: 'staging' }])
      void prepareImageBytes(file).then(stagePromptAttachment).then((path) => {
        setImages((current) => current.map((item) => item.id === id ? { ...item, path, status: 'ready' } : item))
      }).catch((reason) => {
        setImages((current) => current.map((item) => item.id === id ? { ...item, status: 'error', error: reason instanceof Error ? reason.message : String(reason) } : item))
      })
    }
  }
  const removeImage = (id: string) => setImages((current) => current.filter((item) => { if (item.id === id && item.previewUrl.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl); return item.id !== id }))
  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
    if (files.length) { event.preventDefault(); addFiles(files) }
  }
  const onDrop = (event: DragEvent<HTMLElement>) => {
    const files = Array.from(event.dataTransfer.files)
    if (files.length) { event.preventDefault(); addFiles(files) }
  }

  const schedule = useMemo(() => when === 'now' ? null : draftToSchedule(draft), [when, draft])
  const bot = bots.find((agent) => agent.id === botId) ?? null
  const staging = images.some((item) => item.status === 'staging')
  const brokenImage = images.some((item) => item.status === 'error')
  const timed = when !== 'now'
  const estimateNumber = estimate.trim() ? Number(estimate) : null
  const estimateOk = estimateNumber === null || (Number.isInteger(estimateNumber) && estimateNumber >= 1 && estimateNumber <= 10080)
  const valid = title.trim().length > 0 && title.trim().length <= 120 && brief.length <= 12000 && estimateOk && (!timed || (!!schedule && !!bot)) && !staging && !brokenImage
  const hint = !title.trim() ? null : staging ? 'Preparing your images…' : brokenImage ? 'Remove the image that could not be attached.' : timed && !bot ? 'Choose the bot that runs this task.' : timed && !schedule ? 'Choose a valid time.' : !estimateOk ? 'Estimate is a whole number of minutes.' : null
  const limitOptions = TIME_LIMIT_CHOICES.some((choice) => String(choice.value) === limit) ? TIME_LIMIT_CHOICES : [...TIME_LIMIT_CHOICES, { value: Number(limit), label: `${Math.round(Number(limit) / 60)} minutes` }]

  const submit = async () => {
    if (!valid || saving) return
    setSaving(true); setFailure(null)
    const input: TaskInput = {
      title: title.trim(), brief: brief.trim(), doneGoal: doneGoal.trim(), reportBack: reportBack.trim(), projectId: projectId || null,
      estimateMinutes: estimateNumber, maxRuntimeSecs: Number(limit),
      attachments: images.filter((item) => item.status === 'ready').map((item) => item.storedId ? { id: item.storedId } : { path: item.path as string, name: item.name }),
      schedule: timed ? schedule : null, scheduleAgentId: timed ? botId : null,
    }
    try { await onSubmit(input, !timed && bot ? bot : null) }
    catch (reason) { setFailure(rpcFailure(reason).message); setSaving(false) }
  }
  const switchWhen = (next: When) => {
    setWhen(next)
    setDraft((current) => next === 'once' ? { ...current, preset: 'once' } : next === 'repeat' && current.preset === 'once' ? { ...current, preset: 'daily' } : current)
  }

  return <div className="task-form" onPaste={onPaste} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={onDrop}>
    <h2 id={headingId}>{heading}</h2>
    <label className="blob-field"><span>Title</span><input data-dialog-initial-focus value={title} maxLength={120} placeholder="Write the release notes" onChange={(event) => setTitle(event.target.value)} /></label>
    <label className="blob-field"><span>What needs doing<small className={brief.length > 12000 ? 'over' : ''}>{brief.length}/12000</small></span><textarea rows={4} value={brief} placeholder="Summarise what changed since the last release for the changelog." onChange={(event) => setBrief(event.target.value)} /></label>
    <label className="blob-field"><span>Done when</span><input value={doneGoal} maxLength={4000} placeholder="A draft is in docs/releases" onChange={(event) => setDoneGoal(event.target.value)} /></label>
    <label className="blob-field"><span>Report back</span><input value={reportBack} maxLength={4000} placeholder="A short summary and the files changed" onChange={(event) => setReportBack(event.target.value)} /></label>
    <div className="blob-field"><span>Images</span>
      <div className="task-images">
        <AttachmentTray attachments={images} onRemove={removeImage} />
        <button type="button" className="secondary-button small task-add-image" disabled={images.length >= MAX_COMPOSER_ATTACHMENTS} onClick={() => fileInput.current?.click()}><ImagePlus size={14} aria-hidden="true" />Add image</button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden tabIndex={-1} aria-hidden="true" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (files.length) addFiles(files) }} />
      </div>
      <small className="task-hint">Choose, paste or drop up to {MAX_COMPOSER_ATTACHMENTS} images. They go to the bot with the task.</small>
    </div>
    <div className="task-field-row">
      <div className="blob-field"><span>Project</span><Select ariaLabel="Project" variant="field" value={projectId} placeholder="No project" onChange={setProjectId} options={[{ value: '', label: 'No project' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} /></div>
      <div className="blob-field"><span>Bot</span><Select ariaLabel="Bot" variant="field" value={botId} placeholder="Choose later" onChange={setBotId} options={[...(timed ? [] : [{ value: '', label: 'Choose later' }]), ...bots.map((agent) => ({ value: agent.id, label: agent.name }))]} /></div>
    </div>
    <div className="blob-field"><span>When</span>
      <div className="segmented" role="radiogroup" aria-label="When it runs">{WHEN_OPTIONS.map((option) => <button key={option.value} type="button" role="radio" aria-checked={when === option.value} className={when === option.value ? 'on' : undefined} onClick={() => switchWhen(option.value)}>{option.label}</button>)}</div>
      {when === 'now' ? <small className="task-hint">Runs when you give it to a bot{bot ? `, which is right away for ${bot.name}` : ''}.</small>
        : <ScheduleWhen draft={draft} onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} schedule={schedule} onPreview={previewSchedule} presets={when === 'once' ? ['once'] : REPEAT_PRESETS} />}
      {timed && <small className="task-disclaimer">{SCHEDULE_DISCLAIMER}</small>}
      {timed && task?.scheduleLastOutcome && <small className="task-hint">Last time: {SCHEDULE_OUTCOME_LABEL[task.scheduleLastOutcome] ?? task.scheduleLastOutcome}.</small>}
    </div>
    <div className="task-field-row">
      <div className="blob-field"><span>Stop a run after</span><Select ariaLabel="Stop a run after" variant="field" value={limit} onChange={setLimit} options={limitOptions.map((choice) => ({ value: String(choice.value), label: choice.label }))} /></div>
      <label className="blob-field"><span>Estimate (minutes)</span><input inputMode="numeric" value={estimate} placeholder="Optional" onChange={(event) => setEstimate(event.target.value.replace(/[^0-9]/g, ''))} /></label>
    </div>
    {failure && <p className="tasks-problem" role="alert">{failure}</p>}
    {hint && <p className="task-hint" role="status">{hint}</p>}
    <div className="blob-dialog-actions task-actions">
      {onDiscard && <button type="button" className="secondary-button task-discard" disabled={saving} onClick={() => { setSaving(true); setFailure(null); void onDiscard().catch((reason) => { setFailure(rpcFailure(reason).message); setSaving(false) }) }}>Discard task</button>}
      <button type="button" className="secondary-button" onClick={onCancel}>Cancel</button>
      <button type="button" className="primary-button" disabled={!valid || saving || !connected} onClick={() => void submit()}>{saving ? 'Saving…' : !timed && bot ? startLabel : submitLabel}</button>
    </div>
  </div>
}
