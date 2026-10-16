# Remote mode: product specification

**Status: design with a browser mock. Not implemented in the daemon.** Written 15 October
2026; amended 16 October 2026 for the owner's choice of Tailscale, which replaces the relay and
the end-to-end Noise channel of the first draft. Companion documents:
[ARCHITECTURE](ARCHITECTURE.md), [THREAT_MODEL](THREAT_MODEL.md), [PROTOCOL](PROTOCOL.md),
[UX_FLOWS](UX_FLOWS.md), [PHASES](PHASES.md).

## 1. What it is

Remote mode lets a person use the bots running on their computer from somewhere else: a
phone, a tablet, a browser on another machine, or Bitbots on a second computer. The computer
stays the one place where work happens. The remote device is a window onto it.

The person installs Tailscale on the computer and the phone, turns Remote on once, and pairs
each device with a short code that they approve on the computer. From then on they can open
Bitbots from anywhere their tailnet reaches, see which bots are working or waiting, read
conversations, and send messages. Approving a request from a phone is off by default and is a
separate, explicit choice.

## 2. Goals

1. **Reach.** See and talk to your bots from a phone or any browser, with the same names,
   looks and status as on the desktop.
2. **Many computers.** One device can be paired with several computers; one computer can
   serve several devices. In v1 each computer is its own installed app at its own address.
3. **The computer stays in charge.** Everything runs on the host, inside its approval mode.
   Remote adds a way to ask, not a way around the rules.
4. **No Bitbots account.** Pairing uses a one-time code and the owner's approval. There is
   nothing to sign up for with Bitbots and no Bitbots-held list of a person's computers. The
   person needs their own Tailscale account.
5. **Private by construction.** Traffic stays inside the person's tailnet, encrypted by
   WireGuard and served over HTTPS. Bitbots runs no server. Tailscale's coordination service
   sees which nodes exist, as it does for any tailnet, but not the traffic.
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
- Reaching the computer from the open internet. Remote never uses Tailscale Funnel.
- A Bitbots-run relay or a direct listener on the local network. Both were in the first draft
  and are removed.

## 4. People and situations

| Person | Situation | What Remote gives them |
|---|---|---|
| The commuter | A long task is running at home. | Check progress, answer a question, send "continue" from the train. |
| The reviewer | A bot is waiting for approval while they are away from the desk. | See what it wants; approve from the phone if they allowed that, otherwise know to come back. |
| The two-computer user | Work laptop and a home desktop, each with bots. | One installed app per computer in v1; a switcher between them comes later. |
| The cautious user | Does not want a phone to be able to run commands. | Devices default to chat only; approvals from remote are off; quiet hours; one switch turns it all off. |

## 5. Concepts

- **Host**: a computer running Bitbots with Remote on. Has a name, "Work PC" by default.
- **Device**: a phone, tablet, browser or second computer paired with a host.
- **Pairing code**: eight characters, `K7QM-4XPD`, valid for five minutes, with five tries
  before it is burned, shown with a QR pattern of the computer's address. The owner then
  approves the device on the computer.
- **Tier** (what a device may do): **View only** (`viewer`), **Chat** (`chat`), **Chat and
  approve** (`operator`). The owner picks it when approving; **Chat** is preselected. "Chat and
  approve" only acts while "Approve requests from remote devices" is on.
- **Tailnet**: the person's private Tailscale network. Only its members can reach the
  computer's Remote address, `https://<computer>.<tailnet>.ts.net`.
- **Device sign-in**: after approval the device holds a cookie the computer recognises. The
  computer keeps only a fingerprint (hash) of it.

## 6. Rules the product follows

1. **Off by default.** Nothing listens or is published on the tailnet until the person turns
   Remote on and confirms a plain-language dialog.
2. **One switch to stop.** Turning Remote off disconnects every device immediately, stops the
   listener and removes Bitbots' entry from `tailscale serve`, and nothing else. Paired devices
   are kept so turning it back on is quick.
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
- Zero message text in logs, push payloads and the activity list.

## 9. What the browser mock does and does not prove

It proves the flows read well: pairing, device list, tiers, safety options, multiple
computers, offline and asleep hosts, a locked approval on a phone, install and notification
cards. It does **not** prove anything about Tailscale, networking, cookies, latency, battery or push
delivery. The mock is labelled "Preview" everywhere a person could mistake it
for a live connection.
