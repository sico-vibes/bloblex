# Remote access

> **What this is:** reach your bots from a phone or another computer with Tailscale or Native, and know what a paired device may do.
> **Status:** current
> **Last updated:** 2026-10-19

## Before you start

Remote is off by default. You need:

- Bitbots running on the host computer, with the bots you want to reach;
- for Tailscale, Tailscale installed and signed in on both the host and the device;
- for Native, a username and password you choose, and the host reachable from the device (the same network, or a forwarded port you understand).

Only one method is active at a time. To switch, turn Remote off first.

Remote gives a device a web app, not a remote desktop. It shows the conversations and lets the device act within its permission level. It does not expose your settings or your files.

## Tailscale

1. Open **Settings › Remote** and turn on **Allow remote devices**.
2. Choose **Tailscale** as the method.
3. Bitbots publishes a private HTTPS address through Tailscale. It never makes the address public and never changes another app's Tailscale settings.
4. Choose **Pair a device**. Bitbots shows an eight-character code in two groups (for example `K7QM-4XPD`), a link and a QR code. The offer lasts five minutes and allows five wrong attempts.
5. On the phone, open the link, enter the code, and give the device a name.
6. On the desktop, approve the request and choose a level: viewer, chat or operator.
7. The phone confirms and stores a secure sign-in. The desktop lists the device under Devices.

If Tailscale is not ready, Bitbots changes nothing and names the fix: not installed, not running, signed out, HTTPS disabled, port in use, or public access turned on. Starting a new pairing code cancels the previous one.

## Native

The Native method (called Direct in the app) serves a secure HTTPS address from this computer. It is the only Bitbots connection that is reachable beyond this computer, and only while it is on.

1. Turn Remote off, choose **Native**, then turn it on.
2. Set the port (default 48621) and, if you need one, the external address. Bitbots generates a certificate for this computer.
3. Set a username and password. Bitbots stores the password in a form that cannot be read back, never the password itself.
4. Open the address the page shows. The device signs in with the username and password; a new device then waits for your approval, exactly like a Tailscale pairing.
5. Choose a level and approve.

Native refuses an unsecured connection. A device sees a one-time certificate warning and can compare the fingerprint shown in Settings › Remote. Router port mapping (UPnP) happens only with your consent and removes only its own mapping. A firewall rule is added only through an elevated prompt you accept.

Bitbots limits repeated sign-in attempts, locks out a source after too many failures and pauses temporarily during a burst. The activity list records a short, content-free line for each.

## What a device may do

| Level | May |
| --- | --- |
| Viewer | Read state, conversations, usage, coding agents and models, and the memory and automation lists. |
| Chat | Everything viewer can, plus send prompts, steer, cancel, queue, rename and archive conversations. |
| Operator | Everything chat can, plus answer permission requests, and only while **Approve requests from remote devices** is on. |

**Never remote**, at every level: changing settings, creating, editing or deleting bots and projects, changing coding-agent profiles, refreshing coding agents, reverting files, writing automations or memory, shutting Bitbots down, attachments, and the app's own native commands.

The same access rules apply to both methods, and every action has an explicit rule.

## Safety and privacy

- Remote is off by default, and Bitbots' own connection stays on this computer.
- A paired device signs in with a secure cookie; Bitbots stores only a secure fingerprint of that sign-in, not the sign-in itself.
- Every request checks the sign-in, whether the device was revoked, and where the request came from. Tailscale's own login is checked when it is available.
- Message text never appears in logs, notifications or the activity list.
- A device can be renamed, given a different level or revoked at once. A revoked device is refused on its next request.
- Approvals from remote are off by default; turning them off leaves operator devices unable to approve until it is on again.

How it works: [remote access in depth](../reference/remote-gateway.md).

## Check the result

- The Remote page shows the listening state, the address and the method.
- The phone loads the web app, signs in or pairs, and shows the same conversations as the desktop.
- A viewer device cannot send a prompt; a chat device can; only an operator device can answer an approval, and only with approvals from remote on.
- Revoking a device makes its next request fail.
- Turning Remote off stops the connection and removes only Bitbots' own Tailscale setting.

## If something fails

**Tailscale says the port is in use.** Another program owns the usual secure port. Bitbots tries the next one; if that is also taken, stop the other service or choose Native.

**A pairing code is rejected.** It expired after five minutes, was burned after five wrong attempts, or a new code replaced it. Start a new one.

**The phone cannot load the link.** For Tailscale, check both devices are on the same Tailscale network and the host is online. For Native, check the port is reachable, the firewall rule is present and the address starts with `https://` and uses the exact port.

**The certificate warning appears again after a network change.** The certificate's addresses changed. Regenerate it on the host; the fingerprint changes, so compare the new one.

**The device sees no approvals.** Its level is viewer or chat, or approvals from remote is off. Change the level, then turn approvals on.

**Remote devices are visible but do nothing.** Check the activity list for a rate limit or a lockout. A global pause is temporary; a revoked device stays revoked until it is paired again.
