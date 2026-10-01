import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stageScript = join(repoRoot, 'scripts', 'stage-daemon.mjs')
const hostTripleResult = spawnSync('rustc', ['-vV'], { cwd: repoRoot, encoding: 'utf8' })
assert.equal(hostTripleResult.status, 0, 'Rust host target triple is required for staging tests')
const hostTriple = hostTripleResult.stdout.match(/^host: (.+)$/m)?.[1]
assert.ok(hostTriple, 'rustc must report a host target triple')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bloblex-stage-daemon-'))
  const cargoTarget = join(root, 'custom-cargo-target')
  const destination = join(root, 'staged-output')
  return {
    root,
    cargoTarget,
    destination,
    async dispose() { await rm(root, { recursive: true, force: true }) },
  }
}

async function writePair(targetDirectory, profile, contents = {}) {
  const profileDirectory = join(targetDirectory, profile)
  await mkdir(profileDirectory, { recursive: true })
  const result = {}
  for (const binary of ['bloblexd', 'bloblex-hook']) {
    if (contents[binary] === null) continue
    const bytes = contents[binary] ?? randomBytes(97)
    const source = join(profileDirectory, `${binary}.exe`)
    await writeFile(source, bytes)
    result[binary] = { source, bytes }
  }
  return result
}

function runStage(fixture, args = []) {
  return spawnSync(process.execPath, [stageScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CARGO_TARGET_DIR: fixture.cargoTarget,
      BLOBLEX_STAGE_DESTINATION: fixture.destination,
    },
  })
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

for (const profile of ['debug', 'release']) {
  test(`stages both ${profile} binaries from the custom Cargo target without executing them`, async (t) => {
    const current = await fixture()
    t.after(() => current.dispose())
    const sources = await writePair(current.cargoTarget, profile)

    const result = runStage(current, profile === 'release' ? ['--release'] : [])

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    for (const binary of ['bloblexd', 'bloblex-hook']) {
      const destination = join(current.destination, `${binary}-${hostTriple}.exe`)
      assert.equal(sha256(await readFile(destination)), sha256(sources[binary].bytes))
      assert.ok(result.stdout.includes(sources[binary].source), `stdout should report staged source ${sources[binary].source}`)
      assert.ok(result.stdout.includes(destination), `stdout should report staged destination ${destination}`)
    }
    assert.equal(await readFile(sources.bloblexd.source).then(sha256), sha256(sources.bloblexd.bytes))
    assert.equal(await readFile(sources['bloblex-hook'].source).then(sha256), sha256(sources['bloblex-hook'].bytes))
  })
}

test('fails before copying when either required binary is missing', async (t) => {
  const current = await fixture()
  t.after(() => current.dispose())
  const sources = await writePair(current.cargoTarget, 'debug', { 'bloblex-hook': null })

  const result = runStage(current)

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /bloblex-hook\.exe/)
  assert.match(`${result.stdout}\n${result.stderr}`, /cargo build/i)
  assert.equal(await readFile(join(current.destination, `bloblexd-${hostTriple}.exe`)).catch(() => null), null)
  assert.equal(await readFile(sources.bloblexd.source).then(sha256), sha256(sources.bloblexd.bytes))
})
