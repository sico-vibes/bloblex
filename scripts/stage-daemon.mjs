import { copyFile, mkdir, access } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = process.argv.includes('--release') ? 'release' : 'debug'
const metadata = spawnSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
  cwd: root,
  encoding: 'utf8',
})
if (metadata.status !== 0) {
  throw new Error(`cargo metadata failed while resolving the active target directory: ${metadata.stderr || metadata.error || 'unknown error'}`)
}

let targetDirectory
try {
  targetDirectory = JSON.parse(metadata.stdout).target_directory
} catch (error) {
  throw new Error(`cargo metadata returned invalid JSON: ${error}`)
}
if (!targetDirectory) throw new Error('cargo metadata did not report a target_directory.')

const rustc = spawnSync('rustc', ['-vV'], { cwd: root, encoding: 'utf8' })
if (rustc.status !== 0) throw new Error('rustc is required to resolve the external binary target triple.')
const targetTriple = rustc.stdout.match(/^host: (.+)$/m)?.[1]
if (!targetTriple) throw new Error('rustc did not report a host target triple.')

const binaries = ['bloblexd', 'bloblex-hook']
const sourceDirectory = resolve(targetDirectory, profile)
const destinationDirectory = resolve(root, process.env.BLOBLEX_STAGE_DESTINATION || 'apps/desktop/src-tauri/binaries')
const sources = binaries.map((binary) => ({
  binary,
  source: resolve(sourceDirectory, `${binary}.exe`),
  destination: resolve(destinationDirectory, `${binary}-${targetTriple}.exe`),
}))

for (const { binary, source } of sources) {
  try {
    await access(source)
  } catch {
    const buildMode = profile === 'release' ? ' --release' : ''
    throw new Error(`Missing ${binary} at ${source}. Build it first with: cargo build -p bloblex-daemon --bin bloblexd -p bloblex-hook --bin bloblex-hook${buildMode}`)
  }
}

await mkdir(destinationDirectory, { recursive: true })
for (const { source, destination } of sources) {
  await copyFile(source, destination)
  console.log(`Staged ${source} -> ${destination}`)
}
