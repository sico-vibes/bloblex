# Remote mode: product specification

**Status: design with a browser mock. Not implemented in the daemon.** Written 15 October
2026. Companion documents: [ARCHITECTURE](ARCHITECTURE.md), [THREAT_MODEL](THREAT_MODEL.md),
[PROTOCOL](PROTOCOL.md), [UX_FLOWS](UX_FLOWS.md), [PHASES](PHASES.md).

## 1. What it is

Remote mode lets a person use the bots running on their computer from somewhere else: a
phone, a tablet, a browser on another machine, or Bitbots on a second computer. The computer
stays the one place where work happens. The remote device is a window onto it.

The person turns Remote on once, pairs devices with a short code, and from then on can open
Bitbots from anywhere, see which bots are working or waiting, read conversations, and send
messages. Approving a request from a phone is off by default and is a separate, explicit
choice.

## 2. Goals

1. **Reach.** See and talk to your bots from a phone or any browser, with the same names,
   looks and status as on the desktop.
2. **Many computers.** One device can be paired with several computers and switch between
   them; one computer can serve several devices.
3. **The computer stays in charge.** Everything runs on the host, inside its approval mode.
   Remote adds a way to ask, not a way around the rules.
4. **No account.** Pairing uses a one-time code and a device key. There is nothing to sign up
   for and no Bitbots-held list of a person's computers.
5. **Private by construction.** Messages are sealed between the device and the host. A relay
   moves bytes it cannot read and stores no content; it does see device and host identifiers,
   addresses, frame sizes and timing.
6. **Revocable and visible.** Every device has a name, a last-seen time and a Remove button.
   Remote activity is listed (without message text).

## 3. Non-goals

- Running bots in the cloud. There is no hosted Bitbots execution; if the computer is off,
  nothing runs.
- Remote administration. Changing settings, creating or deleting bots, adding coding agents,
  editing automations or memory, and reverting files stay on the computer. See the method
  tiers in [PROTOCOL.md](PROTOCOL.md).
- A companion window, tray, global shortcuts, native dictation or "open in editor" on remote
  devices. They need the desktop.
- Syncing transcripts between devices. Each device asks the host.
- Team accounts, sharing a computer with other people, or enterprise policy. Later.

## 4. People and situations

| Person | Situation | What Remote gives them |
|---|---|---|
| The commuter | A long task is running at home. | Check progress, answer a question, send "continue" from the train. |
| The reviewer | A bot is waiting for approval while they are away from the desk. | See what it wants; approve from the phone if they allowed that, otherwise know to come back. |
| The two-computer user | Work laptop and a home desktop, each with bots. | One list of computers, switch with a tap, each with its own bots. |
| The cautious user | Does not want a phone to be able to run commands. | Devices default to chat only; approvals from remote are off; quiet hours; one switch turns it all off. |

## 5. Concepts

- **Host**: a computer running Bitbots with Remote on. Has a name, "Work PC" by default.
- **Device**: a phone, tablet, browser or second computer paired with a host.
- **Pairing code**: eight characters, `K7QM-4XPD`, valid once for five minutes, shown with a QR
  pattern. Pairing binds the device's public key to the host.
- **Tier** (what a device may do): **View only**, **Chat**, **Chat and approve**. Default
  **Chat**. "Chat and approve" is only offered while "Approve requests from remote devices"
  is on.
- **Relay**: a Bitbots-hosted forwarding service. It sees device and host identifiers and
  frame sizes, never content.
- **Direct address** (advanced): a listener on the local network that skips the relay.

## 6. Rules the product follows

1. **Off by default.** Nothing listens, connects or advertises until the person turns Remote
   on and confirms a plain-language dialog.
2. **One switch to stop.** Turning Remote off disconnects every device immediately and closes
   the relay connection. Paired devices are kept so turning it back on is quick.
3. **A prompt is code execution.** The dialog and the Safety page say so in those terms.
4. **Never silent.** A remote prompt appears in the conversation on the host with its source
   device. Remote activity lists connections, pairings, removals and approvals.
5. **No queueing surprises.** If the computer is offline, a message is not held and delivered
   later. The device says so and keeps the draft.
6. **The host decides.** Quiet hours, tiers, approvals-from-remote and expiry are enforced on
   the host, not trusted from the device.
7. **Nothing sensitive crosses.** No credentials, provider tokens, environment values or raw
   instruction text are sent to a device. Paths are shortened. See redaction in
   [PROTOCOL.md](PROTOCOL.md).

## 6a. Wording

The characters are "bots" in the Bitbots look and "blobs" in Blobots; Remote follows the
look chosen on the host. Copy in this folder says "bot" unless it quotes the Blobots look.

## 7. Screens

Host (desktop): **Settings > Remote**. Device: **Bitbots Remote** (`/remote.html`). Every
state is described in [UX_FLOWS.md](UX_FLOWS.md) and exists in the web preview.

## 8. Success measures (for when it is built)

- A new phone is paired and reading a conversation in under a minute, without documentation.
- A person can state, after setup, what the phone can and cannot do.
- Revoking a device takes effect on the next frame (under two seconds when online).
- Zero message text in relay logs, push payloads and the activity list.

## 9. What the browser mock does and does not prove

It proves the flows read well: pairing, device list, tiers, safety options, multiple
computers, offline and asleep hosts, a locked approval on a phone, install and notification
cards. It does **not** prove anything about networking, encryption, latency, battery, push
delivery or the relay. The mock is labelled "Preview" everywhere a person could mistake it
for a live connection.
