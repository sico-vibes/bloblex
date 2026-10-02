// No-turn Codex checks: does thread/start echo serviceTier and config-supplied effort? (creates threads, sends no prompt)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bloblex-live-codex-echo-'))
const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd: work, stdio: ['pipe', 'pipe', 'pipe'], shell: true })
let id = 0, buf = ''
const pending = new Map()
child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); try { const m = JSON.parse(l); if (m.id !== undefined && pending.has(m.id) && (m.result !== undefined || m.error !== undefined)) { pending.get(m.id)(m); pending.delete(m.id) } } catch {} } })
const call = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n') })
await call('initialize', { clientInfo: { name: 'BloblexLiveCheck', version: '0.0.1' }, capabilities: { experimentalApi: false } })
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n')
const echo = (r) => r.error ? { error: (r.error.message || '').slice(0, 140) } : { model: r.result.model, reasoningEffort: r.result.reasoningEffort, serviceTier: r.result.serviceTier }
const out = {}
out.baseline = echo(await call('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'read-only', model: 'gpt-6-luna' }))
out.serviceTierPriority = echo(await call('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'read-only', model: 'gpt-6-luna', serviceTier: 'priority' }))
out.serviceTierBogus = echo(await call('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'read-only', model: 'gpt-6-luna', serviceTier: 'fast' }))
out.configEffortLow = echo(await call('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'read-only', model: 'gpt-6-luna', config: { model_reasoning_effort: 'low' } }))
out.configEffortBogus = echo(await call('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'read-only', model: 'gpt-6-luna', config: { model_reasoning_effort: 'ultra' } }))
out.unknownModel = echo(await call('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'read-only', model: 'not-a-real-model-xyz' }))
console.log(JSON.stringify(out, null, 1))
child.kill(); process.exit(0)
