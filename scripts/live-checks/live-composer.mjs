// Live end-to-end check of the composer paths through the real daemon and the
// user's installed, signed-in CLIs: image attachments (Claude Code, Codex),
// per-conversation speed/permission updates, fast-mode catalog detection, and
// OpenCode's attachment rejection. Uses an isolated database and temp project,
// sends two trivial prompts with a 64x64 solid-colour PNG, and prints verdicts
// only (never raw provider payloads or credentials).
//
//   node scripts/live-checks/live-composer.mjs [path-to-bloblexd.exe]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import zlib from 'node:zlib'

const daemonExe = process.argv[2] || process.env.BLOBLEXD_EXE || 'C:/dev/bloblex-target/debug/bloblexd.exe'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bloblex-live-composer-'))
const project = path.join(work, 'project')
fs.mkdirSync(project)
const only = process.env.BLOBLEX_LIVE_ONLY // claude | codex | opencode

function crc32(buffer) {
  let crc = ~0
  for (const byte of buffer) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
  return ~crc >>> 0
}
function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
function solidPng(size, [r, g, b]) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).map((_, i) => [r, g, b][i % 3])])
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))])
}
const image = path.join(work, 'swatch.png')
fs.writeFileSync(image, solidPng(64, [220, 20, 30]))

const child = spawn(daemonExe, [], { env: { ...process.env, BLOBLEX_DB_PATH: path.join(work, 'live.db') }, stdio: ['ignore', 'pipe', 'ignore'] })
const ready = await new Promise((resolve, reject) => {
  const lines = readline.createInterface({ input: child.stdout })
  const timer = setTimeout(() => reject(new Error('daemon did not start')), 60_000)
  lines.on('line', (line) => { try { const value = JSON.parse(line); if (value.type === 'bloblexd.ready') { clearTimeout(timer); resolve(value) } } catch { /* not JSON */ } })
})
let rpcId = 0
async function rpc(method, params = {}) {
  const response = await fetch(`http://${ready.address}/v1/rpc`, { method: 'POST', headers: { authorization: `Bearer ${ready.capability}`, 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, id: `live-${++rpcId}`, method, params }) })
  const body = await response.json()
  if (!body.ok) { const error = new Error(body.error?.message ?? 'rpc failed'); error.code = body.error?.code; throw error }
  return body.result
}
async function waitForTurn(turnId, seconds = 180) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const { events } = await rpc('events.replay', { afterSequence: 0 })
    const mine = events.filter((event) => event.payload?.turnId === turnId)
    const failed = mine.find((event) => event.type === 'turn.error')
    if (failed) return { ok: false, reason: failed.payload?.message ?? 'turn error', detail: [failed.payload?.failureClass, failed.payload?.detail].filter(Boolean).join(': ') || null }
    if (mine.some((event) => event.type === 'turn.completed')) return { ok: true }
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  return { ok: false, reason: 'timed out' }
}

const report = []
const verdict = (provider, check, pass, note = '') => { report.push({ provider, check, pass, note }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${provider.padEnd(8)} ${check}${note ? ` — ${note}` : ''}`) }

try {
  await rpc('runtime.refresh').catch(() => undefined)
  let runtimes = []
  for (let attempt = 0; attempt < 40 && runtimes.length < 3; attempt++) {
    runtimes = (await rpc('runtime.list')).runtimes ?? []
    if (runtimes.length < 3) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  for (const provider of ['claude', 'codex', 'opencode']) {
    if (only && only !== provider) continue
    const runtime = runtimes.find((item) => item.provider === provider)
    if (!runtime) { verdict(provider, 'runtime discovered', false, 'not installed'); continue }
    verdict(provider, 'runtime discovered', true, runtime.version ?? '')
    const catalog = await rpc('runtime.models', { runtimeId: runtime.id }).catch((error) => ({ error }))
    if (catalog.error) { verdict(provider, 'model catalog', false, catalog.error.message); continue }
    const fast = (catalog.models ?? []).filter((model) => (model.serviceTiers ?? []).some((tier) => /\bfast\b|priority/i.test(`${tier.id} ${tier.name}`)))
    verdict(provider, 'model catalog', (catalog.models ?? []).length > 0, `${catalog.models.length} models, ${fast.length} with fast mode`)

    const session = await rpc('session.new', { runtimeId: runtime.id, projectPath: project, title: 'Bloblex composer live check' })
    const sessionId = session.id
    try {
      // Mode-only update: keeps model/effort, pins permission mode for this conversation.
      const pinned = await rpc('session.model.update', { sessionId, approvalMode: 'ask' })
      verdict(provider, 'permission-only update keeps model', pinned.modelChanged === false && pinned.session?.modelLock?.approvalMode === 'ask')

      if (provider === 'opencode') {
        const rejected = await rpc('session.prompt', { sessionId, text: 'hello', attachments: [{ path: image, name: 'swatch.png' }] }).then(() => null, (error) => error)
        const detail = await rpc('session.get', { sessionId })
        verdict(provider, 'image attachment rejected before delivery', rejected?.code === 'unsupported' && !(detail.messages ?? []).length, rejected?.code ?? 'accepted')
        continue
      }

      // Cheapest advertised model and lowest effort keep the check inexpensive.
      const cheap = (catalog.models ?? []).find((model) => /haiku|mini/i.test(`${model.id} ${model.displayName}`))
      if (cheap) {
        const low = (cheap.supportedThinking ?? []).includes('low') ? 'low' : null
        await rpc('session.model.update', { sessionId, model: cheap.id, thinking: low, confirmModelChange: true })
      }
      const prompt = await rpc('session.prompt', { sessionId, text: 'What is the dominant colour of the attached image? Answer with one lowercase English colour word only. Do not use any tools.', attachments: [{ path: image, name: 'swatch.png' }] })
      const turn = await waitForTurn(prompt.turnId)
      const detail = await rpc('session.get', { sessionId })
      const user = (detail.messages ?? []).find((message) => message.role === 'user')
      verdict(provider, 'attachment metadata persisted', Array.isArray(user?.attachments) && user.attachments[0]?.name === 'swatch.png' && user.attachments[0]?.mediaType === 'image/png')
      const reply = (detail.messages ?? []).filter((message) => message.role === 'assistant').map((message) => String(message.content ?? '')).join(' ').toLowerCase()
      verdict(provider, 'model saw the image', turn.ok && /\bred\b|crimson|scarlet/.test(reply), turn.ok ? `${cheap ? cheap.displayName : 'default model'}: "${reply.trim().slice(0, 40)}"` : `${turn.reason}${turn.detail ? ` (${turn.detail})` : ''}`)
    } finally {
      await rpc('session.close', { sessionId }).catch(() => undefined)
    }
  }
} finally {
  await rpc('daemon.shutdown').catch(() => undefined)
  setTimeout(() => child.kill(), 3000).unref()
}
const failed = report.filter((item) => !item.pass)
console.log(`\n${report.length - failed.length}/${report.length} checks passed`)
process.exitCode = failed.length ? 1 : 0
