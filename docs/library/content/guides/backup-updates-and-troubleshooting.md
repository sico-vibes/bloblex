# Backup, updates and troubleshooting

> **What this is:** move Bitbots to another computer, keep it updated, and get out of the common failures without losing work.
> **Status:** current for the content as written for v0.1.0-beta.35; not re-checked for `main` on 22 October 2026 (the task board is covered in the tasks guide)
> **Last updated:** 2026-10-22

## Before you start

Backups are local files you choose. They are not uploaded anywhere. Updates come from the Bitbots release page; the app checks, downloads and installs them, but never without your confirmation. Diagnostics are a local file you choose to save.

Neither a backup nor a diagnostics export contains coding-agent passwords or sign-ins. A backup can contain bot instructions, memory and settings, so treat it as private.

## Back up

1. Open **Settings › Backup**.
2. Choose what to include: bots are always included; memory notes, skills, automations and app settings are optional.
3. Choose a file path in the save dialog.
4. Save. Bitbots writes the file in one go, so a failed save does not leave half a backup.

Coding-agent sign-ins and environment values are not included. Full access is restored as Ask first; only one leader flag is kept; a bot whose coding agent is not installed is skipped with a warning.

### Restore

1. Choose **Restore a backup** and select the file.
2. Bitbots checks the file and shows a preview: what it will restore, what clashes and what it will skip.
3. Resolve clashes. A bot that already exists can be renamed, replaced or skipped; a skill can be replaced or skipped; identical notes and settings are detected.
4. Import. Bitbots applies the selected parts and tells you what it imported.

A damaged or edited file is refused with "The backup file is damaged or was edited." A backup from a newer Bitbots may be refused as unsupported.

## Update

Bitbots checks about 15 seconds after start and then every 6 hours when automatic checks are on. **Check now** works regardless. A found update shows a badge and a banner; it never installs itself.

- **Channel:** beta is the default while only betas exist; stable offers finished releases only.
- **Install:** the download shows progress, then the installer runs with a progress bar and relaunches Bitbots. If a turn is running or waiting for approval, Bitbots warns first and requires confirmation, because running turns end when the app closes.
- **Verification:** Bitbots checks the update's signature before installing it. That is separate from Windows publisher signing, so a first manual install may still show SmartScreen.
- **No downgrade:** Bitbots never offers an older version.

A network failure, bad signature, missing update file or missing stable release is shown as a short safe message and never blocks the app.

## Troubleshoot

### Bitbots cannot reach its background service

The connection banner offers **Retry**. Bitbots reconnects and reloads the current state. If retry fails repeatedly, close Bitbots fully, including the tray icon, and reopen it.

Before restarting, export diagnostics if you need to report the problem. Bitbots keeps its data in its own app-data folder; do not delete it to "reset" the app. Restore a backup or ask for help first.

### A coding agent is missing or signed out

Open Settings › Agents. The card names the program, its version and whether it looks signed in. Install the tool, confirm it runs in a new terminal, then **Scan again**. A tool installed after Bitbots started is not found until the scan runs.

### Turns fail immediately

Read the coding agent's message and the turn error. Common causes are a signed-out tool, a model it does not offer, a usage limit, and a project folder that no longer exists. A usage limit becomes **Limited** with a reset time; a temporary failure may be retried automatically when that experiment is on.

### Downloads or updates fail

Check the network and the release channel. A signature failure is not retried by hand: download the installer from the release page and install it once. If the update file is missing, the channel may have no release yet; stable says "no stable release yet" until a finished release exists.

### Export diagnostics

Settings › General has **Export diagnostics**. The preview lists what the file will contain; the export saves it through a normal save dialog. It includes the logs and app state needed to diagnose a problem, and never coding-agent passwords or sign-ins. Diagnostics are never available to a remote device.

Support may ask for more detailed logs; that is a separate troubleshooting step and is not needed for normal use.

### A backup will not import

Check that the file is the single backup Bitbots wrote, not a renamed archive. A damage check failure means the file changed after export. A newer format needs a newer Bitbots. If a bot's coding agent is not installed, the preview warns and skips that bot rather than failing the whole import.

## Check the result

- A backup is one file Bitbots can read back.
- The restore preview lists what will change before anything is applied.
- The app shows the version it is running in Settings › Updates.
- Diagnostics export produces a file and leaves Bitbots running.
- After a restore, the bots, notes and settings you selected are present, and no coding-agent sign-in was copied.

## If you are still stuck

Collect the diagnostics export, the exact version from Settings › Updates, the coding agent's name and version, and the last safe error message. Do not include a password, a sign-in or conversation text in a report. The release notes list what changed in each version.

How it works: [release and updates](../reference/release-and-updates.md).
