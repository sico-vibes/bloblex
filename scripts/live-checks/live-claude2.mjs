// Follow-up live Claude checks: clean snapshot test with an additive rule, fresh-session file honour, and effort evidence.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const claudeExe = process.env.CLAUDE_EXE || (process.env.APPDATA + '\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bloblex-live-claude2-'))
const fileA = path.join(work, 'a.txt')
const fileC = path.join(work, 'c.txt')
fs.writeFileSync(fileA, 'Rule 1: when asked to say "hello", reply with exactly: HELLO-1111.\n')
fs.writeFileSync(fileC, 'Rule 1: when asked to say "hello", reply with exactly: HELLO-1111.\nRule 2: when asked for "status", reply with exactly: PINEAPPLE-3301.\n')

function run(label, args) {
  return new Promise((resolve) => {
    const child = spawn(claudeExe, args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    const timer = setTimeout(() => child.kill(), 150000)
    child.on('close', (code) => {
      clearTimeout(timer)
      const events = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      const result = events.find((e) => e.type === 'result')
      resolve({ label, code, result })
    })
  })
}
const brief = (r) => ({
  label: r.label,
  exit: r.code,
  is_error: r.result?.is_error ?? null,
  text: (r.result?.result || '').slice(0, 60),
  cost: r.result?.total_cost_usd ?? null,
  usage: r.result?.usage ? { in: r.result.usage.input_tokens, out: r.result.usage.output_tokens, cacheRead: r.result.usage.cache_read_input_tokens, cacheWrite: r.result.usage.cache_creation_input_tokens } : null,
  outputTokensDetails: r.result?.usage?.output_tokens_details ?? null,
  iterations: r.result?.usage?.iterations ?? null,
  modelUsageKeys: r.result?.modelUsage ? Object.keys(r.result.modelUsage) : null,
  sessionId: r.result?.session_id,
})
const base = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--effort', 'low']
const report = []

const r1 = await run('A fresh session, file A, ask "hello"', [...base, '--append-system-prompt-file', fileA, 'Say hello.'])
report.push(brief(r1))
const sid = r1.result?.session_id
if (sid) {
  const r2 = await run('B resume, file C (adds Rule 2), snapshot DEFAULT, ask "status"', [...base, '--resume', sid, '--append-system-prompt-file', fileC, 'status'])
  report.push(brief(r2))
  const r3 = await run('C resume, file C (adds Rule 2), snapshot OFF, ask "status"', [...base, '--resume', sid, '--append-system-prompt-file', fileC, '--system-prompt-snapshot', 'off', 'status'])
  report.push(brief(r3))
}
const r4 = await run('D fresh session, file C, snapshot default, ask "status" (control: does a fresh start honour Rule 2?)', [...base, '--append-system-prompt-file', fileC, 'status'])
report.push(brief(r4))

// effort evidence on a model that lists effort levels
const q = 'What is 17 times 23? Think it through, then give only the number.'
const e1 = await run('E sonnet effort low', ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--effort', 'low', q])
report.push(brief(e1))
const e2 = await run('F sonnet effort max', ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--effort', 'max', q])
report.push(brief(e2))
console.log(JSON.stringify(report, null, 1))
