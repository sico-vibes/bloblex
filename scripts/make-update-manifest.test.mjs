import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  buildManifest,
  defaultNotes,
  isPreRelease,
  isSemver,
  manifestToJson,
} from './make-update-manifest.mjs'

const scriptPath = fileURLToPath(new URL('./make-update-manifest.mjs', import.meta.url))
const sampleUrl = 'https://github.com/sico-vibes/bloblex/releases/download/v0.1.0-beta.1/Bloblex_0.1.0-beta.1_x64-setup.exe'
const sampleDate = '2026-10-02T15:00:00.000Z'

function base(overrides = {}) {
  return {
    version: '0.1.0-beta.1',
    notes: 'First beta',
    pubDate: sampleDate,
    signature: 'line1\nline2',
    url: sampleUrl,
    ...overrides,
  }
}

test('writes the Tauri updater manifest shape with a trailing newline', () => {
  const manifest = buildManifest(base({ signature: '\n  line1\nline2\n' }))
  assert.deepEqual(manifest, {
    version: '0.1.0-beta.1',
    notes: 'First beta',
    pub_date: sampleDate,
    platforms: {
      'windows-x86_64': {
        signature: 'line1\nline2',
        url: sampleUrl,
      },
    },
  })
  const json = manifestToJson(manifest)
  assert.equal(json.endsWith('\n'), true)
  assert.equal(json.at(-2), '}')
  assert.equal(json, `{
  "version": "0.1.0-beta.1",
  "notes": "First beta",
  "pub_date": "2026-10-02T15:00:00.000Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "line1\\nline2",
      "url": "${sampleUrl}"
    }
  }
}
`)
  assert.deepEqual(JSON.parse(json), manifest)
})

test('accepts pre-release versions and rejects malformed versions', () => {
  for (const version of ['0.1.0-beta.1', '0.1.0-beta.2', '1.0.0-rc.1', '0.1.0', '1.2.3+build.5']) {
    assert.equal(isSemver(version), true, version)
    assert.equal(buildManifest(base({ version, notes: 'n' })).version, version)
  }
  assert.equal(isPreRelease('0.1.0-beta.1'), true)
  assert.equal(isPreRelease('0.1.0'), false)
  assert.equal(isPreRelease('1.2.3+build.5'), false)
  for (const version of ['', '1', '1.2', '01.2.3', 'v0.1.0', '0.1.0-', '0.1.0-01', '0.1.0-beta.01']) {
    assert.equal(isSemver(version), false, version)
    assert.throws(() => buildManifest(base({ version })), /Invalid semver/)
  }
})

test('falls back to a one-line note when notes are missing or blank', () => {
  assert.equal(defaultNotes('0.1.0-beta.1'), 'Bloblex 0.1.0-beta.1')
  for (const notes of [undefined, null, '', '   \n']) {
    const manifest = buildManifest(base({ notes, version: '0.1.0' }))
    assert.equal(manifest.notes, 'Bloblex 0.1.0')
  }
  const kept = buildManifest(base({ notes: '  Line one\n\nLine two\n' }))
  assert.equal(kept.notes, 'Line one\n\nLine two')
})

test('trims the signature and rejects an empty one', () => {
  assert.equal(buildManifest(base({ signature: '  abcdef\r\n' })).platforms['windows-x86_64'].signature, 'abcdef')
  for (const signature of ['', '   \n', '\t', null]) {
    assert.throws(() => buildManifest(base({ signature })), /Signature is empty/)
  }
})

test('rejects non-https URLs and invalid dates', () => {
  for (const url of ['http://github.com/sico-vibes/bloblex/a.exe', 'file:///C:/a.exe', 'ftp://example.com/a.exe', '', 'not a url', 'https://']) {
    assert.throws(() => buildManifest(base({ url })), /https/)
  }
  assert.throws(() => buildManifest(base({ pubDate: 'yesterday' })), /ISO 8601/)
  assert.throws(() => buildManifest(base({ pubDate: '2026-13-40T00:00:00Z' })), /ISO 8601/)
})

test('defaults pub_date to ISO 8601 UTC and platform to windows-x86_64', () => {
  const before = Date.now()
  const manifest = buildManifest({
    version: '0.1.0-beta.2',
    signature: 'sig',
    url: 'https://example.com/Bloblex_0.1.0-beta.2_x64-setup.exe',
  })
  assert.equal(manifest.platforms['windows-x86_64'].signature, 'sig')
  assert.match(manifest.pub_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.ok(Math.abs(Date.parse(manifest.pub_date) - before) < 5000)
  assert.equal(manifest.notes, 'Bloblex 0.1.0-beta.2')
})

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'bloblex-manifest-'))
}

function runCli(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' })
}

test('CLI writes trimmed signature JSON and stays quiet on stdout', async (t) => {
  const root = await tempDir()
  t.after(() => rm(root, { recursive: true, force: true }))
  const signature = '\nCANARY-SIG-VALUE\nsecond line\n'
  const signaturePath = join(root, 'installer.sig')
  const notesPath = join(root, 'notes.md')
  const outPath = join(root, 'latest.json')
  await writeFile(signaturePath, signature)
  await writeFile(notesPath, '\nBeta notes\n')
  const result = runCli([
    '--version', '0.1.0-beta.1',
    '--notes-file', notesPath,
    '--pub-date', sampleDate,
    '--platform', 'windows-x86_64',
    '--signature-file', signaturePath,
    '--url', sampleUrl,
    '--out', outPath,
    '--quiet',
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stdout.includes('CANARY-SIG-VALUE'), false)
  assert.equal(result.stderr.includes('CANARY-SIG-VALUE'), false)
  const written = await readFile(outPath, 'utf8')
  assert.equal(written.endsWith('\n'), true)
  const parsed = JSON.parse(written)
  assert.equal(parsed.notes, 'Beta notes')
  assert.equal(parsed.platforms['windows-x86_64'].signature, 'CANARY-SIG-VALUE\nsecond line')
  assert.equal(parsed.version, '0.1.0-beta.1')
})

test('CLI notes fallback and rejection of bad inputs', async (t) => {
  const root = await tempDir()
  t.after(() => rm(root, { recursive: true, force: true }))
  const signaturePath = join(root, 'installer.sig')
  const outPath = join(root, 'latest.json')
  await writeFile(signaturePath, '  trimmed-sig  ')
  const fallback = runCli([
    '--version', '1.2.3',
    '--pub-date', '2026-10-02T00:00:00Z',
    '--signature-file', signaturePath,
    '--url', 'https://example.com/setup.exe',
    '--out', outPath,
  ])
  assert.equal(fallback.status, 0, fallback.stderr)
  assert.equal(JSON.parse(fallback.stdout).notes, 'Bloblex 1.2.3')
  assert.equal(JSON.parse(await readFile(outPath, 'utf8')).platforms['windows-x86_64'].signature, 'trimmed-sig')

  const emptySig = join(root, 'empty.sig')
  await writeFile(emptySig, ' \n')
  const rejected = [
    ['--version', 'nope', '--signature-file', signaturePath, '--url', 'https://example.com/a.exe'],
    ['--version', '1.2.3', '--signature-file', emptySig, '--url', 'https://example.com/a.exe'],
    ['--version', '1.2.3', '--signature-file', signaturePath, '--url', 'http://example.com/a.exe'],
    ['--version', '1.2.3', '--signature-file', signaturePath, '--url', 'https://example.com/a.exe', '--quiet'],
  ]
  for (const args of rejected) {
    const result = runCli(args)
    assert.notEqual(result.status, 0, args.join(' '))
    assert.equal(result.stdout.includes('trimmed-sig'), false)
  }
})
