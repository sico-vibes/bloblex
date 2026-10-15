# Remote mode: UX flows

**Status: design, with every state below reachable in the web preview.** Written 15 October
2026. Preview URLs assume `npm run dev --workspace @bloblex/desktop` with the preview config
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

### 1.2 Turning it on

1. Switch pressed: dialog "Turn on Remote?" explains in one paragraph that this computer will
   connect to a relay, that a message from a paired device makes a bot work here within the
   approval mode, and that it can be turned off at any time. Buttons: **Not now**, **Turn on**.
2. Status row appears: "Connecting..." then "Online as Work PC", relay name, latency, and
   "N of M devices connected".
3. A **Keep this computer awake** row links to Power settings: Remote only works while the
   computer is on.

### 1.3 Add a device

1. **Show pairing code** (disabled until the link is online).
2. The panel shows a QR pattern, the code `K7QM-4XPD` in large monospace, the relay address,
   and a countdown. Buttons: **New code**, **Cancel**.
3. A device completes pairing: a green confirmation row "Pixel 8 is connected" replaces the
   panel; **Done** returns to the button. The device appears in the list and in Recent
   activity. In the preview, **Simulate a phone pairing** acts as the phone.

### 1.4 Devices

Per row: icon by kind, name, platform and "Online now" or "Last seen 2 h ago", a **tier**
select (View only, Chat, Chat and approve) and a remove button. Removing asks once, in plain
words ("It is signed out now and has to pair again").

"Chat and approve" appears only when "Approve requests from remote devices" is on. Switching
that off downgrades operators to Chat and writes an activity line.

### 1.5 Safety

- **Approve requests from remote devices**: off. Hint explains that a phone message can make a
  bot run commands.
- **Remove devices that go quiet**: 7, 30, 90 days or never (default 30).
- **Quiet hours**: remote devices can read but not send between two times.

### 1.6 Recent activity and Advanced

- Up to eight lines: paired, removed, connected, disconnected, prompt sent, approval, denied.
  One short sentence each, never message text.
- **Also listen on this network**: off, with the address and a trust warning when on.

### 1.7 Elsewhere on the desktop

- Search: "phone", "pwa", "relay", "mobile" find the page.
- Companion: a later "Phone connected" chip (see PHASES).
- Sidebar chip "Remote on, 2 devices" is a P1 item; not in the mock.

## 2. Device side: Bitbots Remote (`/remote.html`)

On a phone the app is full screen; on a desktop browser it sits in a 390 px frame. A thin
ribbon says "Preview, simulated, not connected to a relay" on every screen.

### 2.1 Connect

Heading "Connect to your computer", one sentence of instruction, **Pairing code** field
(auto-formats to `XXXX-XXXX`, monospace), **Name this device**, **Connect**, and a disabled
**Scan QR code** (needs a camera). A hint explains one-time codes, expiry and that messages are
sealed end to end. In the preview any eight characters work.

### 2.2 Bots

- Top bar: logo and the **computer switcher** (state mark, name, state word).
- If any bot is waiting, a banner "1 needs you" sits above the list.
- Rows: avatar, name, **role chip to the right of the name**, one status line (never a repeat
  of the role), a mark for waiting or working.
- Tab bar: **Bots** (with a count badge when someone needs you) and **This device**.

### 2.3 Computer switcher

A bottom sheet "Your computers": each host with state mark, name, "Online, 5, 1 waiting" or
"Asleep, last seen 2 h ago", and **Add a computer**. Choosing a host swaps the list. Escape or
tapping outside closes it.

### 2.4 Asleep or offline host

Full-height message: icon, "Home laptop is asleep", what that means and what to do ("Wake the
computer and it will show up here..."), **Check again** and **Switch computer**. Nothing is
queued.

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

Device name; facts (computer, what this device may do, "Sealed end to end, through a relay");
an **Install** card (Share > Add to Home Screen, or Install app); a **Notifications** switch
("a quiet notification with no message text"); **Forget this computer**.

## 3. Copy rules

1. Say "computer" for the host and "device" for the phone. Never "server" or "node".
2. Say what a tier lets a device do in a verb phrase, not a role name.
3. Every state that blocks an action says why and what to do.
4. Never show message text in activity, notifications or the relay's view.
5. The preview ribbon is never removed from a screen that could be mistaken for live.

## 4. Accessibility

Targets 44 px on the device; switches have names and `aria-checked`; the pairing code is read
character by character; the countdown is a live region only at the start and end; the host
switcher is a dialog with Escape; motion respects reduced motion; contrast follows the app
tokens in both looks and both themes.
