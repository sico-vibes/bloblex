// Phase 4: Settings > Machines. This machine's name, and the other machines linked to it.
// Linking uses the other machine's Remote: its owner shows a code or signs in, and approves
// this machine there. A password is sent once and never kept.
import { useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, Laptop, LoaderCircle, Pencil, RefreshCw, X } from 'lucide-react'
import { rpc } from '../tauri'
import { ConfirmDialog } from './BlobPage'
import { SettingsGroup, SettingsRow } from './SettingsParts'
import { machineStateWord, machineUrlProblem, useMachines, type Machine, type MachineProbe, type PairJob } from './machines'
import { useEntityNoun } from './vocabulary'
import './machines.css'

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : typeof reason === 'string' && reason ? reason : fallback
const TIER_WORD: Record<Machine['tier'], string> = { viewer: 'can read', chat: 'can read', operator: 'can read and take over' }

function ThisMachine() {
  const [self, setSelf] = useState<{ id: string; name: string; version: string } | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void rpc<{ id: string; name: string; version: string }>('machine.self', {}).then((reply) => { if (live) setSelf(reply) }).catch(() => undefined)
    return () => { live = false }
  }, [])
  const save = async () => {
    const name = draft.trim()
    setEditing(false)
    if (!name || name === self?.name) return
    try { setSelf(await rpc<{ id: string; name: string; version: string }>('machine.self.rename', { name })); setProblem(null) }
    catch (reason) { setProblem(messageOf(reason, 'That name could not be saved.')) }
  }
  return <SettingsGroup title="This machine">
    <SettingsRow label={editing ? 'Name' : self?.name ?? 'This machine'} hint="Other machines show your bots under this name.">
      {editing
        ? <input className="text-input machine-name-input" aria-label="This machine's name" value={draft} maxLength={60} autoFocus onChange={(event) => setDraft(event.target.value)} onBlur={() => void save()} onKeyDown={(event) => { if (event.key === 'Enter') void save(); if (event.key === 'Escape') setEditing(false) }} />
        : <button type="button" className="secondary-button small" disabled={!self} onClick={() => { setDraft(self?.name ?? ''); setEditing(true) }}><Pencil size={13} aria-hidden="true" />Rename</button>}
    </SettingsRow>
    {problem && <p className="new-project-error" role="alert">{problem}</p>}
  </SettingsGroup>
}

function MachineRow({ machine, onRename, onRemove, onRefresh }: { machine: Machine; onRename: (name: string) => void; onRemove: () => void; onRefresh: () => void }) {
  const nouns = useEntityNoun({ plural: true })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(machine.name)
  const save = () => { const name = draft.trim(); setEditing(false); if (name && name !== machine.name) onRename(name) }
  return <div className="machine-row">
    <span className="remote-device-icon" aria-hidden="true"><Laptop size={16} /></span>
    <span className="machine-row-copy">
      {editing
        ? <input className="remote-rename" aria-label={`Name for ${machine.name}`} value={draft} maxLength={60} autoFocus onChange={(event) => setDraft(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === 'Enter') save(); if (event.key === 'Escape') { setDraft(machine.name); setEditing(false) } }} />
        : <strong>{machine.name}</strong>}
      <small><span className={`machine-state ${machine.state}`}><i aria-hidden="true" />{machineStateWord(machine)}</span> · {machine.bots.length} {nouns} · This machine {TIER_WORD[machine.tier]}</small>
      {machine.detail && <small className="machine-row-detail">{machine.detail}</small>}
    </span>
    {!editing && <button type="button" className="icon-button" aria-label={`Rename ${machine.name}`} title="Rename" onClick={() => { setDraft(machine.name); setEditing(true) }}><Pencil size={14} aria-hidden="true" /></button>}
    <button type="button" className="icon-button" aria-label={`Check ${machine.name} now`} title="Check now" onClick={onRefresh}><RefreshCw size={14} aria-hidden="true" /></button>
    <button type="button" className="icon-button" aria-label={`Remove ${machine.name}`} title="Remove" onClick={onRemove}><X size={15} aria-hidden="true" /></button>
  </div>
}

/** Address, then a code or a password, then waiting for the other machine's owner. */
export function PairMachine({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [url, setUrl] = useState('')
  const [probe, setProbe] = useState<MachineProbe | null>(null)
  const [code, setCode] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [matches, setMatches] = useState(false)
  const [job, setJob] = useState<PairJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const passwordRef = useRef('')
  passwordRef.current = password
  const urlProblem = url.trim() ? machineUrlProblem(url) : null
  const jobId = job?.state === 'pending' ? job.id : null

  useEffect(() => {
    if (!jobId) return
    const timer = window.setInterval(() => {
      void rpc<{ jobs?: PairJob[] }>('machine.pair.list', {}).then((reply) => {
        const next = reply?.jobs?.find((item) => item.id === jobId)
        if (next) setJob(next)
      }).catch(() => undefined)
    }, 1500)
    return () => window.clearInterval(timer)
  }, [jobId])

  const check = async () => {
    const reason = machineUrlProblem(url)
    if (reason) { setProblem(reason); return }
    setBusy(true); setProblem(null)
    try {
      const reply = await rpc<MachineProbe>('machine.probe', { url: url.trim() })
      if (!reply.reachable) setProblem('That address can\'t be reached. Check that Remote is on over there.')
      else if (!reply.isBitbots) setProblem('That address isn\'t a Bitbots machine.')
      else setProbe(reply)
    } catch (reason) { setProblem(messageOf(reason, 'That address could not be checked.')) } finally { setBusy(false) }
  }

  const start = async () => {
    if (!probe) return
    setBusy(true); setProblem(null)
    try {
      const params = probe.auth === 'code' ? { url: url.trim(), code: code.trim(), confirm: true } : { url: url.trim(), username: username.trim(), password, fingerprint: probe.fingerprint, confirm: true }
      const reply = await rpc<{ job: PairJob }>('machine.pair.begin', params)
      setPassword('')
      setJob(reply.job)
    } catch (reason) { setProblem(messageOf(reason, 'Pairing could not start.')) } finally { setBusy(false) }
  }

  const cancel = () => {
    if (jobId) void rpc('machine.pair.cancel', { id: jobId }).catch(() => undefined)
    onCancel()
  }

  if (job) {
    const done = job.state === 'approved'
    const pending = job.state === 'pending'
    const word = job.state === 'rejected' ? 'The other machine said no.' : job.state === 'expired' ? 'Nobody answered in time. Try again.' : job.state === 'cancelled' ? 'Cancelled.' : job.detail ?? 'Pairing failed.'
    return <div className="machine-pair" role="status">
      <p className="machine-pair-state">
        {pending ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : done ? <CircleCheck size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
        <span>{pending ? 'Waiting for approval. On the other machine, open Settings, Remote, and approve this one. Choose Chat and approve if you want to take conversations over.' : done ? `${job.machine?.name ?? 'The other machine'} is linked.` : word}</span>
      </p>
      <div className="machine-pair-actions">
        {pending && <button type="button" className="ghost-button small" onClick={cancel}>Cancel</button>}
        {!pending && !done && <button type="button" className="ghost-button small" onClick={() => setJob(null)}>Try again</button>}
        {!pending && <button type="button" className="primary-button small" onClick={done ? onDone : onCancel}>Done</button>}
      </div>
    </div>
  }

  if (!probe) return <form className="machine-pair" onSubmit={(event) => { event.preventDefault(); void check() }}>
    <label className="new-project-field"><span>The other machine's address</span>
      <input className="text-input" value={url} spellCheck={false} autoFocus placeholder="https://work-laptop.example.ts.net" aria-invalid={!!urlProblem} onChange={(event) => { setUrl(event.target.value); setProblem(null) }} />
      <small className="project-settings-note">On the other machine, open Settings, Remote, and turn it on. Its address is shown there.</small>
    </label>
    {(urlProblem || problem) && <p className="new-project-error" role="alert">{urlProblem ?? problem}</p>}
    <div className="machine-pair-actions">
      <button type="button" className="ghost-button small" onClick={onCancel}>Cancel</button>
      <button type="submit" className="primary-button small" disabled={busy || !url.trim() || !!urlProblem}>{busy ? 'Checking…' : 'Continue'}</button>
    </div>
  </form>

  const ready = probe.auth === 'code' ? !!code.trim() : !!username.trim() && !!password && matches
  return <form className="machine-pair" onSubmit={(event) => { event.preventDefault(); if (ready) void start() }}>
    {probe.auth === 'code'
      ? <label className="new-project-field"><span>Pairing code</span>
        <input className="text-input machine-code" value={code} spellCheck={false} autoFocus autoComplete="off" placeholder="K7QM-4XPD" onChange={(event) => setCode(event.target.value)} />
        <small className="project-settings-note">On the other machine, open Settings, Remote, and choose Show pairing code.</small>
      </label>
      : <>
        <div className="machine-fingerprint">
          <span>Certificate fingerprint</span>
          <code>{probe.fingerprint}</code>
          <small className="project-settings-note">Compare this with the fingerprint in Settings, Remote, on the other machine. If they differ, stop: something is between the two.</small>
          <label className="new-project-check"><input type="checkbox" checked={matches} onChange={(event) => setMatches(event.target.checked)} /><span>It's the same on both machines</span></label>
        </div>
        <label className="new-project-field"><span>Username</span><input className="text-input" value={username} spellCheck={false} autoComplete="off" onChange={(event) => setUsername(event.target.value)} /></label>
        <label className="new-project-field"><span>Password</span><input className="text-input" type="password" value={password} autoComplete="off" onChange={(event) => setPassword(event.target.value)} /><small className="project-settings-note">Sent once to sign in. Bitbots doesn't keep it.</small></label>
      </>}
    {problem && <p className="new-project-error" role="alert">{problem}</p>}
    <div className="machine-pair-actions">
      <button type="button" className="ghost-button small" onClick={() => { setProbe(null); setPassword(''); setMatches(false); setProblem(null) }}>Back</button>
      <button type="submit" className="primary-button small" disabled={busy || !ready}>{busy ? 'Connecting…' : 'Pair'}</button>
    </div>
  </form>
}

export function MachinesPage() {
  const { machines, loaded, reload } = useMachines()
  const nouns = useEntityNoun({ plural: true })
  const [pairing, setPairing] = useState(false)
  const [removing, setRemoving] = useState<Machine | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const act = async (work: Promise<unknown>, fallback: string) => {
    setProblem(null)
    try { await work } catch (reason) { setProblem(messageOf(reason, fallback)) }
    await reload()
  }
  return <>
    <p className="settings-intro">Link your other Windows computers. Each one keeps running its own {nouns}. Here you can read what they're doing, and take a conversation over so it carries on on this machine.</p>
    <ThisMachine />
    <SettingsGroup title="Other machines">
      {loaded && !machines.length && !pairing && <p className="settings-empty">No other machines yet.</p>}
      {machines.map((machine) => <MachineRow key={machine.id} machine={machine}
        onRename={(name) => void act(rpc('machine.rename', { id: machine.id, name }), 'That name could not be saved.')}
        onRefresh={() => void act(rpc('machine.refresh', { id: machine.id }), `${machine.name} could not be checked.`)}
        onRemove={() => setRemoving(machine)} />)}
      {problem && <p className="new-project-error" role="alert">{problem}</p>}
      {pairing
        ? <PairMachine onCancel={() => setPairing(false)} onDone={() => { setPairing(false); void reload() }} />
        : <SettingsRow label="Link a machine" hint="It needs Bitbots with Remote on. You approve this machine over there."><button type="button" className="primary-button small" onClick={() => setPairing(true)}>Link a machine</button></SettingsRow>}
    </SettingsGroup>
    {removing && <ConfirmDialog title={`Remove ${removing.name}?`} body={`This machine stops seeing its ${nouns}. Nothing on ${removing.name} changes, and conversations that moved here stay here.`} confirmLabel="Remove" cancelLabel="Keep it" tone="warning"
      onConfirm={() => { const target = removing; setRemoving(null); void act(rpc('machine.remove', { id: target.id, confirm: true }), `${target.name} could not be removed.`) }}
      onCancel={() => setRemoving(null)} />}
  </>
}
