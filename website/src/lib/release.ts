import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

const GitHubAsset = Schema.Struct({
  name: Schema.String,
  browser_download_url: Schema.String,
  size: Schema.NullishOr(Schema.Number),
})

const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  name: Schema.NullishOr(Schema.String),
  published_at: Schema.NullishOr(Schema.String),
  assets: Schema.NullishOr(Schema.Array(Schema.Unknown)),
})

export interface ReleaseInfo {
  version: string
  name: string
  publishedAt: string | null
  installerUrl: string | null
  installerSize: number | null
  fromGitHub: boolean
}

export const FALLBACK_RELEASE: ReleaseInfo = {
  version: '0.1.0-beta.3',
  name: '0.1.0-beta.3',
  publishedAt: null,
  installerUrl: null,
  installerSize: null,
  fromGitHub: false,
}

const decodeRelease = Schema.decodeUnknownEither(GitHubRelease)
const decodeAsset = Schema.decodeUnknownEither(GitHubAsset)

/** Latest GitHub release, or the known beta when the request or payload fails. */
export const fetchLatestRelease = Effect.gen(function* () {
  const response = yield* Effect.tryPromise(() =>
    fetch('https://api.github.com/repos/sico-vibes/bloblex/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
    }),
  )
  if (!response.ok) return FALLBACK_RELEASE
  const json: unknown = yield* Effect.tryPromise(() => response.json())
  const parsed = decodeRelease(json)
  if (parsed._tag !== 'Right') return FALLBACK_RELEASE
  const release = parsed.right
  let installerUrl: string | null = null
  let installerSize: number | null = null
  for (const asset of release.assets ?? []) {
    const item = decodeAsset(asset)
    if (item._tag !== 'Right') continue
    const name = item.right.name.toLowerCase()
    if (!name.endsWith('.exe') && !name.endsWith('.msi')) continue
    installerUrl = item.right.browser_download_url
    installerSize = item.right.size ?? null
    break
  }
  return {
    version: release.tag_name,
    name: release.name?.trim() || release.tag_name,
    publishedAt: release.published_at ?? null,
    installerUrl,
    installerSize,
    fromGitHub: true,
  }
}).pipe(Effect.catchAll(() => Effect.succeed(FALLBACK_RELEASE)))
