/**
 * Node prerender: ask GitHub for the latest release and write public/release.json.
 * A network or schema failure still writes the known beta so the page can build offline.
 */
import { writeFileSync } from 'node:fs'
import { Effect } from 'effect'
import { fetchLatestRelease } from '../src/lib/release.ts'

const out = new URL('../public/release.json', import.meta.url)

const program = Effect.gen(function* () {
  const release = yield* fetchLatestRelease
  writeFileSync(out, `${JSON.stringify(release, null, 2)}\n`)
  return release
})

Effect.runPromise(program).then((release) => {
  console.log(`Wrote ${out.pathname} (${release.fromGitHub ? 'github' : 'fallback'} ${release.version})`)
})
