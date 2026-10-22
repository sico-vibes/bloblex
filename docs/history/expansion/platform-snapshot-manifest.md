# Platform lane paused snapshot manifest

> **Status:** historical record, superseded in part (see update).
> **Last updated:** 2026-10-22

**Update 22 October 2026.** The owner resumed the expansion on 21 October 2026. This manifest records the platform worktree at the pause. Its files are not merged to `main`, which now holds phase 1 (see [status.md](../expansion-v2/status.md)); the hashes below are not a source of truth for `main`.

Repository baseline: `64344a6` (`beta.36`). Platform checkout: `C:\Users\SicoZ\.codex\worktrees\bitbots-platform\Blolblex`. All hashes below are SHA-256 of the current platform worktree bytes, calculated read-only after the implementation pause. They are not commit IDs. The new files and source edits remain uncommitted.

## Source files in this snapshot

| File | SHA-256 |
| --- | --- |
| `crates/bloblex-daemon/src/platform/connectors.rs` | `4B98901FDF99F60729B453969F99499397523E2F466E82C6A613EA7635A6B5F4` |
| `crates/bloblex-daemon/src/platform/free.rs` | `5EA49EF8B73783D4EF56CF646E85848E23625B8E194DD47F940E9AF5ED2F0740` |
| `crates/bloblex-daemon/src/platform/github.rs` | `65AD9E1DBAED666060E6DB22E1DB85C4594C9CC107F9A17E9C8B6154EE736246` |
| `crates/bloblex-daemon/src/platform/mod.rs` | `2DF2668C359BBC557F33B83A08ED6B1D8B0E3433B53A14A82A353ECF04E269FF` |
| `crates/bloblex-relay/src/lib.rs` | `6640528DF40FB9A9B1340E856D8244C2F0C3CAF6369FF52F586333FBB744F233` |
| `crates/bloblex-relay/src/service.rs` | `D18401C9FF4FA55986E3C779A977B2CA31E052BF131A60AEEB453C581F15D523` |
| `crates/bloblex-relay/Cargo.toml` | Not separately hashed; see current worktree. It is missing a `tokio-tungstenite` dev dependency for the service test. |
| `apps/desktop/src-tauri/src/pty.rs` | `208BEC6694D34F87C1D8331A40B59A5778C52E7AFB6C8DACF435C9C446499D3B` |
| `apps/desktop/src-tauri/src/lib.rs` | `3503C721CBB7A2DC8AFFD8D92D357EFD0DA75986B2F912CF8F340E0EBD687401` |
| `crates/bloblex-runtime/src/lib.rs` | `7D6C59C17DBDE153A2392DE6CBDC3BA92EF43AADF164B2F292FCB3496415709B` |
| `crates/bloblex-adapter-acp/src/catalog.rs` | `1692DFEF5D5B34F19E97F90DD81F255C707367F2CC0CB70F7F21965877989A58` |
| `crates/bloblex-adapter-acp/src/exec.rs` | `CFC38624FB623B4A2D02064D0AE18212E20F74DE15BAB14201BD30D553A92472` |
| `crates/bloblex-adapter-acp/src/lib.rs` | `6CE3C0DD1385C34BBA236FD6C5FBB0B7B34E0DC9D7A7A4760670495DFBBCBB4F` |
| `Cargo.toml` | `07D0AC90C118FFFB3F420F7132CF9F899F8CED666635AB5961C52DB8515D0E71` |
| `Cargo.lock` | `41F58F9657A4013A83071E62F2A7896A51E810B1419B2434939267C0ADF7B513` |
| `crates/bloblex-daemon/Cargo.toml` | `32967CEE322AE179744EFC660F6F0D11DD2D64AEBBD77355D202F7CA6FE6184C` |
| `apps/desktop/src-tauri/Cargo.toml` | `2A00E890CA5C242B8BA773456CDB40F9252213B55704DB31D82CA1A118338F40` |
| `docs/history/expansion/platform-contract.md` | `E4826D8D87B4BF39AC7F384FADE1A34136BB588F02AA49BB9131628E32CDF272` |
| `docs/history/expansion/platform-report.md` | `ABB15D910327DC6B257822C2181A4E9E5005556695263EE1C49E1C014197D8CA` |
| `docs/legal/third-party-notices.md` | `28D63A9B6E4AB6B5C54C03EE47C36F86B02F6DFBBECE05DA2AB61142364C9AD9` |

## Worktree status

Tracked modifications:

- `.claude/skills/bitbots-development/references/codebase-map.md`
- `.claude/skills/bitbots-development/references/lessons.md`
- `Cargo.toml`, `Cargo.lock`
- `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/src-tauri/gen/schemas/desktop-schema.json`, `apps/desktop/src-tauri/gen/schemas/windows-schema.json`
- `crates/bloblex-adapter-acp/src/catalog.rs`, `exec.rs`, `lib.rs`
- `crates/bloblex-daemon/Cargo.toml`
- `crates/bloblex-runtime/src/lib.rs`
- `docs/legal/third-party-notices.md`

Untracked additions:

- `apps/desktop/src-tauri/src/pty.rs`
- `crates/bloblex-daemon/src/platform/{mod.rs,github.rs,free.rs,connectors.rs}`
- `crates/bloblex-relay/{Cargo.toml,src/lib.rs,src/service.rs}`
- `docs/history/expansion/{platform-contract.md,platform-report.md,platform-snapshot-manifest.md}`

The generated Tauri schemas changed during native context generation and include the new native command definitions. Their provenance/content has not received final review. Keep them for reconciliation; do not blindly copy or revert them. `crates/bloblex-daemon/src/main.rs`, `crates/bloblex-storage/src/lib.rs`, task/remote integration, all UI files and user `verification.md` are not modified in this platform worktree.

## Cross-worktree copies known from messages

The tasks lane previously reported these copied snapshot hash prefixes: its `platform/mod.rs` began `1AE5D6264E9C5F1E`; `platform/github.rs` began `94F495FB89242CDAB5`; `platform/free.rs` began `BF2C3C366E18742D`; ACP `catalog.rs`, `lib.rs`, `exec.rs` began `1692DFEF5D5B34F1`, `6CE3C0DD1385C34B`, and `CFC38624FB623B4A` respectively. It later reported copying the current connector file with SHA-256 `4B98901FDF99F60729B453969F99499397523E2F466E82C6A613EA7635A6B5F4`. Tasks then added team calls passing session/origin/tier/unattended context and were extending Storage grant APIs with `deviceId`; this platform source hash predates that extension. Ask the tasks owner to hash its current files before merging; task-tree state may have advanced after these messages.

## Manifest and dependency delta

- Workspace now includes `crates/bloblex-relay` and pins `chacha20poly1305 = 0.10`, `ed25519-dalek = 3`, `x25519-dalek = 3`, and `hkdf = 0.12`. The crypto-only relay crate test passed before `src/service.rs` existed. The service tests import `tokio_tungstenite`, but the new crate manifest does not yet list it.
- Desktop adds `portable-pty = 0.9`; image decoding enables png/jpeg/webp.
- Daemon adds `bloblex-process`, reqwest `stream`, `url = 2`, and Windows `windows-sys` Credential Manager features.
- The lockfile contains fetched Crypto dependencies; the current lock hash above covers the untested WebSocket-service source state.
- Do not use `--locked` until manifests and lockfile have been reconciled after implementation resumes.

## Last-known process/test boundary

Read-only process check at pause found no `cargo` process. Session `61795` ended successfully on the relay crypto-only crate (3/3) before the local WebSocket service was added. No log file exists. The complete evidence and caveats are in `platform-report.md`. No new verification should run until the owner explicitly resumes implementation.
