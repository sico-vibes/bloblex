// The inspector's index: every screen and state of the frontend, each opened in the real app with fixture data.
// `expect` is text that must appear, so "Check all" can prove a scenario really reached its state.

export type Step = { click: string } | { clickText: string } | { type: [selector: string, text: string] } | { hover: string }
export type Scenario = {
  id: string
  title: string
  /** Page and query, for example `/?scene=markdown`. */
  url: string
  /** What to look at. */
  note?: string
  /** Text that proves the state appeared. */
  expect?: string
  /** Clicks and typing after the page loads, for states only a person's action reaches. */
  steps?: Step[]
  /** The window's real size, when it has one. */
  size?: [number, number]
  /** Keep the first-run hints and tour on. */
  raw?: boolean
}
export type Group = { id: string; title: string; description: string; scenarios: Scenario[] }

const COMPOSER = 'textarea[aria-label^="Message"]'
const scene = (id: string, title: string, expect?: string, note?: string, extra: Partial<Scenario> = {}): Scenario => ({ id: `scene-${id}`, title, url: `/?scene=${id}`, expect, note, ...extra })
const settings = (page: string, query = '', title = page, expect?: string, note?: string): Scenario => ({ id: `settings-${page.toLowerCase()}${query ? `-${query.replace(/[^a-z0-9]+/gi, '-')}` : ''}`, title, url: `/?open=settings:${page}${query ? `&${query}` : ''}`, expect: expect ?? page, note })
const dialog = (id: string, title: string, query: string, expect?: string, note?: string): Scenario => ({ id: `dialog-${id}`, title, url: `/?${query}`, expect, note })
const companion = (id: string, title: string, query: string, size: [number, number], expect?: string, note?: string): Scenario => ({ id: `companion-${id}`, title, url: `/?companion${query}`, size, expect, note })
const phone = (id: string, title: string, query: string, expect?: string, note?: string, steps?: Step[]): Scenario => ({ id: `phone-${id}`, title, url: `/remote.html?${query}`, size: [390, 844], expect, note, steps })
const launch = (mode: string, title: string, expect?: string): Scenario => ({ id: `launch-${mode}`, title, url: `/launch-preview.html?fixture=${mode}`, expect })

export const GROUPS: Group[] = [
  { id: 'main', title: 'Main window', description: 'The whole window, in its overall states.', scenarios: [
    { id: 'main-default', title: 'A normal day, working', url: '/', expect: 'Conversations', note: 'Sidebar, conversations panel, transcript and composer together.' },
    { id: 'main-idle', title: 'A normal day, idle', url: '/?idle', expect: 'Conversations' },
    { id: 'main-project-favicon', title: 'A project with its own favicon', url: '/?idle&favicon', expect: 'Conversations' },
    { id: 'main-chatbg-none', title: 'Chat background: no effect', url: '/?idle&chatbg=none', expect: 'Conversations' },
    { id: 'main-chatbg-dither', title: 'Chat background: Dither', url: '/?idle&chatbg=dither', expect: 'Conversations' },
    { id: 'main-chatbg-ascii', title: 'Chat background: ASCII', url: '/?idle&chatbg=ascii', expect: 'Conversations' },
    { id: 'main-chatbg-halftone', title: 'Chat background: Halftone', url: '/?idle&chatbg=halftone', expect: 'Conversations' },
    { id: 'main-chatbg-scanlines', title: 'Chat background: Scanlines', url: '/?idle&chatbg=scanlines', expect: 'Conversations' },
    { id: 'main-chatbg-haze', title: 'Chat background: Haze', url: '/?idle&chatbg=haze', expect: 'Conversations' },
    { id: 'main-no-bots', title: 'No bots yet', url: '/?empty', note: 'The empty state before any bot exists.' },
    { id: 'main-disconnected', title: 'Lost the service', url: '/?disconnected', note: 'The connection banner, and what stays usable.' },
    { id: 'main-agent-offline', title: 'A coding agent is offline', url: '/?offline', expect: 'Codex' },
    { id: 'main-runtime-error', title: 'A coding agent failed its check', url: '/?preset=opencode-runtime-error', expect: 'OpenCode' },
    { id: 'main-outside', title: 'CLIs running outside the app', url: '/?preset=outside', expect: 'Conversations' },
    { id: 'main-usage-bar', title: 'Usage bar on', url: '/?usage-bar', expect: 'Conversations' },
    { id: 'main-usage-panel', title: 'Usage panel, from the bar', url: '/?usage-bar&idle', expect: 'All usage', note: 'Every limit in one panel. The small mark on a meter shows how much of that window has passed.', steps: [{ click: '.quota-bar-trigger' }] },
    { id: 'main-usage-panel-sidebar', title: 'Usage panel, from the sidebar', url: '/?idle', expect: 'All usage', steps: [{ click: '.sidebar-usage' }] },
    { id: 'main-logos', title: 'Coding agent logos on', url: '/?logos', expect: 'Conversations' },
    { id: 'main-experiments', title: 'Every option on', url: '/?experiments', expect: 'Conversations' },
    { id: 'main-no-usage', title: 'No usage data', url: '/?no-quota', expect: 'Conversations', note: 'The sidebar usage row with nothing to show.' },
    { id: 'main-usage-error', title: 'Usage could not load', url: '/?quota-error', expect: 'Conversations' },
    { id: 'main-usage-90', title: 'Usage at 90%, with a tip', url: '/?preset=usage-tip-90', expect: 'Conversations' },
    { id: 'main-rail', title: 'Right rail open', url: '/?open=inspector', expect: 'Conversations', note: 'Files, changes and the session details beside the transcript.' },
    { id: 'main-update-ready', title: 'Update ready to restart', url: '/?update=ready', expect: 'Conversations' },
    { id: 'main-update-downloading', title: 'Update downloading', url: '/?update=downloading', expect: 'Conversations' },
    { id: 'main-update-error', title: 'Update failed', url: '/?update=error', expect: 'Conversations' },
    { id: 'main-tour', title: 'Guided tour, on a step', url: '/?tour', raw: true },
    { id: 'main-tour-invite', title: 'Tour invitation', url: '/?tour-invite', raw: true, expect: 'tour' },
    { id: 'main-hint-plan', title: 'First-time hint on a plan', url: '/?scene=thinking&hints-reset', raw: true, expect: 'This is the plan' },
    { id: 'main-hint-approval', title: 'First-time hint on an approval', url: '/?scene=approval-shell&hints-reset', raw: true },
  ] },
  { id: 'messages', title: 'Messages', description: "How a conversation's text is drawn.", scenarios: [
    scene('markdown', 'Everything Markdown can do', 'Heading two', 'Headings, lists, tasks, quotes, tables and code in six languages.'),
    scene('rich', 'Charts and data tables', 'Tests by package', 'Hover the bars, and flip a chart to its data.'),
    scene('visual', 'Visual replies', 'Invoice', 'HTML and SVG in a frame where nothing runs.'),
    scene('languages', 'Arabic, Japanese, Chinese, Korean and emoji', 'Mixed text', 'Right-to-left text, and mixed directions in one line.'),
    scene('user-messages', 'Your own messages', 'Short.', 'Short, long, attachments, comments on a reply, reactions, a reply to a message, and a message from another app.'),
    scene('overflow', 'Worst cases for layout', 'One unbroken word', 'A very long title, an unbroken word, wide code and a 14-column table. Nothing should push the window wider.'),
    scene('thinking', 'Thinking and plans', 'That is the plan'),
    scene('notices', 'Every notice', 'And a normal reply', 'Limits, context resets, images, a pull request, retries, setup scripts and a restored copy.'),
    { id: 'messages-links', title: 'Links and a table of projects', url: '/?preset=message-links', expect: 'dicebear' },
    { id: 'messages-images', title: 'Generated images', url: '/?preset=generated-image&session=session-codex&agent=agent-codex', expect: "couldn't be generated" },
    scene('empty-conversation', 'A conversation with nothing in it', undefined, 'The first thing you see in a new conversation.'),
    { ...scene('markdown', 'Message actions, hovered', 'Heading two'), id: 'messages-actions', note: 'Move the mouse over a message to see Copy, Reply and the rest.' },
  ] },
  { id: 'activity', title: 'Tool steps', description: 'What a bot did, as you can open it up.', scenarios: [
    { id: 'activity-all', title: 'Every kind of step, with Agent activity on', url: '/?scene=activity&activity', expect: 'Started 1 sub-agent', note: 'Commands, reads, searches, edits, tools and a sub-agent. Open the summary line. The token should be masked.', steps: [{ click: '.activity-summary-toggle' }] },
    { id: 'activity-off', title: 'The same turn, with Agent activity off', url: '/?scene=activity', expect: 'Started 1 sub-agent', note: 'The default for new installs: only sub-agents and failures stay.' },
    { id: 'activity-subagent', title: "Claude's own sub-agent, opened", url: '/?scene=activity', expect: 'There are 12 invoice fixtures', note: "Its steps nest under it, and Claude's internal lines are hidden.", steps: [{ click: '.activity-summary-toggle' }, { clickText: 'Sub-agent: Count the invoice fixtures' }] },
    scene('working', 'A turn in progress', 'Fix the parser', 'The working indicator and a half-written reply.'),
    scene('cancelling', 'Stopping a turn', 'Fix the parser'),
    scene('turn-failed', 'A failed turn', 'Run the tests', 'The error and what you can do next.'),
    scene('limited', 'Stopped at the usage limit', 'Limited until', 'The offer to hand over to another coding agent.'),
    scene('context', 'Context nearly full', 'How much room', 'The ring beside the composer, and its warning.'),
  ] },
  { id: 'approvals', title: 'Approvals and questions', description: 'Everything a bot can ask of you.', scenarios: [
    scene('approval-shell', 'Approve a command', 'npm test -- invoice'),
    scene('approval-always', 'Approve, with an Always choice', 'Always'),
    scene('approval-long', 'A very long command', 'Get-ChildItem', 'The card must not grow past the window.'),
    scene('approval-file', 'Approve a file edit', 'src/parser.ts'),
    scene('approval-expiring', 'An approval with a deadline', 'npm test -- invoice'),
    scene('approval-many', 'Several approvals waiting', 'npm test -- invoice'),
    scene('question-single', 'A question with one answer', 'Which direction'),
    scene('question-multi', 'A question with several answers', 'Which platforms'),
    scene('question-several', 'Several questions in a row', 'How far should this go'),
    { id: 'approvals-default', title: 'Live example with a Manager proposal', url: '/?session=session-team-leader&agent=agent-codex', expect: 'Manager proposes' },
    { id: 'approvals-secret', title: 'A bot asks for a secret', url: '/?secretrequest=1', expect: 'DEPLOY_TOKEN' },
  ] },
  { id: 'proposals', title: 'Manager proposals', description: 'Cards the Manager puts in front of you.', scenarios: [
    scene('proposal-bot', 'Create a bot', 'Scout', 'Press Edit to see the form.'),
    scene('proposal-project', 'Create a project', 'Marketing site'),
    scene('proposal-task', 'Assign a task', 'Effort picker research'),
    scene('proposal-merge', 'Merge a finished task', 'bitbots/effort-picker'),
    scene('proposal-update', 'Update a bot', 'Lead designer'),
    scene('proposal-playbook', 'Change the playbook', 'licences'),
    scene('proposal-profile', 'Remember something about you', 'Direct, plain English'),
    scene('proposal-permission', 'Change a permission', 'Full access can never'),
    scene('proposal-open', 'Open a conversation', 'Open a conversation'),
  ] },
  { id: 'team', title: 'Teams and sub-bots', description: 'Bots working with bots.', scenarios: [
    scene('team', 'Assignments in every state', 'Research the picker', 'Running, waiting for a slot, waiting for a busy bot, done, failed, stopped and interrupted.'),
    scene('chips', 'Team messages', 'Pololo found it', 'Sent, failed, waiting for approval, a question, a reply and a new bot.'),
    { id: 'team-live', title: 'A real-looking team conversation', url: '/?session=session-team-leader&agent=agent-codex&idle', expect: 'Pololo found it' },
    { id: 'team-side', title: 'A side conversation', url: '/?open=side:session-team-side&agent=agent-codex', expect: 'UI research done' },
    { id: 'team-subbots', title: 'A fleet of sub-bots', url: '/?subbots=1&session=session-codex&agent=agent-codex&idle', expect: 'Pricing research', note: 'Under the bot in the sidebar, and as a fleet above the composer.' },
    { id: 'team-subbots-activity', title: 'A fleet, with a sub-agent in the transcript', url: '/?subbots=1&session=session-codex&agent=agent-codex&idle', expect: 'Started 1 sub-agent' },
    { id: 'team-compare', title: 'Compare answers', url: '/?open=compare', note: 'Ask several bots, then compare their answers.' },
    { id: 'team-ask-several', title: 'Ask several bots', url: '/?open=ask-several', expect: 'Ask several' },
    { id: 'team-manager', title: 'The Manager', url: '/?agent=agent-manager', expect: 'Manager' },
  ] },
  { id: 'composer', title: 'Composer', description: 'Where you type, and every menu in it.', scenarios: [
    { id: 'composer-default', title: 'Ready to type', url: '/?idle', expect: 'Conversations' },
    { id: 'composer-locked', title: 'Model and effort chosen', url: '/?session=session-codex-composer-preview&agent=agent-codex', expect: 'composer controls' },
    { id: 'composer-plan', title: 'Plan mode on', url: '/?plan&idle&session=session-team-leader&agent=agent-codex', expect: 'Plan' },
    { id: 'composer-slash', title: 'Slash menu', url: '/?idle', steps: [{ type: [COMPOSER, '/'] }], note: 'Typing a slash.' },
    { id: 'composer-mention', title: 'Mention a bot', url: '/?idle', steps: [{ type: [COMPOSER, '@'] }], expect: 'Pololo' },
    { id: 'composer-typed', title: 'A long draft', url: '/?idle', steps: [{ type: [COMPOSER, Array.from({ length: 16 }, (_, index) => `Line ${index + 1} of a long draft`).join('\n')] }], note: 'How far the box grows before it scrolls.' },
    { id: 'composer-model', title: 'Model picker open', url: '/?idle&session=session-codex&agent=agent-codex', steps: [{ clickText: 'Pick a model' }], note: 'Shows every model and its efforts.' },
    { id: 'composer-model-locked', title: 'Effort meter', url: '/?session=session-codex-composer-preview&agent=agent-codex&composer-low', expect: 'composer controls' },
    scene('queue', 'Messages waiting, closed', 'queued messages'),
    { id: 'composer-queue-open', title: 'Messages waiting, opened', url: '/?scene=queue', expect: 'After that, run the whole suite', note: 'Plain, scheduled, retrying, waiting for a limit, and failed.', steps: [{ click: '.composer-status-chip' }, { clickText: 'Show' }] },
    scene('queue-paused', 'A paused queue', 'Paused until you resume'),
  ] },
  { id: 'screens', title: 'Full screens', description: 'The other places you can go.', scenarios: [
    { id: 'screen-tasks', title: 'Tasks board', url: '/?open=tasks', note: 'Create a task to see its form and timeline.' },
    { id: 'screen-schedules', title: 'Schedules, empty', url: '/?open=schedules', expect: 'New schedule' },
    { id: 'screen-schedules-runs', title: 'Schedules, with failed and quiet runs', url: '/?open=schedules&preset=schedule-retry', expect: 'Tidy the changelog' },
    { id: 'screen-usage', title: 'Usage', url: '/?open=usage', expect: 'Usage' },
    { id: 'screen-usage-empty', title: 'Usage, no data', url: '/?open=usage&analytics=empty' },
    { id: 'screen-usage-error', title: 'Usage, failed to load', url: '/?open=usage&analytics=error' },
    { id: 'screen-review', title: 'Review changes', url: '/?open=changes&session=session-codex&agent=agent-codex', expect: 'src/App.tsx', note: 'Stage, revert and comment on lines.' },
    { id: 'screen-review-clean', title: 'Review, nothing changed', url: '/?open=changes&session=session-codex&agent=agent-codex&repo=clean' },
    { id: 'screen-review-nogit', title: 'Review, not a git folder', url: '/?open=changes&session=session-codex&agent=agent-codex&repo=nogit' },
    { id: 'screen-review-error', title: 'Review, git failed', url: '/?open=changes&session=session-codex&agent=agent-codex&repo=error', expect: 'git is not installed' },
    { id: 'screen-review-pr', title: 'Review, opening a pull request', url: '/?open=pull-request&session=session-codex&agent=agent-codex' },
    { id: 'screen-review-slow', title: 'Review, loading', url: '/?open=changes&session=session-codex&agent=agent-codex&repo=slow' },
    { id: 'screen-terminal', title: 'Terminal', url: '/?open=terminal&session=session-codex&agent=agent-codex' },
    { id: 'screen-archived', title: 'Archived bots', url: '/?open=archived', expect: 'Retired' },
  ] },
  { id: 'bots', title: 'Bot pages', description: 'Making and changing a bot.', scenarios: [
    { id: 'bot-create', title: 'Create a bot', url: '/?open=bot-create', note: 'Name, look, coding agent, model, access and instructions.' },
    { id: 'bot-edit', title: 'Edit a bot', url: '/?open=bot-edit:agent-codex', expect: 'Codex' },
    { id: 'bot-edit-manager', title: 'Edit the Manager', url: '/?open=bot-edit:agent-manager', expect: 'Manager' },
    { id: 'bot-import', title: 'Import a shared bot', url: '/?preview-import' },
    { id: 'bot-archive', title: 'Archive a bot', url: '/?open=archive-bot:agent-invoice', expect: 'Invoice helper' },
    { id: 'bot-delete', title: 'Delete a bot', url: '/?open=delete-bot:agent-invoice', expect: 'Invoice helper' },
  ] },
  { id: 'settings', title: 'Settings', description: 'Every page, and its important states.', scenarios: [
    settings('General'), settings('Appearance'), settings('Appearance', 'chatbg=dither', 'Appearance, chat background', 'Empty chat at'), settings('Chat', '', 'Chat, messages', 'Sending'), settings('Speech', '', 'Chat, dictation', 'Dictation'), settings('Keyboard', '', 'Chat, keyboard', 'Shortcut list'), settings('Companion'),
    settings('Remote', '', 'Remote, off'), settings('Remote', 'remote=on&devices=3', 'Remote, on with devices'), settings('Remote', 'remote=not_installed', 'Remote, Tailscale missing'), settings('Remote', 'remote=logged_out', 'Remote, signed out of Tailscale'), settings('Remote', 'remote=https_disabled', 'Remote, HTTPS off'), settings('Remote', 'remote=funnel_on', 'Remote, Funnel on'), settings('Remote', 'remote=port_in_use', 'Remote, port in use'),
    settings('Machines', '', 'Machines, none'), settings('Machines', 'machines=1', 'Machines, linked', 'Work laptop'), settings('Machines', 'machines=offline', 'Machines, offline', 'Work laptop'),
    settings('Connections', '', 'Connections, off'), settings('Connections', 'preset=mcp', 'Connections, on'),
    settings('Agents'), settings('Accounts', '', 'Accounts', 'work@example.com'), settings('Secrets', '', 'Secrets', 'GITHUB_TOKEN'), settings('Approvals'), settings('Manager'), settings('Memory'), settings('Skills', '', 'Skills', 'release-notes'), settings('Backup'), settings('Health'),
    settings('Updates', '', 'Updates, up to date'), settings('Updates', 'updates=available', 'Updates, one available'), settings('Updates', 'updates=progress', 'Updates, downloading'), settings('Updates', 'updates=idle', 'Updates, never checked'), settings('Updates', 'updates=dev', 'Updates, a development build'), settings('Updates', 'channel=stable', 'Updates, stable channel'),
  ] },
  { id: 'dialogs', title: 'Dialogs and menus', description: 'Everything that opens over the window.', scenarios: [
    dialog('whats-new', "What's new", 'open=whats-new'),
    dialog('shortcuts', 'Keyboard shortcuts', 'open=shortcuts&experiments'),
    dialog('diagnostics', 'Export diagnostics', 'open=diagnostics'),
    dialog('search', 'Search messages', 'open=search&experiments'),
    dialog('switcher', 'Quick switcher', 'open=quick-switcher'),
    dialog('new-project', 'New project', 'open=new-project', undefined, 'Folder, Clone and Find tabs.'),
    dialog('project-search', 'Search the project', 'open=project-search'),
    { id: 'dialog-project-icon', title: 'Project icon picker', url: '/?idle', expect: 'Emoji', steps: [{ click: '.convo-project-head [aria-label$=" options"]' }, { clickText: 'Change icon…' }] },
    dialog('project-settings', 'Project settings', 'open=project-settings', 'Board'),
    dialog('delete-project', 'Delete a project', 'open=delete-project', 'Board'),
    dialog('delete-conversation', 'Delete a conversation', 'open=delete-conversation&session=session-codex&agent=agent-codex', 'Invoice parser tests'),
    dialog('handoff', 'Hand over a conversation', 'open=handoff&session=session-codex&agent=agent-codex'),
    dialog('limit-handoff', 'Hand over at a limit', 'preset=usage-limit&session=session-claude&agent=agent-claude', 'Limited until', 'The offer to carry on with another coding agent.'),
    dialog('pull-request', 'Open a pull request', 'open=pull-request&session=session-codex&agent=agent-codex'),
    dialog('pull-request-nogh', 'Pull request without GitHub CLI', 'open=pull-request&session=session-codex&agent=agent-codex&pr=nogh'),
    dialog('more-menu', 'Conversation menu', 'open=more-menu&session=session-codex&agent=agent-codex'),
    dialog('create-menu', 'New menu', 'open=create-menu', 'Ask several bots'),
    { id: 'dialog-profile', title: 'Profile menu', url: '/?idle', steps: [{ clickText: 'Your profile' }] },
  ] },
  { id: 'machines', title: 'Other computers', description: "Linked machines, and another computer's bots.", scenarios: [
    { id: 'machines-sidebar', title: 'Another computer in the sidebar', url: '/?machines=1', expect: 'Work laptop' },
    { id: 'machines-offline', title: 'That computer offline', url: '/?machines=offline', expect: 'Work laptop' },
    { id: 'machines-moved', title: 'A conversation moved away', url: '/?preset=moved&session=session-codex&agent=agent-codex', expect: 'Work laptop' },
  ] },
  { id: 'companion', title: 'Companion', description: 'The floating window, at its real sizes.', scenarios: [
    companion('compact', 'Compact bar', '', [560, 200]),
    companion('overview', 'Overview', '&mode=home', [760, 300]),
    companion('chat', 'Chat', '&mode=home&view=chat', [760, 420]),
    companion('activity', 'Activity', '&mode=home&view=activity&activity', [760, 420]),
    companion('settings', 'Settings', '&mode=home&view=settings', [760, 320]),
    companion('focus', 'Focus mode', '&focus', [560, 200]),
    companion('approval', 'An approval', '&mode=home&view=chat&scene=approval-shell', [760, 480], 'npm test -- invoice'),
    companion('question', 'A question', '&mode=home&view=chat&scene=question-single', [760, 480], 'Which direction'),
    companion('proposal', 'A proposal', '&mode=home&view=chat&scene=proposal-task', [760, 560]),
    companion('secret', 'A secret request', '&mode=home&view=chat&secretrequest=1', [760, 480]),
    companion('fleet', 'A fleet of sub-bots', '&mode=home&subbots=1', [760, 360]),
    companion('machines', 'Another computer', '&mode=home&machines=1', [760, 360]),
    companion('limited', 'At the usage limit', '&mode=home&view=chat&scene=limited', [760, 420], 'Limited until'),
    companion('markdown', 'Long replies', '&mode=home&view=chat&scene=markdown', [760, 520], 'Heading two'),
  ] },
  { id: 'launch', title: 'Launch and first run', description: 'What you see before the app is ready.', scenarios: [
    launch('live', 'Live: scan, then wave'), launch('in-progress', 'Scanning', 'Finding coding agents'), launch('done', 'Ready'), launch('done-warning', 'Ready, with warnings', 'could not be confirmed'), launch('service-down', 'Service down', 'did not respond'),
    launch('onboarding-look', 'First run: choose a look'), launch('onboarding-step-1', 'First run: your name'), launch('onboarding-step-2', 'First run: your coding agents'), launch('onboarding-step-3', 'First run: your first bot'),
  ] },
  { id: 'dictation', title: 'Dictation', description: 'The dictation island.', scenarios: [
    { id: 'dictation-all', title: 'Every state', url: '/dictation-preview.html', size: [1040, 900] },
    { id: 'dictation-live', title: 'Live bubble', url: '/dictation-preview.html?state=live', size: [560, 200] },
    { id: 'dictation-companion', title: 'Inside the companion', url: '/dictation-preview.html?surface=companion', size: [1040, 900] },
  ] },
  { id: 'phone', title: 'Phone', description: 'The phone app, at a phone size. Click through it: it runs on fixture data.', scenarios: [
    phone('connect', 'Pair with a code', 'phone=connect', 'code'),
    phone('connect-native', 'Sign in with a password', 'phone=connect&method=native', 'password'),
    phone('bots', 'Your bots', 'phone=paired', 'Codex'),
    phone('chat', 'A conversation', 'phone=paired', 'Pololo', undefined, [{ clickText: 'Codex' }]),
    phone('device', 'This device', 'phone=paired', 'This device', undefined, [{ clickText: 'This device' }]),
    phone('viewer', 'View only', 'phone=paired&tier=viewer', 'Codex', undefined, [{ clickText: 'Codex' }]),
    phone('operator', 'Chat and approve', 'phone=paired&tier=operator', 'Codex', undefined, [{ clickText: 'Codex' }]),
  ] },
  { id: 'design', title: 'Design system', description: 'The parts everything is built from.', scenarios: [
    { id: 'design-tokens', title: 'Colours, type and space', url: '/inspector-sheet.html#tokens', expect: 'Text' },
    { id: 'design-controls', title: 'Buttons, fields and menus', url: '/inspector-sheet.html#controls', expect: 'Primary' },
    { id: 'design-status', title: 'Status, chips and banners', url: '/inspector-sheet.html#status', expect: 'Working' },
    { id: 'design-usage', title: 'Usage parts', url: '/inspector-sheet.html#usage', expect: 'Turn on' },
    { id: 'design-loading', title: 'Loading and empty', url: '/inspector-sheet.html#loading', expect: 'Loading' },
    { id: 'design-art', title: 'Bot art, every mood', url: '/preview.html', expect: 'Every art, every mood', note: 'The 3D robot, Glossy and Hand-painted, at three sizes.' },
    { id: 'design-polish', title: 'Older polish sheet', url: '/polish-preview.html' },
  ] },
]

export const SCENARIOS: Array<Scenario & { group: Group }> = GROUPS.flatMap((group) => group.scenarios.map((scenario) => ({ ...scenario, group })))
