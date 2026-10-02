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

const s1 = await call('session/new', { cwd: work, mcpServers: [] })
const sid = s1.result?.sessionId
await call('session/set_config_option', { sessionId: sid, configId: 'model', value: model })
const eff = process.env.OC_EFFORT
const er = await call('session/set_config_option', { sessionId: sid, configId: 'effort', value: eff })
report.effortSet = er.error ? { error: er.error.message?.slice(0,160) } : opt(er).filter((o)=>o.id==='effort')
report.effortPrompt = await prompt(sid, 'effort=' + eff, 'What is 17 times 23? Think it through, then give only the number.')
child.kill()
console.log(JSON.stringify(report, null, 1))
process.exit(0)
