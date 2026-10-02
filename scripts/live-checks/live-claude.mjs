// Live Phase 2b entry-gate checks for Claude Code. Trivial prompts only; records structure + sentinel verdicts, never prompt text.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const claudeExe = process.env.CLAUDE_EXE || (process.env.APPDATA + '\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bloblex-live-claude-'))
const fileA = path.join(work, 'instr-a.txt')
const fileB = path.join(work, 'instr-b.txt')
fs.writeFileSync(fileA, 'When you answer, end your reply with the exact token ZEBRA-4417 and nothing after it.\n')
fs.writeFileSync(fileB, 'When you answer, end your reply with the exact token OTTER-9082 and nothing after it.\n')

function run(label, args, input) {
  return new Promise((resolve) => {
    const child = spawn(claudeExe, args, { cwd: work, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => child.kill(), 120000)
    child.on('close', (code) => {
      clearTimeout(timer)
      const events = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      resolve({ label, code, events, err: err.slice(0, 300) })
    })
    if (input !== undefined) child.stdin.end(input)
  })
}

function summarize(r, sentinels) {
  const result = r.events.find((e) => e.type === 'result')
  const init = r.events.find((e) => e.type === 'system' && e.subtype === 'init')
  const assistantText = r.events.filter((e) => e.type === 'assistant').flatMap((e) => e.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
  const resultText = typeof result?.result === 'string' ? result.result : ''
  const text = resultText || assistantText
  const out = {
    label: r.label,
    exit: r.code,
    resultKeys: result ? Object.keys(result).sort() : null,
    is_error: result?.is_error ?? null,
    subtype: result?.subtype ?? null,
    stop_reason: result?.stop_reason ?? null,
    num_turns: result?.num_turns ?? null,
    total_cost_usd: result?.total_cost_usd ?? null,
    usageKeys: result?.usage ? Object.keys(result.usage).sort() : null,
    usage: result?.usage ? { input: result.usage.input_tokens, output: result.usage.output_tokens, cacheRead: result.usage.cache_read_input_tokens, cacheCreate: result.usage.cache_creation_input_tokens, service_tier: result.usage.service_tier, speed: result.usage.speed } : null,
    modelUsageKeys: result?.modelUsage ? Object.keys(result.modelUsage) : null,
    initModel: init?.model ?? null,
    topLevelModelOnResult: result && 'model' in result ? result.model : '(absent)',
    sessionIdPresent: Boolean(result?.session_id || init?.session_id),
    replyChars: text.length,
    sentinelHits: Object.fromEntries(Object.entries(sentinels).map(([k, v]) => [k, text.includes(v)])),
    stderr: r.err ? r.err.slice(0, 160) : '',
  }
  return { out, sessionId: result?.session_id || init?.session_id }
}

const base = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--effort', 'low', '--no-session-persistence']
const sentinels = { ZEBRA: 'ZEBRA-4417', OTTER: 'OTTER-9082' }
const report = { cwdIsTemp: true, calls: [] }

// 1) successful turn with model + effort + instruction FILE (session persisted so we can resume)
const baseArgs = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--effort', 'low']
const r1 = await run('1 model+effort+instruction-file (snapshot default)', [...baseArgs, '--append-system-prompt-file', fileA, 'Reply with the single word OK.'])
const s1 = summarize(r1, sentinels)
report.calls.push(s1.out)

// 2) resume the same session with a CHANGED file, snapshot default (expect old sentinel to persist / new ignored)
if (s1.sessionId) {
  const r2 = await run('2 resume + changed file (snapshot default)', [...baseArgs, '--resume', s1.sessionId, '--append-system-prompt-file', fileB, 'Reply with the single word OK again.'])
  report.calls.push(summarize(r2, sentinels).out)
  // 3) resume again with snapshot OFF and the changed file (expect new sentinel)
  const r3 = await run('3 resume + changed file + --system-prompt-snapshot off', [...baseArgs, '--resume', s1.sessionId, '--append-system-prompt-file', fileB, '--system-prompt-snapshot', 'off', 'Reply with the single word OK a third time.'])
  report.calls.push(summarize(r3, sentinels).out)
} else {
  report.calls.push({ label: 'resume checks skipped', reason: 'no session id from call 1' })
}
// 4) unknown model id through a real turn (error shape)
const r4 = await run('4 unknown model id', ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'not-a-real-model-xyz', '--no-session-persistence', 'Reply with the single word OK.'])
report.calls.push(summarize(r4, sentinels).out)

console.log(JSON.stringify(report, null, 1))
