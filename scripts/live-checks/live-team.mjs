// Live end-to-end check of blob delegation through the real daemon and the
// installed CLIs: a leader blob uses the app-owned `message_blob` tool, the
// teammate answers in a side conversation, and the reply is relayed back to
// wake the leader, who reports to the user. Isolated database and temp
// workspace; prints verdicts only.
//
//   node scripts/live-checks/live-team.mjs [path-to-bloblexd.exe]
//   env: LEADER=codex|claude|opencode (default codex), TEAMMATE=opencode|codex|claude (default opencode)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const daemonExe = process.argv[2] || process.env.BLOBLEXD_EXE || 'C:/dev/bloblex-target/debug/bloblexd.exe'
const leaderProvider = process.env.LEADER || 'codex'
const teammateProvider = process.env.TEAMMATE || 'opencode'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bloblex-live-team-'))
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
  const response = await fetch(`http://${ready.address}/v1/rpc`, { method: 'POST', headers: { authorization: `Bearer ${ready.capability}`, 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, id: `team-${++rpcId}`, method, params }) })
  const body = await response.json()
  if (!body.ok) { const error = new Error(body.error?.message ?? 'rpc failed'); error.code = body.error?.code; throw error }
  return body.result
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const report = []
const verdict = (check, pass, note = '') => { report.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${check}${note ? ` — ${note}` : ''}`) }
async function waitFor(label, predicate, seconds = 300) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(1500)
  }
  throw new Error(`timed out waiting for ${label}`)
}
const messages = async (sessionId) => (await rpc('session.get', { sessionId })).messages ?? []
const text = (message) => String(message.content ?? '')

try {
  await rpc('runtime.refresh').catch(() => undefined)
  const runtimes = await waitFor('runtimes', async () => { const list = (await rpc('runtime.list')).runtimes ?? []; return list.length >= 2 ? list : null }, 60)
  const leaderRuntime = runtimes.find((runtime) => runtime.provider === leaderProvider)
  const teammateRuntime = runtimes.find((runtime) => runtime.provider === teammateProvider)
  if (!leaderRuntime || !teammateRuntime) throw new Error(`need ${leaderProvider} and ${teammateProvider} installed`)
  await rpc('settings.set', { key: 'profile.name', value: 'Sam' })
  const { project: board } = await rpc('project.create', { name: 'Board', path: project })
  const leader = (await rpc('agent.create', { name: 'Bloblet', runtimeId: leaderRuntime.id, description: 'Coordinates the team and reports back.', color: '#e6e9ee' })).agent
  const teammate = (await rpc('agent.create', { name: 'Pololo', runtimeId: teammateRuntime.id, description: 'Answers short research questions.', color: '#2fbf9b' })).agent
  await rpc('agent.team.update', { agentId: leader.id, leader: true, role: 'CTO', projectId: board.id })
  await rpc('agent.team.update', { agentId: teammate.id, role: 'Researcher', projectId: board.id })
  // Keep the run cheap: lowest advertised effort.
  for (const [agent, runtime] of [[leader, leaderRuntime], [teammate, teammateRuntime]]) {
    const catalog = await rpc('runtime.models', { runtimeId: runtime.id }).catch(() => null)
    const cheap = (catalog?.models ?? []).find((model) => /mini|haiku|flash/i.test(`${model.id} ${model.displayName}`))
    if (cheap) await rpc('agent.update', { agentId: agent.id, model: cheap.id, thinking: runtime.provider !== 'opencode' && (cheap.supportedThinking ?? []).includes('low') ? 'low' : null }).catch(() => undefined)
  }
  const { session: main } = await rpc('agent.conversation', { agentId: leader.id })
  verdict('leader has one main conversation in its project folder', path.resolve(main.projectPath) === path.resolve(project), main.projectPath)
  const again = await rpc('agent.conversation', { agentId: leader.id })
  verdict('opening the blob again returns the same conversation', again.session.id === main.id && again.created === false)

  await rpc('session.prompt', { sessionId: main.id, text: '@Pololo please ask Pololo to reply with exactly the word PONG and nothing else. Hand it over with your message_blob tool, then end your turn.' })
  const side = await waitFor('side conversation', async () => (await rpc('session.list', {})).sessions.find((session) => session.agentId === teammate.id && session.link?.kind === 'side'))
  verdict('side conversation opened with the teammate', side.link.peerAgentId === leader.id, side.title)
  const note = await waitFor('delegation note', async () => (await messages(main.id)).find((message) => message.meta?.kind === 'delegation'))
  verdict('leader conversation shows "Messaged Pololo"', note.meta.peerName === 'Pololo')
  const brief = await waitFor('brief in side conversation', async () => (await messages(side.id)).find((message) => message.role === 'user'))
  verdict('brief delivered as a message from the leader', brief.meta?.kind === 'blob_message' && brief.meta?.fromName === 'Bloblet')
  const reply = await waitFor('teammate reply', async () => (await messages(side.id)).find((message) => message.role === 'assistant' && /pong/i.test(text(message))))
  verdict('teammate answered in the side conversation', !!reply, text(reply).slice(0, 40))
  const relayed = await waitFor('relayed reply', async () => (await messages(main.id)).find((message) => message.meta?.kind === 'blob_reply'))
  verdict('reply relayed into the leader conversation', text(relayed).startsWith('[Reply from Pololo]'))
  const summary = await waitFor('leader report', async () => {
    const detail = await rpc('session.get', { sessionId: main.id })
    if (['working', 'starting', 'waiting_permission'].includes(detail.state)) return null
    const list = detail.messages ?? []
    const index = list.findIndex((message) => message.id === relayed.id)
    const report = list.slice(index + 1).filter((message) => message.role === 'assistant').map(text).join('').trim()
    return report || null
  })
  verdict('leader woke up and reported to the user', /pong/i.test(summary), summary.replace(/\s+/g, ' ').slice(0, 80))
} catch (error) {
  verdict('run', false, error.message)
  if (process.env.DEBUG) {
    for (const session of (await rpc('session.list', {}).catch(() => ({ sessions: [] }))).sessions) {
      const detail = await rpc('session.get', { sessionId: session.id }).catch(() => null)
      console.log(`
--- ${session.title} [${session.state}] link=${JSON.stringify(session.link ?? null)}`)
      for (const message of detail?.messages ?? []) console.log(`  ${message.role}${message.meta ? ` ${JSON.stringify(message.meta)}` : ''}: ${text(message).replace(/\s+/g, ' ').slice(0, 300)}`)
      for (const tool of detail?.tools ?? []) console.log(`  tool: ${JSON.stringify(tool).slice(0, 400)}`)
    }
    const events = (await rpc('events.replay', { afterSequence: 0 }).catch(() => ({ events: [] }))).events
    for (const event of events.filter((event) => /turn\.error|permission|exec\.options\.rejected/.test(event.type))) console.log(`  event ${event.type}: ${JSON.stringify(event.payload).slice(0, 400)}`)
  }
} finally {
  await rpc('daemon.shutdown').catch(() => undefined)
  setTimeout(() => child.kill(), 3000).unref()
}
const failed = report.filter((pass) => !pass).length
console.log(`\n${report.length - failed}/${report.length} checks passed`)
process.exitCode = failed ? 1 : 0
