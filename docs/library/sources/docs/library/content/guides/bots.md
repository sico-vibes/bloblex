# Bots

> **What this is:** create a bot, choose its coding agent and art, set what it may do without asking, and know what locking changes.
> **Status:** current; written for v0.1.0-beta.35
> **Last updated:** 2026-10-19

## Before you start

You need at least one coding agent that Bitbots can find. A bot is a saved character and a set of defaults; it does not run until a turn needs it. The permanent Manager is created in onboarding and is covered in [team and Manager](team-and-manager.md).

## Steps

### Create a bot

Open the sidebar menu and choose **New bot**. The wizard has five steps and edits the same fields as the full form, so nothing is hidden.

1. **Start from** a template: Code reviewer, Test writer, Documentation writer, Refactoring helper, Bug hunter, Researcher or Blank. A template fills the name, description, role, instructions, colour and suggested shape; it keeps the coding agent, model and approval mode you already chose.
2. **Name it.** The name, an optional description (what teammates read to decide whom to ask), a role of up to 40 characters, and team placement: a project, tags, and whether it carries the leader flag. A leader flag is a display role only; the Manager's authority comes from its special role.
3. **Choose its brain.** The coding agent, the model, the effort and the service tier where the agent offers one. Instructions are the bot's standing brief; they are sent with every turn and are not the same as memory.
4. **Access and look.** The approval mode (Ask first, Auto or Full access), a colour and an art style. Full access needs a typed confirmation.
5. **Review**, then **Create**.

You can also press **Show all settings** to skip the wizard. Both paths validate the same draft.

### Edit a bot

Select the bot and open its page. The editor holds the same groups. Changes are saved individually. A model change applies to the next turn; changing instructions starts a fresh thread with the coding agent where it needs one, because instructions are part of the conversation's identity.

The composer has its own model, effort and permission controls for the current conversation. They pin that conversation from its next turn; they do not rewrite the bot's defaults. A lock on the conversation overrides later changes to the bot.

### Choose the model and effort

The model list comes from the coding agent, not from Bitbots' guesses. If a model is not listed, do not type its id: choose the coding agent that offers it or refresh the list.

Each coding agent offers its own effort levels. The interface shows the levels that agent reports and passes your choice through. If a level is not supported, the agent says so rather than silently using another.

### Choose an art style

Art is per bot and independent of the app look. There are six styles:

| Art | What it is |
| --- | --- |
| 3D robot | The heavy shaded robot. Legacy's default. |
| Flat robot | The plain robot with pill eyes. Bitbots' default. |
| Pop robot | The outlined, sticker-style robot. Pop's default. |
| Dot robot | The monochrome robot with an antenna and dot eyes. Dot's default. |
| Glossy blob | The original blob with eight shapes. Blobots' default. |
| Hand-painted | Twelve painted bodies with animated eyes. |

Leave art on **Automatic** and the bot follows the app look: Bitbots gives Flat robot, Blobots gives Glossy blob, Legacy gives 3D robot, Pop gives Pop robot and Dot gives Dot robot. Hand-painted has its own twelve shapes: Classic, Cube, Star, Flower, Pear, Peanut, Ghost, Bunny, Kitty, UFO, Box bot and Tile.

### Set the approval mode

The three modes are explained in [conversations and approvals](conversations-and-approvals.md). In short:

- **Ask first** waits for you on every request. It is the default.
- **Auto** lets Bitbots approve low-risk reads, edits inside the project and a small set of commands; everything else still asks.
- **Full access** approves everything and, where the coding agent supports it, starts it without asking. It is set on the bot with a typed confirmation, or pinned on a conversation; the global default cannot be Full access.

The global default can only be Ask first or Auto. A Full access bot is marked with a shield in the bot row, the conversation header, the companion and its page.

### Lock a bot

Locking freezes the bot's configuration without archiving it. A locked bot shows a lock badge on its avatar; its editor opens read-only behind a banner and the composer's model, effort and permission controls show "This bot is locked. Unlock it to change its settings."

While locked, Bitbots refuses changes to the bot's name, description, instructions, colour, look, model, effort, permissions and team placement. It also refuses deleting the bot or its project, changing the model or permission mode in its conversations, and the Manager changing those settings. These still work: unlocking, creating other bots, hiding and sort order, plan mode, and every read.

### Archive and restore

**Archive** hides a bot and pauses (never deletes) its automations. **Restore** brings it back. The Manager cannot be archived. A conversation can be archived separately from its bot.

## Check the result

- The bot appears in the sidebar under its project, or under Unassigned, with its art and colour.
- Its page shows the coding agent, the model and the approval mode it actually uses, not only the override.
- A first prompt starts a turn and the coding agent's card shows a version.
- After a restart, the bot is still there with the same art and defaults.

## If something fails

**The model list is empty.** Bitbots cannot reach the coding agent. Open Settings › Agents, check its message and sign-in state, then refresh. A suggested list is not a promise; it will not make an unsupported model work.

**The art does not match the look.** The bot has an explicit art. Set it to Automatic, or change it to the art you want.

**Full access is not offered.** The bot is locked, or the control you are using does not offer it. Unlock the bot first. Full access is normally set on the bot with a typed confirmation; a conversation can also pin it, but an automation run can never use it.

**A field refuses to save.** A locked bot, an archived bot, or an invalid value (a name that is empty, a role over 40 characters, a tag outside 1–24 characters) all produce a readable error. Correct the field rather than retrying the same save.

**The bot disappeared.** Check the archived filter and the Unassigned group. Archiving hides a bot; it does not delete its conversations.

How it works: [bot art system](../reference/bot-art-system.md).
