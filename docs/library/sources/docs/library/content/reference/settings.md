# Settings

> **What this is:** every settings key, what it controls, its allowed values, and where it is validated.
> **Status:** current; checked against `validate_setting` in the daemon, `validate_setting_value` in storage, and the settings index on 19 October 2026; the task settings and the look values checked on 22 October 2026
> **Last updated:** 2026-10-22

## Purpose

Settings are non-secret local preferences stored in the `settings` table and read through `settings.get`. They are not provider credentials and must never contain one. The daemon refuses a key that contains `token`, `secret` or `password` in its name (`crates/bloblex-daemon/src/main.rs:1377-1379`).

Two validators matter:

- `validate_setting` in `crates/bloblex-daemon/src/main.rs:1342-1381` runs on `settings.set`. It normalises the accent to lower case and trims `profile.about`.
- `validate_setting_value` in `crates/bloblex-storage/src/lib.rs:1268-1292` runs on every write, including backup import, so a restored value is held to the same rules as one typed in the app.

## How writes work

`settings.set {key, value}` returns `{saved:true}` or an `invalid_argument` error. A real change to a window-level setting emits `settings.changed {key, value}`; `exec_gate.*` emits `{key, enabled}`; `permissions.default_mode` emits `{key, mode}`. A no-op write emits nothing.

`remote.*` keys are refused by `settings.set` and move only through the `remote.*` methods (`crates/bloblex-daemon/src/main.rs:1294-1296`).

## The keys

### Appearance

| Key | Values | Default | What it does |
| --- | --- | --- | --- |
| `appearance.style` | `bitbots`, `blobots` | `bitbots` | The look. Any other value is refused (`crates/bloblex-daemon/src/main.rs:1381`). The retired `legacy`, `pop` and `dot` values were removed on 21 October 2026 and are stored as `bitbots` when the database opens and when a backup is restored. |
| `appearance.theme` | `system`, `dark`, `light` | `system` | Resolved theme. |
| `appearance.accent` | empty or `#rrggbb` | empty | User accent; stored lower-case. |
| `appearance.wallpaper` | `lake`, `dusk`, `bloom`, `sand`, `custom` | `lake` | Frost wallpaper. |
| `appearance.glass` | `solid`, `balanced`, `clear` | `solid` | Frost translucency. |
| `appearance.font` | empty or lower-case letters, digits, hyphen, ≤ 40 | empty | Interface font id. |
| `appearance.monoFont` | same | empty | Code font id. |
| `appearance.textSize` | `small`, `default`, `large`, `larger` | `default` | Text scale. |
| `appearance.density` | `compact`, `default`, `roomy` | `default` | Row spacing. |

Validation: style, wallpaper, glass, font, monoFont and accent are in the daemon; density, textSize and theme are stored by the general path. A custom wallpaper's image is a file, not a setting.

### Companion

| Key | Values | Notes |
| --- | --- | --- |
| `companion.openAtStartup` | boolean | Opens the companion when Bitbots starts. |
| `companion.startPosition` | `launch` or `last` | Bottom centre or the remembered position. |
| `companion.hotkey` | boolean | Registers the show/hide shortcut. |
| `companion.focusMode` | boolean | Suppresses peeks and cues, not approvals. |
| `companion.positions` | object of at most 8 display names to `{x,y}` numbers | Remembered per display. |
| `companion.chatSize` | `small`, `medium`, `large` (UI values) | Companion chat size. |
| `companion.pinnedBlobs` | array of bot ids | Pinned companion bots. |
| `companion.soundsEnabled` | boolean | Companion cues. |
| `companion.soundVolume` | number 0–1 | Cue volume. |

Validation: `focusMode` is a JSON boolean and `positions` is checked by `valid_companion_positions` (`crates/bloblex-daemon/src/main.rs:1389-1398`). The other companion keys are stored as sent by the UI; the UI validates their shape.

### Speech and dictation

| Key | Values | Notes |
| --- | --- | --- |
| `speech.enabled` | boolean | Microphone and `Ctrl+E`. |
| `speech.engine` | `local` or the cloud choice | Which engine is preferred. |
| `speech.model` | a model id from the pinned catalog | The on-device model. |
| `speech.cloud.consent` | boolean | Explicit cloud consent. |
| `speech.cloud.consentAt` | RFC 3339 string or null | When consent was given. |

No audio or transcript is stored in settings. Validation is by the UI and the speech layer; the daemon stores the values.

### Assistant behaviour

| Key | Values | Default | Notes |
| --- | --- | --- | --- |
| `permissions.default_mode` | `ask`, `auto` | `ask` | Global default; bypass is refused here. |
| `composer.busySendMode` | `steer`, `queue` | `steer` | What a send does while a turn runs. |
| `concurrency.botsAtOnce` | integer 1–16 | 4 | Global turns at once. |
| `retry.maxWaitSecs` | integer 0–86,400 | 21,600 | Longest wait for a usage reset; 0 means never wait. |
| `questions.expirySecs` | integer 1,800–604,800 | — | How long a structured question waits. |
| `claude.enableWorkflows` | boolean | on | Claude dynamic workflows and Ultracode. |
| `conversations.autoTitle` | boolean | — | Title a conversation from its first prompt. |
| `automations.paused` | boolean | false | Global automation pause. |
| `automations.maxConcurrent` | integer 1–3 | 1 | Simultaneous automation runs. |
| `skills.enabled` | boolean | true | The shared skill pool. |
| `memory.sharedAgentWrites` | boolean | false | Lets agents write project/shared notes, still unreviewed. |
| `notifications.enabled` | boolean | true (UI treats absent as on) | Windows notifications. |

Validation: all of these are in the daemon validator except `composer.busySendMode`, which the UI validates. The storage validator repeats the ones a backup can restore.

### Experimental features

Each is a boolean stored as `experimental.<name>`:

`changeReview`, `messageActions`, `search`, `autoTitles`, `undo`, `shortcuts`, `resumeAfterUsageLimits` (default on), `autoRetry` (default off), `memory`, `approvalBadge`, `sidebarModel`, `botLock`.

Additional experimental keys used by the interface: `experimental.usageTips`, `experimental.usageTipDismissals`, `experimental.activityDetails`, `experimental.runtimeLogos`, `experimental.usageBar`, `experimental.bitbots`. The first two are validated in storage; the rest are UI preferences.

### Tasks (22 October 2026)

| Key | Values | Default | What it does |
| --- | --- | --- | --- |
| `task.concurrency.max` | integer 1 to 3 | 1 (not stored) | How many tasks may run at once. Bots at once (`concurrency.botsAtOnce`) also applies. Checked in `crates/bloblex-daemon/src/main.rs:1404`. |
| `task.globalPaused` | boolean | `false` | While `true`, queued tasks do not start. Checked in `crates/bloblex-daemon/src/main.rs:1405`. |

Neither key has a control in the desktop Settings page as of this pass. They are set through `settings.set`. See [task board](task-board.md).

### Execution gates

`exec_gate.<provider>.<option>` is a JSON boolean. Observed keys:

- `exec_gate.claude.model`, `.thinking`, `.instructions`
- `exec_gate.codex.model`, `.thinking`, `.serviceTier`, `.instructions`, `.steer`
- `exec_gate.opencode.model`, `.thinking`, `.instructions`

A closed gate makes the corresponding non-null option return `unsupported` with a safe execution-check message. `exec_gate.codex.steer` is seeded open; a one-time migration opened an existing closed gate once.

### Profile, onboarding and hints

| Key | Values | Notes |
| --- | --- | --- |
| `profile.name` | string | Your display name. |
| `profile.about` | string up to 1,500 characters, trimmed | What the bots know about you; checked for credential markers and injection text. |
| `onboarding.tour` | `{version, done, step}` | Tour progress. |
| `hints.seen` | array of hint ids | One-time pointers. |

`profile.about` and the tour state are validated by the daemon and storage; `profile.name` is a plain string.

### Editor, power, diagnostics and internal markers

| Key | Values | Notes |
| --- | --- | --- |
| `editorExecutable` | string path | Editor used by "open file". |
| `editorArgs` | array of strings | Editor arguments. |
| `power.keepAwake` | boolean | Keep the computer awake while turns run. |
| `diagnostics.logLevel` | `info`, `debug` | Takes effect at the next daemon start; dependencies stay at info. |
| `agents.maxConcurrency` | integer | Still stored for compatibility; the per-bot cap is no longer enforced. |
| `migration.managerIntroduced` | internal marker | One-time Manager migration. |
| `migration.steerGateOpened` | internal marker | One-time steer gate migration. |
| `migration.opencodeEffortGateOpened` | internal marker | One-time OpenCode effort gate migration. |
| `migration.sessionProjectBackfill` | internal marker | One-time session project backfill. |

`editorExecutable`, `editorArgs` and `power.keepAwake` are stored as sent; the native layer validates a path when it uses it. Migration markers are internal and not shown in the UI.

### Remote

`remote.enabled`, `remote.port`, `remote.servePort`, `remote.method`, `remote.nativePort`, `remote.security` and the Native account, certificate, UPnP and external-address values are never written through `settings.set`. They move through `remote.*` methods and are validated there.

## What the contract says and what the code does

`docs/ipc-contract.md:227` says settings.set accepts only an allowlist and refuses anything else. The code does not enforce a closed allowlist: `validate_setting` checks the keys in the tables above and refuses credential-looking key names, but an unknown non-secret key with a JSON value is stored. Treat the code as authoritative for behaviour and the contract as the intended policy. This difference is recorded here rather than silently repeating the stricter claim.

## Gotchas

- **A setting is not a credential store.** Any key whose name contains `token`, `secret` or `password` is refused.
- **The accent is a colour, not a CSS value.** `rgba(...)` and named colours are refused.
- **`profile.about` is persona, not memory.** Editing it changes the instruction hash and starts a new provider thread where the provider requires it.
- **A backup import runs the same validator.** A value the app would refuse cannot arrive through a restored file.
- **`remote.*` is not a settings namespace for clients.** Use the Remote page or the `remote.*` methods.
