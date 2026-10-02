// Live Phase 2b entry-gate checks for Codex app-server. Trivial prompts; records structure and sentinel verdicts, never raw provider JSON.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bloblex-live-codex-'))

function start() {
  const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd: work, stdio: ['pipe', 'pipe', 'pipe'], shell: true })
  const pending = new Map()
  const notes = []
  let id = 0
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let m; try { m = JSON.parse(line) } catch { continue }
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m) }
      else if (m.method && m.id !== undefined) { // server request (approval etc.): auto-decline safely
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { decision: 'denied' } }) + '\n')
        notes.push({ method: 'SERVER_REQUEST:' + m.method })
      } else if (m.method) notes.push({ method: m.method, params: m.params })
    }
  })
  const call = (method, params) => new Promise((resolve) => { const myId = ++id; pending.set(myId, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n') })
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  return { child, call, notify, notes }
}

async function waitFor(notes, pred, ms = 90000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (notes.some(pred)) return true; await new Promise((r) => setTimeout(r, 300)) }
  return false
}

const report = { catalog: null, steps: [] }
const s = start()
const init = await s.call('initialize', { clientInfo: { name: 'BloblexLiveCheck', version: '0.0.1' }, capabilities: { experimentalApi: false } })
s.notify('initialized', {})
report.initialize = init.error ? { error: init.error.message?.slice(0, 120) } : { ok: true, keys: Object.keys(init.result || {}) }

// model/list pagination
const models = []
let cursor = null
let pages = 0
do {
  const r = await s.call('model/list', { cursor, limit: 100, includeHidden: false })
  if (r.error) { report.catalog = { error: r.error.message?.slice(0, 160) }; break }
  pages++
  models.push(...(r.result?.data || []))
  cursor = r.result?.nextCursor || null
} while (cursor && pages < 5)
if (!report.catalog) {
  report.catalog = {
    pages,
    count: models.length,
    sample: models.slice(0, 12).map((m) => ({ id: m.id, efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort || e.effort || e), defaultEffort: m.defaultReasoningEffort, tiers: (m.serviceTiers || []).map((t) => t.id), defaultTier: m.defaultServiceTier })),
    keysOfFirst: models[0] ? Object.keys(models[0]).sort() : null,
  }
}

const instrA = 'Rule: when the user says "status", reply with exactly KIWI-5521 and nothing else.'
const instrB = 'Rule: when the user says "status", reply with exactly MANGO-7743 and nothing else.'
const model = process.env.CODEX_LIVE_MODEL || 'gpt-6-luna'

async function turn(label, threadId, extra = {}) {
  s.notes.length = 0
  const r = await s.call('turn/start', { threadId, input: [{ type: 'text', text: 'status' }], ...extra })
  const sent = r.error ? { error: (r.error.message || '').slice(0, 160), code: r.error.code } : { ok: true, turnKeys: Object.keys(r.result?.turn || {}).sort() }
  const turnId = r.result?.turn?.id
  const mine = (n) => !turnId || n.params?.turnId === turnId || n.params?.turn?.id === turnId
  const done = r.error ? false : await waitFor(s.notes, (n) => n.method === 'turn/completed' && mine(n))
  const own = s.notes.filter(mine)
  const text = own.filter((n) => n.method === 'item/agentMessage/delta').map((n) => n.params?.delta ?? '').join('')
  const completedItems = own.filter((n) => n.method === 'item/completed').map((n) => (n.params?.item?.type) + ':' + JSON.stringify(n.params?.item?.text ?? '').slice(0, 40))
  const usageNote = own.find((n) => n.method === 'thread/tokenUsage/updated')
  const usage = usageNote?.params?.tokenUsage
  const completed = own.find((n) => n.method === 'turn/completed')
  report.steps.push({
    label, sent, completed: done, agentText: text.slice(0, 80), completedItems: completedItems.slice(0, 3),
    sentinelKIWI: text.includes('KIWI-5521'), sentinelMANGO: text.includes('MANGO-7743'),
    usageIsFromThisTurn: Boolean(usageNote), tokenUsageLast: usage?.last ? { input: usage.last.inputTokens, cached: usage.last.cachedInputTokens, output: usage.last.outputTokens, reasoning: usage.last.reasoningOutputTokens } : null,
    turnCompletedKeys: completed?.params ? Object.keys(completed.params).sort() : null,
    turnObjectKeys: completed?.params?.turn ? Object.keys(completed.params.turn).sort() : null,
    turnStatus: completed?.params?.turn?.status ?? null,
    turnError: completed?.params?.turn?.error ? JSON.stringify(completed.params.turn.error).slice(0, 200) : (s.notes.find((n) => n.method === 'error') ? JSON.stringify(s.notes.find((n) => n.method === 'error').params).slice(0, 200) : null),
    methods: [...new Set(own.map((n) => n.method))].slice(0, 12),
  })
}
// T1: thread/start with model + developerInstructions, turn with effort low
const t = await s.call('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'read-only', model, developerInstructions: instrA })
if (t.error) { report.threadStartError = (t.error.message || '').slice(0, 200) } else {
  const th = t.result
  const threadId = th.thread?.id || th.id
  report.threadStartResponse = { keys: Object.keys(th).sort(), model: th.model, reasoningEffort: th.reasoningEffort ?? null, serviceTier: th.serviceTier ?? null }
  await turn('T1 start(model, developerInstructions KIWI) + turn effort=low', threadId, { effort: 'low' })
  s.child.kill()
  // T2: new process, resume WITHOUT developerInstructions: retained?
  const s2 = start(); Object.assign(s, s2)
  await s.call('initialize', { clientInfo: { name: 'BloblexLiveCheck', version: '0.0.1' }, capabilities: { experimentalApi: false } }); s.notify('initialized', {})
  const r2 = await s.call('thread/resume', { threadId, cwd: work, model })
  report.resumeNoInstr = r2.error ? { error: (r2.error.message || '').slice(0, 160) } : { ok: true, keys: Object.keys(r2.result || {}).sort() }
  if (!r2.error) await turn('T2 resume WITHOUT developerInstructions, turn effort=low', threadId, { effort: 'low' })
  s.child.kill()
  // T3: resume WITH changed developerInstructions
  const s3 = start(); Object.assign(s, s3)
  await s.call('initialize', { clientInfo: { name: 'BloblexLiveCheck', version: '0.0.1' }, capabilities: { experimentalApi: false } }); s.notify('initialized', {})
  const r3 = await s.call('thread/resume', { threadId, cwd: work, model, developerInstructions: instrB })
  report.resumeWithInstr = r3.error ? { error: (r3.error.message || '').slice(0, 160) } : { ok: true }
  if (!r3.error) {
    await turn('T3 resume WITH developerInstructions MANGO, turn effort=low', threadId, { effort: 'low' })
    // T4: unsupported effort value
    await turn('T4 turn effort="ultra" (not listed for this model)', threadId, { effort: 'ultra' })
    // T5: serviceTier priority (Fast) on a turn
    await turn('T5 turn serviceTier="priority"', threadId, { effort: 'low', serviceTier: 'priority' })
    // T6: bogus serviceTier
    await turn('T6 turn serviceTier="fast" (the string the old plan used)', threadId, { effort: 'low', serviceTier: 'fast' })
  }
}
s.child.kill()
console.log(JSON.stringify(report, null, 1))
process.exit(0)
