// Live Phase 2b entry-gate checks for OpenCode ACP (real profile). Trivial prompts; records structure and verdicts, never raw provider JSON.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const exe = process.env.OPENCODE_EXE || (process.env.APPDATA + '\npm\node_modules\opencode-ai\bin\opencode.exe')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bloblex-live-opencode-'))
const model = process.env.OC_MODEL || 'opencode-go/deepseek-v4.1-flash'
const config = {
  $schema: 'https://opencode.ai/config.json',
  model,
  agent: { bloblexlive: { mode: 'primary', model, prompt: 'Rule: when the user says "status", reply with exactly PLUM-6612 and nothing else.' } },
}
const env = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
const child = spawn(exe, ['acp', '--cwd', work], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] })
let id = 0
const pending = new Map()
const notes = []
let buf = ''
child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m) }
    else if (m.method === 'session/request_permission' && m.id !== undefined) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } }) + '\n'); notes.push({ method: 'PERMISSION_REQUEST_CANCELLED' })
    } else if (m.method) notes.push({ method: m.method, params: m.params })
  }
})
child.stderr.on('data', () => {})
const call = (method, params) => new Promise((resolve) => { const myId = ++id; pending.set(myId, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n') })
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
const opt = (res) => (res.result?.configOptions || []).map((o) => ({ id: o.id, cur: o.currentValue, values: (o.options || []).map((x) => x.value ?? x.id).slice(0, 8), n: (o.options || []).length }))

const report = { model }
const init = await call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'BloblexLiveCheck', version: '0.0.1' } })
notify('initialized', {})
report.initialize = init.error ? { error: init.error.message?.slice(0, 120) } : { agent: init.result?.agentInfo?.name, version: init.result?.agentInfo?.version, caps: Object.keys(init.result?.agentCapabilities || {}) }

async function prompt(sessionId, label, text = 'status') {
  notes.length = 0
  const r = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
  await new Promise((res) => setTimeout(res, 800))
  const chunks = notes.filter((n) => n.method === 'session/update' && n.params?.update?.sessionUpdate === 'agent_message_chunk').map((n) => n.params.update.content?.text ?? '').join('')
  const usageUpdates = notes.filter((n) => n.method === 'session/update' && n.params?.update?.sessionUpdate === 'usage_update').map((n) => ({ used: n.params.update.used, size: n.params.update.size, cost: n.params.update.cost }))
  const updateKinds = [...new Set(notes.filter((n) => n.method === 'session/update').map((n) => n.params?.update?.sessionUpdate))]
  return {
    label,
    error: r.error ? (r.error.message || '').slice(0, 160) : null,
    stopReason: r.result?.stopReason ?? null,
    promptResultKeys: r.result ? Object.keys(r.result).sort() : null,
    promptResultUsage: r.result?.usage ?? r.result?._meta?.usage ?? null,
    text: chunks.slice(0, 80),
    plum: chunks.includes('PLUM-6612'),
    updateKinds,
    usageUpdates,
  }
}

// Session 1: select model, effort, agent mode; prompt twice
const s1 = await call('session/new', { cwd: work, mcpServers: [] })
const sid = s1.result?.sessionId
report.session1Options = opt(s1)
const m1 = await call('session/set_config_option', { sessionId: sid, configId: 'model', value: model })
report.afterSetModel = m1.error ? { error: m1.error.message?.slice(0, 160) } : opt(m1)
const effortOpt = (m1.result?.configOptions || []).find((o) => o.id === 'effort')
const e1 = effortOpt ? await call('session/set_config_option', { sessionId: sid, configId: 'effort', value: (effortOpt.options || []).map((x) => x.value ?? x.id).find((v) => v === 'low') || (effortOpt.options?.[0]?.value) }) : null
report.afterSetEffort = e1 ? (e1.error ? { error: e1.error.message?.slice(0, 160) } : opt(e1).filter((o) => o.id === 'effort')) : 'no effort option offered for this model'
const md = await call('session/set_config_option', { sessionId: sid, configId: 'mode', value: 'bloblexlive' })
report.afterSetMode = md.error ? { error: md.error.message?.slice(0, 160) } : opt(md).filter((o) => o.id === 'mode')
report.prompt1 = await prompt(sid, 'P1 session with custom agent selected, effort low, "status"')
report.prompt2 = await prompt(sid, 'P2 same session, "status" again (cost cumulative vs delta)')

// Session 2 in the same process: custom agent NOT selected (control)
const s2 = await call('session/new', { cwd: work, mcpServers: [] })
const sid2 = s2.result?.sessionId
await call('session/set_config_option', { sessionId: sid2, configId: 'model', value: model })
report.control = await prompt(sid2, 'C1 control: custom agent NOT selected, "status"')

child.kill()
console.log(JSON.stringify(report, null, 1))
process.exit(0)
