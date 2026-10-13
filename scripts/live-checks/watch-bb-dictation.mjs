// Watches what bb (get-bb/bb) does while you dictate with it, without touching
// its traffic. It never reads a token, a header or an audio byte:
//   1. network: new TCP connections from bb's processes to chatgpt.com, bb's
//      hosted service (getbb.app) or api.openai.com, from `netstat`, so you can
//      see where a dictation goes;
//   2. logs: new lines in ~/.bb/logs/*.log that are warnings or errors, or that
//      mention voice, transcription or Cloudflare, long secrets redacted.
// Stop with Ctrl+C. It also stops by itself after 10 minutes.
//
//   node scripts/live-checks/watch-bb-dictation.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import dns from 'node:dns/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const LOG_DIR = path.join(os.homedir(), '.bb', 'logs')
const STOP_AFTER_MS = 10 * 60 * 1000
const KEYWORDS = /transcri|voice|cloudflare|challenge|codex\.ai|ai[-_ ]?service|ai[-_ ]?task|chatgpt|rate_limited|auth_required|provider_rpc_error/i
const NOISE = /event loop|provider\.list_models|ENOENT|Could not find the .* CLI/i

const stamp = () => new Date().toLocaleTimeString([], { hour12: false })
const say = (text) => console.log(`${stamp()}  ${text}`)
const redact = (text) => String(text).replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').replace(/[A-Za-z0-9_-]{40,}/g, '<redacted>')

// ── network ─────────────────────────────────────────────────────────────────
// Where bb might send a dictation: ChatGPT (your Codex sign-in), bb's own hosted
// service, or OpenAI's API.
const TARGETS = ['chatgpt.com', 'getbb.app', 'api.getbb.app', 'ai.getbb.app', 'api.openai.com']
let targetByAddress = new Map()
async function refreshAddresses() {
  const found = new Map(targetByAddress)
  for (const host of TARGETS) {
    for (const family of [dns.resolve4, dns.resolve6]) {
      try { for (const address of await family(host)) found.set(address, host) } catch { /* no records of this family */ }
    }
  }
  if (found.size) targetByAddress = found
}

async function bbPids() {
  try {
    const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq bb.exe', '/FO', 'CSV', '/NH'])
    return new Set(stdout.split(/\r?\n/).map((line) => line.split('","')[1]).filter(Boolean).map((pid) => pid.replace(/"/g, '')))
  } catch { return new Set() }
}

const seenConnections = new Set()
async function pollNetwork(pids) {
  let stdout
  try { ({ stdout } = await run('netstat', ['-ano', '-p', 'tcp'], { maxBuffer: 8 * 1024 * 1024 })) } catch { return }
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5 || parts[0] !== 'TCP') continue
    const [, local, remote, state, pid] = parts
    if (!pids.has(pid)) continue
    const host = remote.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    const port = remote.split(':').pop()
    const target = targetByAddress.get(host)
    if (port !== '443' || !target) continue
    const key = `${local}>${remote}`
    if (seenConnections.has(key)) continue
    seenConnections.add(key)
    say(`NETWORK   bb (pid ${pid}) opened a connection to ${target.toUpperCase()} ${host}:443 [${state}]`)
  }
}

// ── logs ────────────────────────────────────────────────────────────────────
const offsets = new Map()
function initOffsets() {
  try {
    for (const name of fs.readdirSync(LOG_DIR)) {
      if (!name.endsWith('.log')) continue
      offsets.set(name, fs.statSync(path.join(LOG_DIR, name)).size)
    }
  } catch { /* the logs directory may not exist yet */ }
}

function describeLine(raw) {
  let entry
  try { entry = JSON.parse(raw) } catch { return KEYWORDS.test(raw) ? redact(raw).slice(0, 300) : null }
  const level = typeof entry.level === 'number' ? entry.level : 30
  const text = [entry.msg, entry.type, entry.task, entry.err?.message, entry.error?.message, entry.reason, entry.code].filter(Boolean).join(' | ')
  const whole = `${entry.component ?? ''} ${text}`
  if (NOISE.test(whole)) return null
  if (level < 40 && !KEYWORDS.test(whole)) return null
  const label = level >= 50 ? 'ERROR' : level >= 40 ? 'WARN' : 'INFO'
  return `${label} ${entry.component ?? ''} ${redact(text)}`.slice(0, 320)
}

function pollLogs() {
  let names
  try { names = fs.readdirSync(LOG_DIR).filter((name) => name.endsWith('.log')) } catch { return }
  for (const name of names) {
    const file = path.join(LOG_DIR, name)
    let size
    try { size = fs.statSync(file).size } catch { continue }
    const from = offsets.has(name) ? offsets.get(name) : 0
    if (size < from) { offsets.set(name, 0); continue }
    if (size === from) continue
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(size - from)
      fs.readSync(fd, buffer, 0, buffer.length, from)
      for (const raw of buffer.toString('utf8').split(/\r?\n/)) {
        if (!raw.trim()) continue
        const text = describeLine(raw)
        if (text) say(`LOG       ${name}: ${text}`)
      }
    } finally { fs.closeSync(fd) }
    offsets.set(name, size)
  }
}

// ── loop ────────────────────────────────────────────────────────────────────
initOffsets()
await refreshAddresses()
say(`watching bb. Known destinations: ${[...new Set(targetByAddress.values())].join(', ')}. Dictate in bb now. (Ctrl+C to stop)`)
const started = Date.now()
let tick = 0
let pids = await bbPids()
const timer = setInterval(async () => {
  tick++
  if (tick % 6 === 0) pids = await bbPids()
  if (tick % 100 === 0) await refreshAddresses()
  await pollNetwork(pids)
  pollLogs()
  if (tick % 50 === 0) say(`... still watching (${pids.size} bb processes)`)
  if (Date.now() - started > STOP_AFTER_MS) { say('stopping after 10 minutes'); clearInterval(timer); process.exit(0) }
}, 300)
