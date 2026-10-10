// Live check of plan mode and inline questions through the real daemon:
// a plan-mode turn that must ask the user a question first, an answer sent
// back through `permission.reply`, and the resulting proposed plan.
// Isolated database and temp workspace; prints verdicts only.
//
//   node scripts/live-checks/live-plan.mjs [path-to-bloblexd.exe]   env: PROVIDER=codex|claude|opencode
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const daemonExe = process.argv[2] || process.env.BLOBLEXD_EXE || 'C:/dev/bloblex-target/debug/bloblexd.exe'
const provider = process.env.PROVIDER || 'codex'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bloblex-live-plan-'))
const project = path.join(work, 'project')
fs.mkdirSync(project)
const child = spawn(daemonExe, [], { env: { ...process.env, BLOBLEX_DB_PATH: path.join(work, 'live.db') }, stdio: ['ignore', 'pipe', 'ignore'] })
const ready = await new Promise((resolve, reject) => {
  const lines = readline.createInterface({ input: child.stdout })
  const timer = setTimeout(() => reject(new Error('daemon did not start')), 60_000)
  lines.on('line', (line) => { try { const value = JSON.parse(line); if (value.type === 'bloblexd.ready') { clearTimeout(timer); resolve(value) } } catch { /* not JSON */ } })
})
let rpcId = 0
async function rpc(method, params = {}) {
  const response = await fetch(`http://${ready.address}/v1/rpc`, { method: 'POST', headers: { authorization: `Bearer ${ready.capability}`, 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, id: `plan-${++rpcId}`, method, params }) })
  const body = await response.json()
  if (!body.ok) { const error = new Error(body.error?.message ?? 'rpc failed'); error.code = body.error?.code; throw error }
  return body.result
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const report = []
const verdict = (check, pass, note = '') => { report.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${provider.padEnd(8)} ${check}${note ? ` — ${note}` : ''}`) }
async function waitFor(label, predicate, seconds = 300) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await sleep(1500) }
  throw new Error(`timed out waiting for ${label}`)
}

try {
  await rpc('runtime.refresh').catch(() => undefined)
  const runtime = await waitFor('runtime', async () => ((await rpc('runtime.list')).runtimes ?? []).find((item) => item.provider === provider), 60)
  const agent = (await rpc('agent.create', { name: 'Planner', runtimeId: runtime.id, color: '#7db6ff' })).agent
  const { session } = await rpc('agent.conversation', { agentId: agent.id })
  const updated = await rpc('session.model.update', { sessionId: session.id, planMode: true })
  verdict('plan mode pinned on the conversation', updated.session?.modelLock?.planMode === true)
  await rpc('session.prompt', { sessionId: session.id, text: 'I want a tiny hello-world script in this empty folder. Before planning, you must ask me which language I want, using your structured question tool with the options Python and JavaScript. After I answer, propose a three-step plan. Do not create or edit any files.' })
  const outcome = await waitFor('question or plan', async () => {
    const snapshot = await rpc('app.snapshot')
    const question = (snapshot.permissions ?? []).find((permission) => permission.sessionId === session.id && permission.kind === 'question')
    if (question) return { question }
    const detail = await rpc('session.get', { sessionId: session.id })
    const plan = (detail.messages ?? []).find((message) => message.role === 'plan')
    if (plan) return { plan }
    if (['completed', 'error'].includes(detail.state)) return { done: detail }
    return null
  })
  if (outcome.question) {
    const first = outcome.question.questions?.[0]
    verdict('question streamed into the conversation', !!first && (first.options ?? []).length > 0, `${first?.question ?? ''} [${(first?.options ?? []).map((o) => o.label).join(' / ')}]`)
    const choice = (first.options ?? []).find((option) => /python/i.test(option.label))?.label ?? first.options?.[0]?.label
    await rpc('permission.reply', { permissionId: outcome.question.id, choice: 'answer', answers: { [first.id]: [choice] } })
    verdict('answer accepted', true, choice)
  } else {
    verdict('question streamed into the conversation', false, outcome.plan ? 'planned without asking' : 'turn ended without a question')
  }
  const plan = await waitFor('plan', async () => {
    const detail = await rpc('session.get', { sessionId: session.id })
    const found = (detail.messages ?? []).find((message) => message.role === 'plan')
    return found ?? (['completed', 'error'].includes(detail.state) && !['working'].includes(detail.state) ? { missing: detail } : null)
  })
  verdict('proposed plan captured as a plan message', !plan.missing && String(plan.content ?? '').length > 20, String(plan.content ?? '').replace(/\s+/g, ' ').slice(0, 80))
  verdict('no files were created in plan mode', fs.readdirSync(project).length === 0)
  const back = await rpc('session.model.update', { sessionId: session.id, planMode: false })
  verdict('plan mode can be turned off', back.session?.modelLock?.planMode === undefined)
} catch (error) {
  verdict('run', false, error.message)
} finally {
  await rpc('daemon.shutdown').catch(() => undefined)
  setTimeout(() => child.kill(), 3000).unref()
}
const failed = report.filter((pass) => !pass).length
console.log(`\n${report.length - failed}/${report.length} checks passed`)
process.exitCode = failed ? 1 : 0
