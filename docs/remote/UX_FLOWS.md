# Remote mode: UX flows

> **What this is:** The UX flows for Remote mode.
> **Status:** current
> **Last updated:** 2026-10-16

**Status: design.** Written 15 October 2026; amended 16 October 2026 for the owner's choice of
Tailscale. The 15 October states are reachable in the web preview; the Tailscale states
(sections 1.2 and 1.3) are new and the preview must gain them in FIX30. Preview URLs assume `npm run dev --workspace @bloblex/desktop` with the preview config
(see `.claude/launch.json` name `bitbots-web-preview`, port 5199).

Flags on the main preview URL: `?remote=on|off`, `?devices=0|1|3`, `?host=offline`, plus the
usual `?style=bitbots|blobots` and `?accent=%23rrggbb`.

## 1. Host side: Settings > Remote

### 1.1 Off (default)

- Intro card: "Use your bots from anywhere" with one paragraph and a small drawing of a
  computer linked to a phone.
- One row: **Allow remote devices**, switch off.
- Preview note at the top: "Preview. This page is simulated."
- On a build with no remote support the page shows the intro and one row, "Not in this build
  yet", and nothing else. No dead controls.

### 1.2 Tailscale state and turning it on

The page reads `remote.status` and shows the live Tailscale state before the switch can be
used. Each blocked state names the fix in one step:

| State | Row text | Fix-it action |
|---|---|---|
| Not installed | "Tailscale isn't installed on this computer." | **Get Tailscale** (opens tailscale.com) |
| Logged out | "Tailscale is installed but signed out." | "Open Tailscale and sign in, then come back." **Check again** |
| HTTPS certificates off | "Your tailnet doesn't allow HTTPS certificates yet." | **Open admin settings** (the tailnet's DNS page) and **Check again** |
| Port in use | "Something else is already served on this computer's tailnet address." | Explains that Bitbots tried 443 and 8443 and changed nothing |
| Funnel on | "Tailscale Funnel is on for this port, which would put Bitbots on the internet." | "Turn Funnel off, then try again." |
| Ready | "Tailscale is ready as work-pc." | **Enable** becomes available |

1. **Enable** pressed: dialog "Turn on Remote?" explains in one paragraph that devices on your
   tailnet will be able to reach this computer, that a message from a paired device makes a bot
   work here within the approval mode, and that it can be turned off at any time. Buttons:
   **Not now**, **Turn on**.
2. Status row: "Starting..." then "On at work-pc.example-tailnet.ts.net" and "N of M devices
   connected". A short line says everyone on the tailnet can reach the address, and only
   approved devices can use it.
3. A **Keep this computer awake** row links to Power settings: Remote only works while the
   computer is on.

### 1.3 Add a device

1. **Add a device** (disabled until Remote is on).
2. The pairing dialog shows a QR pattern of the address, the code `K7QM-4XPD` in large
   monospace, the address in text, and a countdown from five minutes. Buttons: **New code**,
   **Cancel**. After five wrong tries the code is burned and the dialog says so.
3. A phone submits the right code: the dialog changes to "iPhone wants to connect", with the
   device's name, platform and Tailscale login (or "no Tailscale login"). A tier select
   (View only, Chat, Chat and approve) preselects **Chat**. Buttons: **Approve iPhone as Chat**
   (the label follows the select) and **Reject**.
4. On approval a confirmation row "iPhone is connected" replaces the dialog; **Done** closes
   it. The device appears in the list and in Recent activity. On reject the code is burned and
   the phone is told. In the preview, **Simulate a phone pairing** acts as the phone.

### 1.4 Devices

Per row: icon by kind, name, platform and "Online now" or "Last seen 2 h ago", a **tier**
select (View only, Chat, Chat and approve) and a remove button. Removing asks once, in plain
words ("It is signed out now and has to pair again").

"Chat and approve" can be chosen at any time, but it only lets a device approve while "Approve
requests from remote devices" is on. Switching that off keeps each device's tier; approvals from
an operator device are refused (`approvals_disabled`) until it is on again, and an activity line
records the change. The row shows "Can't approve while approvals from remote are off".

### 1.5 Safety

- **Approve requests from remote devices**: off. Hint explains that a phone message can make a
  bot run commands.
- **Remove devices that go quiet**: 7, 30, 90 days or never (default 30).
- **Quiet hours**: remote devices can read but not send between two times.

### 1.6 Recent activity

- Up to eight lines: paired, removed, connected, disconnected, prompt sent, approval, denied.
  One short sentence each, never message text.
- The 15 October **Also listen on this network** option is removed. There is no LAN listener.

### 1.7 Elsewhere on the desktop

- Search: "phone", "pwa", "tailscale", "mobile" find the page.
- Companion: a later "Phone connected" chip (see PHASES).
- Sidebar chip "Remote on, 2 devices" is a P1 item; not in the mock.

## 2. Device side: Bitbots Remote (`/remote.html`)

On a phone the app is full screen; on a desktop browser it sits in a 390 px frame. In the
preview build only, a thin ribbon says "Preview · simulated" on every screen. The real build,
served by the computer, has no ribbon.

### 2.1 Connect

The phone reaches this screen by scanning the QR on the computer, which opens the computer's
address. Heading "Connect to your computer", one sentence of instruction, **Pairing code**
field (auto-formats to `XXXX-XXXX`, monospace), **Name this device** and **Connect**. A hint
explains one-time codes, the five-minute expiry and that the computer must approve the device.

After **Connect**: "Waiting for approval on Work PC" with a spinner and **Cancel**. Then
either the bot list, or "Work PC didn't approve this device" with **Try again**. A wrong,
expired or burned code shows one message: "That code didn't work. Ask for a new one on your
computer." In the preview any eight characters work.

### 2.2 Bots

- Top bar: logo and the computer's label (state mark, name, state word). It becomes the
  switcher in P3.
- If any bot is waiting, a banner "1 needs you" sits above the list.
- Rows: avatar, name, **role chip to the right of the name**, one status line (never a repeat
  of the role), a mark for waiting or working.
- Tab bar: **Bots** (with a count badge when someone needs you) and **This device**.

### 2.3 Computer switcher

**Later (P3).** In v1 each computer is its own installed app, so the switcher shows only this
computer. The later design: a bottom sheet "Your computers" with each host's state mark, name,
"Online, 5, 1 waiting" or "Asleep, last seen 2 h ago", and **Add a computer**; choosing a host
opens that computer's address. Escape or tapping outside closes it.

### 2.4 Asleep or offline host

Full-height message: icon, "Home laptop is asleep", what that means and what to do ("Wake the
computer and it will show up here..."), and **Check again**. The page cannot tell an asleep
computer from Tailscale being off on the phone, so it also says "Check that Tailscale is on
on this phone." **Switch computer** returns with the P3 switcher. Nothing is queued.

### 2.5 Chat

- Header: back, bot name, status line.
- Messages in plain text (Markdown markers removed), user right, bot left.
- If the bot is waiting for approval: with **Chat and approve** an approval card with the
  command and the usual choices; otherwise a locked card, "This device can't approve. Approve
  it on Work PC, or ask for Chat and approve in Settings > Remote."
- Composer: 44 px target, Enter sends, Shift+Enter newline; disabled with an explanation when
  the computer is offline or the device is View only.
- Footnote: the tier and where the message runs.

### 2.6 This device

Device name; facts (computer, what this device may do, "Private to your tailnet");
an **Install** card (Share > Add to Home Screen, or Install app); a **Notifications** switch
("a quiet notification with no message text", P3); **Forget this computer**, which signs
this device out (`POST /api/logout`) so it must pair again.

## 3. Copy rules

1. Say "computer" for the host and "device" for the phone. Never "server" or "node".
2. Say what a tier lets a device do in a verb phrase, not a role name.
3. Every state that blocks an action says why and what to do.
4. Never show message text in activity or notifications.
5. The preview ribbon is never removed from a screen that could be mistaken for live.

## 4. Accessibility

Targets 44 px on the device; switches have names and `aria-checked`; the pairing code is read
character by character; the countdown is a live region only at the start and end; the host
switcher is a dialog with Escape; motion respects reduced motion; contrast follows the app
tokens in both looks and both themes.
