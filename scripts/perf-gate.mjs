// Phase 5, section 9: the performance gate.
//
// Measures three things that a release can quietly make worse, and fails when a
// budget in `perf-budgets.json` is exceeded:
//
// * cold start: from spawning `bitbotsd` to its ready line, on a seeded
//   database (200 conversations, 2,000 messages);
// * snapshot size: the bytes of `app.snapshot`, with and without `lazy`, on
//   that same database;
// * render time is measured where it can be: `apps/desktop/src/ui/perf.mounted.test.tsx`,
//   which reads `renderMs` from the same budgets file.
//
// Each number is the median of `runs` (3 by default), because CI machines vary.
// Every run gets its own copy of the seeded database, so a run cannot inherit
// state from the one before it.
//
// Usage:
//   node scripts/perf-gate.mjs [--daemon <bitbotsd>] [--seed <perf-seed>]
//                              [--runs 3] [--json] [--keep]
//   node scripts/perf-gate.mjs --self-test      # fails on purpose, with a 1 ms budget
//
// The binaries must be built first (CI does this in its own step):
//   cargo build -p bloblex-daemon --bin bitbotsd -p bloblex-storage --bin perf-seed
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exe = process.platform === 'win32' ? '.exe' : ''
const options = parseArgs(process.argv.slice(2))
const budgets = JSON.parse(readFileSync(path.join(root, 'perf-budgets.json'), 'utf8'))
const runs = options.runs ?? budgets.runs ?? 3
const selfTest = options.selfTest
// The self-test keeps the real measurement code and only replaces the budgets,
// so what it demonstrates is exactly the path a regression takes.
const limits = selfTest ? { ...budgets, coldStartMs: 1, snapshotBytes: 1, snapshotLazyRatio: 0.0001 } : budgets

function parseArgs(argv) {
  const found = { runs: null, selfTest: false, json: false, keep: false, daemon: null, seed: null }
  for (let at = 0; at < argv.length; at += 1) {
    const value = argv[at]
    if (value === '--self-test') found.selfTest = true
    else if (value === '--json') found.json = true
    else if (value === '--keep') found.keep = true
    else if (value === '--daemon') found.daemon = argv[++at] ?? null
    else if (value === '--seed') found.seed = argv[++at] ?? null
    else if (value === '--runs') found.runs = Number(argv[++at])
    else if (value === '--help' || value === '-h') { console.log('node scripts/perf-gate.mjs [--daemon <path>] [--seed <path>] [--runs 3] [--json] [--keep] [--self-test]'); process.exit(0) }
    else { console.error(`perf-gate: unknown argument ${value}`); process.exit(2) }
  }
  return found
}

/** The built binary, from an explicit path, the environment, or the usual target folders. */
function findBinary(explicit, envNames, name) {
  const attempts = []
  if (explicit) attempts.push(explicit)
  for (const key of envNames) if (process.env[key]) attempts.push(process.env[key])
  const targets = [process.env.CARGO_TARGET_DIR, path.join(root, 'target'), path.join(root, 'apps', 'desktop', 'src-tauri', 'target')].filter(Boolean)
  for (const target of targets) {
    attempts.push(path.join(target, 'release', name + exe), path.join(target, 'debug', name + exe))
  }
  const found = attempts.find((candidate) => candidate && existsSync(candidate))
  if (!found) {
    console.error(`perf-gate: could not find ${name}${exe}. Build it first, or pass it explicitly:`)
    console.error(`  cargo build -p bloblex-daemon --bin bitbotsd -p bloblex-storage --bin perf-seed`)
    console.error(`  node scripts/perf-gate.mjs --daemon <path to bitbotsd> --seed <path to perf-seed>`)
    process.exit(2)
  }
  return found
}

const daemonPath = findBinary(options.daemon, ['BITBOTSD', 'BLOBLEX_DAEMON_BIN'], 'bitbotsd')
const seedPath = findBinary(options.seed, ['PERF_SEED_BIN'], 'perf-seed')

function runSeed(database) {
  const seeded = spawnSync(seedPath, ['--db', database, '--conversations', '200', '--messages', '2000'], { encoding: 'utf8' })
  if (seeded.status !== 0) {
    console.error(`perf-gate: seeding failed (${seeded.status})\n${seeded.stdout ?? ''}${seeded.stderr ?? ''}`)
    process.exit(2)
  }
  return JSON.parse(String(seeded.stdout).trim().split(/\r?\n/).at(-1))
}

/** One daemon start: time to the ready line, then the two snapshot sizes. */
function measureRun(database) {
  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint()
    const child = spawn(daemonPath, [], {
      env: { ...process.env, BLOBLEX_DB_PATH: database },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let buffered = ''
    let ready = null
    let stderr = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error); else resolve(value)
    }
    const timeout = setTimeout(() => {
      finish(new Error(`the daemon did not print its ready line within 60 s. Last stderr: ${stderr.trim() || '(none)'}`))
      kill()
    }, 60_000)
    // Windows keeps a database and a log file locked until the process is really
    // gone, so every measurement waits for the exit before the next one copies.
    const kill = () => new Promise((done) => {
      if (child.exitCode !== null) return done()
      const hard = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 5_000)
      child.once('exit', () => { clearTimeout(hard); done() })
      child.kill()
    })
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).split(/\r?\n/).slice(-5).join('\n') })
    child.on('error', (error) => finish(error))
    child.on('exit', (code) => {
      if (ready === null) finish(new Error(`the daemon exited with code ${code} before it was ready. Last stderr: ${stderr.trim() || '(none)'}`))
    })
    child.stdout.on('data', (chunk) => {
      if (ready !== null) return
      buffered += String(chunk)
      let newline = buffered.indexOf('\n')
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf('\n')
        if (!line.startsWith('{')) continue
        let parsed
        try { parsed = JSON.parse(line) } catch { continue }
        if (parsed.type !== 'bloblexd.ready') continue
        ready = { coldStartMs: Number(process.hrtime.bigint() - startedAt) / 1e6, address: parsed.address, capability: parsed.capability }
        // The snapshot follows on the same process: a second start would measure
        // a different database state and a warm file cache.
        snapshotSizes(ready.address, ready.capability)
          .then(async (sizes) => { await kill(); finish(null, { ...ready, ...sizes }) })
          .catch(async (error) => { await kill(); finish(error) })
        return
      }
    })
  })
}

function rpc(address, capability, method, params) {
  const [host, port] = String(address).split(':')
  const body = JSON.stringify({ v: 1, id: `${method}-${Date.now()}`, method, params })
  return new Promise((resolve, reject) => {
    const request = http.request({ host, port: Number(port), path: '/v1/rpc', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${capability}`, 'content-length': Buffer.byteLength(body) }, timeout: 60_000 }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (part) => { text += part })
      response.on('end', () => {
        let parsed
        try { parsed = JSON.parse(text) } catch { return reject(new Error(`${method} answered ${response.statusCode} with a body that is not JSON`)) }
        if (!parsed.ok) return reject(new Error(`${method} failed: ${parsed.error?.code ?? response.statusCode} ${parsed.error?.message ?? ''}`.trim()))
        resolve(parsed.result)
      })
    })
    request.on('timeout', () => request.destroy(new Error(`${method} timed out`)))
    request.on('error', reject)
    request.end(body)
  })
}

async function snapshotSizes(address, capability) {
  const full = await rpc(address, capability, 'app.snapshot', {})
  const lazy = await rpc(address, capability, 'app.snapshot', { lazy: true })
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')
  return { snapshotBytes: bytes(full), snapshotLazyBytes: bytes(lazy) }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

async function main() {
  const work = mkdtempSync(path.join(os.tmpdir(), 'bitbots-perf-'))
  const database = path.join(work, 'seed.db')
  const seeded = runSeed(database)
  const keep = options.keep
  const results = []
  try {
    for (let run = 0; run < runs; run += 1) {
      if (!selfTest) process.stdout.write(`perf-gate: run ${run + 1} of ${runs}\n`)
      const copy = path.join(work, `run-${run}.db`)
      copyFileSync(database, copy)
      for (const suffix of ['-wal', '-shm']) if (existsSync(database + suffix)) copyFileSync(database + suffix, copy + suffix)
      results.push(await measureRun(copy))
      if (keep) process.stdout.write(`perf-gate: kept ${copy}\n`)
    }
  } finally {
    if (!keep) rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
  const measured = {
    coldStartMs: median(results.map((run) => run.coldStartMs)),
    snapshotBytes: median(results.map((run) => run.snapshotBytes)),
    snapshotLazyBytes: median(results.map((run) => run.snapshotLazyBytes)),
  }
  measured.snapshotLazyRatio = measured.snapshotLazyBytes / measured.snapshotBytes
  const failures = []
  const check = (name, value, limit, unit, compare = (actual, bound) => actual <= bound) => {
    if (!compare(value, limit)) failures.push(`${name} ${format(value)}${unit} exceeds the budget of ${format(limit)}${unit}`)
  }
  check('coldStartMs', measured.coldStartMs, limits.coldStartMs, ' ms')
  check('snapshotBytes', measured.snapshotBytes, limits.snapshotBytes, ' bytes')
  check('snapshotLazyBytes', measured.snapshotLazyBytes, limits.snapshotLazyBytes, ' bytes')
  check('snapshotLazyRatio', measured.snapshotLazyRatio, limits.snapshotLazyRatio, '', (actual, bound) => actual <= bound)

  if (options.json) {
    console.log(JSON.stringify({ seeded, runs: results, measured, limits, ok: failures.length === 0 }, null, 2))
  } else {
    console.log('')
    console.log(`seeded: ${seeded.conversations} conversations, ${seeded.messages} messages`)
    console.log(`${'measure'.padEnd(22)} ${'measured'.padStart(14)} ${'budget'.padStart(14)}`)
    const row = (name, value, limit, unit) => console.log(`${name.padEnd(22)} ${(format(value) + unit).padStart(14)} ${(format(limit) + unit).padStart(14)}`)
    row('cold start', measured.coldStartMs, limits.coldStartMs, ' ms')
    row('snapshot', measured.snapshotBytes, limits.snapshotBytes, ' B')
    row('snapshot, lazy', measured.snapshotLazyBytes, limits.snapshotLazyBytes, ' B')
    row('lazy share of full', Number((measured.snapshotLazyRatio * 100).toFixed(1)), Number((limits.snapshotLazyRatio * 100).toFixed(1)), ' %')
    console.log('')
    for (const failure of failures) console.log(`FAIL ${failure}`)
  }
  if (failures.length === 0) {
    console.log('perf-gate: every budget holds')
    if (selfTest) { console.error('perf-gate: --self-test expected the tiny budget to fail, but it passed. The gate is not checking what it claims to.'); process.exit(1) }
    return
  }
  console.error(`perf-gate: ${failures.length} budget${failures.length === 1 ? '' : 's'} exceeded`)
  if (selfTest) { console.error('perf-gate: --self-test, so this failure is the expected result.'); process.exit(1) }
  process.exit(1)
}

function format(value) {
  return typeof value === 'number' ? value.toLocaleString('en-US', { maximumFractionDigits: 1 }) : String(value)
}

main().catch((error) => { console.error(`perf-gate: ${error?.message ?? error}`); process.exit(2) })
