// Development-only conversations for the inspector (`?scene=<id>`): one conversation per state the real
// App can show, so each can be reviewed through the app's own renderers. Every value is a visual fixture.
import type { Session } from '../types'

export type Scene = {
  title?: string
  state?: string
  messages?: Array<Record<string, unknown>>
  tools?: Array<Record<string, unknown>>
  files?: Array<Record<string, unknown>>
  permissions?: Array<Record<string, unknown>>
  delegations?: Array<Record<string, unknown>>
  queue?: Array<Record<string, unknown>>
  queuePaused?: boolean
  session?: Partial<Session> & Record<string, unknown>
  extraSessions?: Array<Record<string, unknown>>
}

export const SCENE_SESSION_ID = 'session-scene'

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
let serial = 0
const say = (role: string, content: string, extra: Record<string, unknown> = {}) => {
  serial += 1
  return { id: `scene-m${serial}`, sequence: serial, turnId: 'scene-turn', role, content, createdAt: ago(40 - serial), ...extra }
}
const user = (content: string, extra: Record<string, unknown> = {}) => say('user', content, extra)
const bot = (content: string, extra: Record<string, unknown> = {}) => say('assistant', content, extra)
const notice = (content: string, meta: Record<string, unknown>) => say('notice', content, { meta })
const tool = (id: string, kind: string, title: string, state: string, detail: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
  serial += 1
  return { id, kind, title, state, sequence: serial, turnId: 'scene-turn', startedAt: ago(30), detail, ...extra }
}

const MARKDOWN = `# Heading one
## Heading two
### Heading three
#### Heading four

A paragraph with **bold**, *italic*, ~~struck~~ and \`inline code\`, a [link](https://example.com), a bare URL https://example.com/some/long/path?with=query and a file path \`src/ui/App.tsx:42\`.

- A bullet
- Another bullet
  - A nested bullet
    - Nested twice
- [x] A finished task
- [ ] An open task

1. First step
2. Second step
   1. A nested step
3. Third step

> A quote that runs long enough to wrap onto a second line, so you can see how the bar and the text sit together on both.
>
> A second paragraph in the quote.

---

| Name | Status | Cost | Notes |
| :--- | :----: | ---: | --- |
| Parser | Passing | 12 | Left, centre and right aligned columns |
| Fixtures | **Failing** | 1,204 | \`inline code\` inside a cell |
| A row with a longer name | Unknown | 0 | A long note that has to wrap inside its table cell to show how the row grows |

\`\`\`ts
// TypeScript
export function total(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + line.minorUnits, 0)
}
\`\`\`

\`\`\`rust
fn main() { println!("Rust, {}", 1 + 1); }
\`\`\`

\`\`\`powershell
Get-ChildItem -Recurse | Where-Object { $_.Length -gt 1MB }
\`\`\`

\`\`\`json
{ "name": "bitbots", "version": "0.1.0-beta.46", "private": true, "tiers": ["viewer", "chat", "operator"] }
\`\`\`

\`\`\`diff
- const total = lines.reduce((a, b) => a + b.amount, 0.0)
+ const total = lines.reduce((a, b) => a + b.minorUnits, 0)
\`\`\`

\`\`\`
A code block with no language at all.
\`\`\``

const RICH = `A bar chart, a line chart and a data table, as a bot can send them:

\`\`\`bitbots-chart
{ "type": "bar", "title": "Tests by package", "data": [{ "label": "daemon", "value": 949 }, { "label": "storage", "value": 151 }, { "label": "ui", "value": 1682 }, { "label": "adapters", "value": 120 }] }
\`\`\`

\`\`\`bitbots-chart
{ "type": "line", "title": "Cold start, in ms", "data": [{ "label": "beta.42", "value": 410 }, { "label": "beta.43", "value": 380 }, { "label": "beta.44", "value": 395 }, { "label": "beta.45", "value": 360 }, { "label": "beta.46", "value": 352 }] }
\`\`\`

\`\`\`bitbots-table
{ "title": "Releases", "caption": "The last three betas", "columns": ["Version", "Headline", "Tests"], "rows": [["beta.44", "Machines and handoff", 2901], ["beta.45", "Accounts, secrets, webhooks", 3050], ["beta.46", "Sub-bots", 3141]] }
\`\`\`

CSV and JSON that can be flipped between code and a table:

\`\`\`csv
bot,turns,cost
Rae,12,0.41
Tom,3,0.07
\`\`\``

const VISUAL = `A mock as a visual reply. Scripts inside it never run:

\`\`\`bitbots-visual
<div style="padding:16px;border-radius:12px;background:#eef;color:#223"><h3 style="margin:0">Invoice 104</h3><p style="margin:6px 0 0">Paid on 31 October</p><script>document.body.innerHTML="SCRIPT RAN"</script></div>
\`\`\`

And an SVG:

\`\`\`svg
<svg width="160" height="70" xmlns="http://www.w3.org/2000/svg"><rect width="160" height="70" rx="12" fill="#6a8"/><circle cx="35" cy="35" r="18" fill="#fff"/></svg>
\`\`\``

const LONG_WORD = 'a'.repeat(400)
const LONG_PARAGRAPH = Array.from({ length: 14 }, (_, index) => `Sentence ${index + 1} of a long paragraph, which keeps going so you can judge the line length, the spacing and how the bubble grows when a bot writes a lot in one breath.`).join(' ')
const LONG_CODE = Array.from({ length: 120 }, (_, index) => `const line${index + 1} = compute(${index + 1}) // A comment that makes this line noticeably wider than the bubble it sits in, so it has to scroll`).join('\n')
const WIDE_TABLE = `| ${Array.from({ length: 14 }, (_, index) => `Column ${index + 1}`).join(' | ')} |\n| ${Array.from({ length: 14 }, () => '---').join(' | ')} |\n${Array.from({ length: 12 }, (_, row) => `| ${Array.from({ length: 14 }, (_, cell) => `Row ${row + 1} cell ${cell + 1}`).join(' | ')} |`).join('\n')}`

const shell = (extra: Record<string, unknown> = {}) => ({ id: 'perm-scene', title: 'Run shell command', tool: 'Bash', command: 'npm test -- invoice', choices: ['allow_once', 'allow_session', 'deny'], ...extra })
const proposal = (kind: string, payload: Record<string, unknown>, title: string) => ({ id: `perm-proposal-${kind}`, kind: 'proposal', title, detail: null, choices: ['approve', 'reject'], proposal: { id: `perm-proposal-${kind}`, kind, payload } })
const question = (questions: Array<Record<string, unknown>>) => ({ id: 'perm-question-scene', kind: 'question', title: 'Codex has a question', choices: ['answer', 'dismiss'], questions })
const lead = () => [user('Can you make the invoice parser tests pass?'), bot('Sure. I found two failing cases. I need one thing from you first.')]

const ledger = (id: string, status: string, topic: string, target: string, extra: Record<string, unknown> = {}) => ({ id, originSessionId: SCENE_SESSION_ID, originTurnId: 'scene-turn', sideSessionId: `scene-side-${id}`, sideTurnId: null, fromAgentId: 'agent-codex', targetAgentId: target, topic, briefPreview: `${topic}: read the code, then report back.`, status, error: null, workspace: { path: 'C:/work/korus', worktree: null }, createdAt: ago(20), startedAt: status === 'queued' ? null : ago(18), finishedAt: ['running', 'queued'].includes(status) ? null : ago(4), updatedAt: ago(2), ...extra })
const side = (id: string, title: string, agentId: string, state: string) => ({ id: `scene-side-${id}`, runtimeId: agentId === 'agent-claude' ? 'runtime-claude' : agentId === 'agent-opencode' || agentId === 'agent-pololo' ? 'runtime-opencode' : 'runtime-codex', agentId, title, projectPath: 'C:/work/korus', state, updatedAt: ago(5), link: { kind: 'side', peerAgentId: 'agent-codex', peerName: 'Codex', originSessionId: SCENE_SESSION_ID, topic: title }, messages: [{ id: `scene-side-${id}-m`, role: 'user', content: `Hi, it's Codex. ${title}: read the code, then report back.`, createdAt: ago(18), meta: { kind: 'blob_message', fromAgentId: 'agent-codex', fromName: 'Codex' } }] })
const sent = (id: string, peer: string, peerName: string, topic: string, direction = 'sent') => notice(`${topic}: read the code, then report back.`, { kind: 'delegation', direction, peerAgentId: peer, peerName, topic, sideSessionId: `scene-side-${id}` })

const SCENES: Record<string, () => Scene> = {
  markdown: () => ({ title: 'Everything Markdown can do', messages: [user('Show me everything Markdown can do.'), bot(MARKDOWN)] }),
  rich: () => ({ title: 'Charts and tables', messages: [user('Show the numbers.'), bot(RICH)] }),
  visual: () => ({ title: 'Visual replies', messages: [user('Mock the invoice card.'), bot(VISUAL)] }),
  languages: () => ({ title: 'Other languages', messages: [
    user('هل يمكنك مراجعة هذا الملف وإخباري بما تغير؟'),
    bot('نعم. وجدت **حالتين** فاشلتين في `tests/invoice.test.ts`.\n\n- الأولى في تحليل العملة.\n- الثانية في الإجماليات.\n\nMixed text: راجعت `src/ui/App.tsx` and the 3 tests.'),
    user('日本語と中文のテキストも見せてください。한국어도요. Emoji too: 🤖🎉✅'),
    bot('日本語のテキストです。中文文本在这里。한국어 텍스트입니다. Ελληνικά, Русский текст, עברית.'),
  ] }),
  'user-messages': () => ({ title: 'Your messages', messages: [
    user('Short.'),
    user('A message with a few lines.\n\nIt has a blank line, and\na single line break too.'),
    user(LONG_PARAGRAPH),
    user('Mentioning @Pololo and @Claude, with `inline code` and a path C:\\work\\korus\\src\\App.tsx.'),
    user('Sent from another app through the Bitbots connection.', { meta: { origin: { kind: 'mcp', client: 'claude-code' } } }),
    user('Here are two screenshots.', { attachments: [{ name: 'screenshot-1.png' }, { name: 'a-very-long-file-name-that-has-to-be-shortened-somewhere.png' }] }),
    user('Change this part, please.', { meta: { annotations: [{ quote: 'I will switch totals to integer minor units and parse the locale first.', note: 'Keep the old rounding for refunds.' }, { quote: 'Running the suite now.', note: 'Only the invoice suite.' }] } }),
    bot('A reply with reactions under it.', { reactions: [{ emoji: '👍', count: 1 }, { emoji: '🎉', count: 1 }] }),
    bot('The first reply, which the next message answers.', { id: 'scene-replied' }),
    user('Answering a particular message.', { meta: { replyTo: { messageId: 'scene-replied', sourceSessionId: SCENE_SESSION_ID, author: 'Codex', excerpt: 'The first reply, which the next message answers.' } } }),
  ] }),
  overflow: () => ({ title: 'A very long conversation title that has to be shortened wherever it appears in the app, because it will not fit', messages: [
    user('Show me the worst cases for layout.'),
    bot(`One unbroken word: ${LONG_WORD}`),
    bot(LONG_PARAGRAPH),
    bot(`\`\`\`ts\n${LONG_CODE}\n\`\`\``),
    bot(WIDE_TABLE),
    user(`One unbroken word from you: ${LONG_WORD}`),
  ] }),
  thinking: () => ({ title: 'Thinking and plans', messages: [
    user('Plan the port.'),
    say('thinking', 'The user wants a plan. I should read the current picker first, then check which tokens it uses, then write the steps.'),
    say('plan', '1. Vendor the dropdown into `src/ui/effort`.\n2. Replace its colours with theme tokens.\n3. Wire it to the session lock and add keyboard tests.', { meta: { kind: 'plan' } }),
    bot('That is the plan. Say the word and I will start.'),
  ] }),
  notices: () => ({ title: 'Every notice', messages: [
    user('Show every notice.'),
    notice("Limited until 14:00. I'll pick up when the window opens.", { kind: 'usage_limit' }),
    notice('This conversation started a new provider session. It kept a summary.', { kind: 'context_reset' }),
    notice('This conversation started a new provider session, and the earlier context was lost.', { kind: 'context_reset', contextLost: true }),
    notice('Generating an image…', { kind: 'generated_image', mediaId: 'img-pending', status: 'pending' }),
    notice('Generated an image: sunrise.png', { kind: 'generated_image', mediaId: 'img-ready', status: 'ready', name: 'sunrise.png', bytes: 182_400, mediaType: 'image/png', provider: 'codex' }),
    notice("The image couldn't be generated: The image didn't arrive.", { kind: 'generated_image', mediaId: 'img-failed', status: 'failed', detail: "The image didn't arrive." }),
    notice('Pull request opened: Tidy the settings page', { kind: 'pull_request', url: 'https://github.com/example/site/pull/42', number: 42, title: 'Tidy the settings page' }),
    notice('The provider stopped. Trying again in 30 seconds.', { kind: 'auto_retry', status: 'scheduled' }),
    notice('Tried again, and it worked.', { kind: 'auto_retry', status: 'done' }),
    notice('Gave up after 3 tries.', { kind: 'auto_retry', status: 'failed' }),
    user('Please continue where you stopped.', { meta: { kind: 'auto_retry' } }),
    notice('Running the setup script…', { kind: 'setup_script', status: 'running' }),
    notice('The setup script failed: npm ci exited with code 1.', { kind: 'setup_script', status: 'failed', detail: 'npm ci exited with code 1.' }),
    notice("This conversation's separate copy of the project had been emptied, so it was restored from bitbots/task.", { kind: 'worktree', direction: 'restored' }),
    notice('Created Scout.', { kind: 'blob_created', agentId: 'agent-pololo', name: 'Scout' }),
    bot('And a normal reply after them all.'),
  ] }),
  activity: () => ({ title: 'Every kind of step', messages: [user('Run everything.'), bot('Done. Here is every kind of step I took.')], tools: [
    tool('s-cmd-ok', 'commandExecution', 'npm test -- invoice', 'completed', { command: 'npm test -- invoice', output: ' PASS  tests/invoice.test.ts\n Tests: 14 passed', exitCode: 0 }),
    tool('s-cmd-fail', 'commandExecution', 'cargo clippy', 'failed', { command: 'cargo clippy -- -D warnings', output: 'error: unused variable: `total`\n  --> src/parser.rs:12:9', exitCode: 101 }),
    tool('s-cmd-run', 'commandExecution', 'npm run build', 'running', { command: 'npm run build', output: 'vite v8.0.3 building for production...\ntransforming (412) src/ui/App.tsx' }),
    tool('s-cmd-long', 'commandExecution', 'A long command', 'completed', { command: `node scripts/${'long-path/'.repeat(30)}run.mjs --flag`, output: Array.from({ length: 200 }, (_, index) => `output line ${index + 1}`).join('\n'), exitCode: 0 }),
    tool('s-cmd-secret', 'commandExecution', 'Using a token', 'completed', { command: 'curl -H "Authorization: Bearer sk-fake-preview-token-1234567890abcdef" https://example.com', output: 'token=sk-fake-preview-token-1234567890abcdef', exitCode: 0 }),
    tool('s-read', 'read', 'Read', 'completed', { path: 'src/ui/App.tsx', tool: 'Read' }),
    tool('s-grep', 'search', 'Search', 'completed', { query: 'parseInvoice', tool: 'Grep', output: 'src/parser.ts:12\ntests/invoice.test.ts:4' }),
    tool('s-web', 'webSearch', 'Searched: effort picker react', 'completed', { query: 'effort picker react' }),
    tool('s-mcp', 'mcpToolCall', 'github · list_pull_requests', 'completed', { tool: 'github · list_pull_requests', input: '{\n  "state": "open"\n}', result: '3 open pull requests' }),
    tool('s-mcp-fail', 'mcpToolCall', 'github · merge', 'failed', { tool: 'github · merge', error: 'Not allowed: the branch is protected.' }),
    tool('s-skill', 'mcpToolCall', 'bloblex · load_skill', 'completed', { tool: 'bloblex · load_skill', input: '{\n  "name": "pdf"\n}', result: 'Loaded.' }),
    tool('s-agent', 'Agent', 'Agent', 'completed', { tool: 'Agent', subagent: { type: 'general-purpose', model: 'haiku', description: 'Count the invoice fixtures' }, output: 'Async agent launched successfully. (internal)\nagentId: a1 (internal ID)\nThe agent is working in the background.\nThere are 12 invoice fixtures.' }),
    tool('s-agent-read', 'read', 'Read', 'completed', { path: 'tests/fixtures/invoices.json' }, { parentToolCallId: 's-agent' }),
    tool('s-agent-grep', 'search', 'Search', 'completed', { query: 'invoice', output: '12 matches' }, { parentToolCallId: 's-agent' }),
  ], files: [
    { id: 's-file-1', turnId: 'scene-turn', sequence: 90, path: 'src/parser.ts', createdAt: ago(5), detail: { path: 'src/parser.ts', change: 'modify', diff: '-  return total * 1.0\n+  return total' } },
    { id: 's-file-2', turnId: 'scene-turn', sequence: 91, path: 'docs/effort-picker.md', createdAt: ago(5), detail: { path: 'docs/effort-picker.md', change: 'add', diff: '+# Effort picker options\n+- PostHog ReasoningLevelDropdown (MIT)' } },
    { id: 's-file-3', turnId: 'scene-turn', sequence: 92, path: 'src/old.ts', createdAt: ago(5), detail: { path: 'src/old.ts', change: 'delete', diff: '-export const old = true' } },
  ] }),
  'turn-failed': () => ({ title: 'A failed turn', state: 'failed', messages: [user('Run the tests.'), bot('Starting now.')], session: { turns: [{ id: 'scene-turn', state: 'failed', outcome: 'failed', error: { message: 'The coding agent stopped unexpectedly.', code: 'process_exited' }, message: 'The coding agent stopped unexpectedly.', startedAt: ago(5), sequence: 99 }] } }),
  working: () => ({ title: 'A turn in progress', state: 'working', messages: [user('Fix the parser.'), bot('Looking at the parser now, and I have started to write a repl')], tools: [tool('w1', 'commandExecution', 'npm test', 'running', { command: 'npm test', output: 'running 14 tests' })] }),
  cancelling: () => ({ title: 'Stopping', state: 'cancelling', messages: [user('Fix the parser.'), bot('Looking at the parser now.')] }),
  limited: () => ({ title: 'At the usage limit', state: 'limited', messages: [user('Keep going.'), notice("Limited until 14:00. I'll pick up when the window opens.", { kind: 'usage_limit' })], session: { provider: 'claude', limitedUntil: new Date(Date.now() + 2 * 3_600_000).toISOString() } }),
  'empty-conversation': () => ({ title: 'New chat', state: 'idle', messages: [] }),
  context: () => ({ title: 'Nearly full context', state: 'idle', messages: [user('How much room is left?'), bot('Not much.')], session: { contextUsed: 372_000, contextSize: 400_000, modelLock: { model: 'gpt-6.1-sol', thinking: 'high' } } }),

  'approval-shell': () => ({ title: 'Approve a command', state: 'waiting_permission', messages: lead(), permissions: [shell()] }),
  'approval-always': () => ({ title: 'Approve, with Always', state: 'waiting_permission', messages: lead(), permissions: [shell({ rememberable: true, rememberLabel: 'Run `npm test`', projectName: 'Board' })] }),
  'approval-long': () => ({ title: 'Approve a long command', state: 'waiting_permission', messages: lead(), permissions: [shell({ command: `powershell -NoProfile -Command "${Array.from({ length: 30 }, (_, index) => `Get-ChildItem C:\\work\\folder-${index} -Recurse`).join('; ')}"`, detail: 'A long description of what this command is about to do, which needs to wrap onto more than one line inside the card.' })] }),
  'approval-file': () => ({ title: 'Approve a file edit', state: 'waiting_permission', messages: lead(), permissions: [{ id: 'perm-file', title: 'Edit a file', tool: 'Edit', detail: 'src/parser.ts\n-  return total * 1.0\n+  return total', choices: ['allow_once', 'allow_session', 'deny'], category: 'file_edit' }] }),
  'approval-expiring': () => ({ title: 'Approve before it expires', state: 'waiting_permission', messages: lead(), permissions: [shell({ expiresAt: new Date(Date.now() + 3 * 60_000).toISOString() })] }),
  'approval-many': () => ({ title: 'Several approvals waiting', state: 'waiting_permission', messages: lead(), permissions: [shell({ id: 'perm-a' }), shell({ id: 'perm-b', command: 'git push origin main', title: 'Push to GitHub' }), shell({ id: 'perm-c', command: 'rm -rf build', title: 'Delete a folder' })] }),
  'question-single': () => ({ title: 'One question', state: 'waiting_permission', messages: lead(), permissions: [question([{ id: 'q1', header: 'Direction', question: 'Which direction should the effort picker follow?', options: [{ label: 'PostHog fork', description: 'Closest behaviour, MIT licensed' }, { label: '21st.dev model select', description: 'One popover for effort, context and fast' }, { label: 'Build our own' }], multiSelect: false, allowOther: true }])] }),
  'question-multi': () => ({ title: 'Pick several', state: 'waiting_permission', messages: lead(), permissions: [question([{ id: 'q1', header: 'Platforms', question: 'Which platforms must this support?', options: [{ label: 'Windows' }, { label: 'macOS' }, { label: 'Linux' }, { label: 'Phone', description: 'Only the remote view' }], multiSelect: true, allowOther: false }])] }),
  'question-several': () => ({ title: 'Several questions', state: 'waiting_permission', messages: lead(), permissions: [question([
    { id: 'q1', header: 'Scope', question: 'How far should this go?', options: [{ label: 'Only the parser' }, { label: 'The whole module' }], multiSelect: false, allowOther: false },
    { id: 'q2', header: 'Tests', question: 'Should I add tests?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false, allowOther: true },
    { id: 'q3', header: 'Notes', question: 'Anything else I should know? This question is long on purpose, to show how a question wraps when it has much more to say than usual.', options: [], multiSelect: false, allowOther: true },
  ])] }),
  'proposal-bot': () => ({ title: 'Proposal: a bot', state: 'waiting_permission', messages: lead(), permissions: [proposal('bot', { name: 'Scout', role: 'Research', description: 'Finds references and open-source options.', instructions: 'Search first. Answer concisely, with sources.', provider: 'opencode', model: 'opencode-go/preview', thinking: 'high', approvalMode: 'ask', project: 'project-board', tags: ['research', 'ui'], look: { shape: 'cloud', seed: 'scout' } }, 'Create the bot "Scout"')] }),
  'proposal-project': () => ({ title: 'Proposal: a project', state: 'waiting_permission', messages: lead(), permissions: [proposal('project', { name: 'Marketing site', description: 'The public site and its copy.', folder: { mode: 'new', path: '' }, tags: ['web'] }, 'Create the project "Marketing site"')] }),
  'proposal-task': () => ({ title: 'Proposal: a task', state: 'waiting_permission', messages: lead(), permissions: [proposal('task', { bot: 'agent-pololo', botName: 'Pololo', project: 'project-board', projectName: 'Board', topic: 'Effort picker research', brief: 'Find an open-source effort picker like the 21st.dev one, and report the best three.', doneGoal: 'Three ranked options, each with a licence.', reportBack: 'A short list with links.' }, 'Assign "Effort picker research"')] }),
  'proposal-merge': () => ({ title: 'Proposal: merge', state: 'waiting_permission', messages: lead(), permissions: [proposal('merge', { action: 'merge', worktree: 'C:/work/korus-bitbots/task', repo: 'C:/work/korus', branch: 'bitbots/effort-picker', baseBranch: 'main', baseCommit: 'abc1234', conversation: SCENE_SESSION_ID, botName: 'Pololo', taskTitle: 'Effort picker research', files: ['src/ui/effort/Dropdown.tsx', 'src/ui/effort/dropdown.css', 'docs/effort-picker.md'], diffSummary: '3 files changed, 212 insertions, 4 deletions' }, 'Merge "Effort picker research"')] }),
  'proposal-update': () => ({ title: 'Proposal: update a bot', state: 'waiting_permission', messages: lead(), permissions: [proposal('bot', { action: 'update', blob: 'agent-pololo', targetName: 'Pololo', role: 'Lead designer', thinking: 'max', approvalMode: 'auto', instructions: 'Lead the design work, and ask before changing tokens.' }, 'Update Pololo')] }),
  'proposal-playbook': () => ({ title: 'Proposal: the playbook', state: 'waiting_permission', messages: lead(), permissions: [proposal('playbook', { reason: 'You asked me to always check licences first.', text: '# How I work\n\nI am the Manager. I check licences before suggesting a library.\n\n## Proposing a team\n\nOne bot per responsibility.' }, 'Change the playbook')] }),
  'proposal-profile': () => ({ title: 'Proposal: your profile', state: 'waiting_permission', messages: lead(), permissions: [proposal('profile', { category: 'style', key: 'tone', value: 'Direct, plain English. No filler.' }, 'Remember your tone')] }),
  'proposal-permission': () => ({ title: 'Proposal: permission', state: 'waiting_permission', messages: lead(), permissions: [proposal('permission', { conversation: 'Invoice parser tests', mode: 'auto' }, 'Change this bot to Auto')] }),
  'proposal-open': () => ({ title: 'Proposal: open a conversation', state: 'waiting_permission', messages: lead(), permissions: [proposal('task', { action: 'open', title: 'Effort picker research', conversation: 'session-team-side' }, 'Open a conversation')] }),

  team: () => ({ title: 'Assignments in every state', state: 'idle', messages: [
    user('Split this up across the team.'),
    bot('Sending it out now.'),
    sent('a', 'agent-pololo', 'Pololo', 'Research the picker'),
    sent('b', 'agent-claude', 'Claude', 'Write the copy'),
    sent('c', 'agent-opencode', 'OpenCode', 'Check the licences'),
    sent('d', 'agent-invoice', 'Invoice helper', 'Update the fixtures'),
    sent('e', 'agent-pololo', 'Pololo', 'Draw the icon'),
    sent('f', 'agent-claude', 'Claude', 'Review the plan'),
    sent('g', 'agent-opencode', 'OpenCode', 'Tidy the docs'),
  ], delegations: [
    ledger('a', 'running', 'Research the picker', 'agent-pololo'),
    ledger('b', 'queued', 'Write the copy', 'agent-claude', { queueReason: 'slots' }),
    ledger('c', 'queued', 'Check the licences', 'agent-opencode', { queueReason: 'busy' }),
    ledger('d', 'completed', 'Update the fixtures', 'agent-invoice', { doneGoal: 'All 14 fixtures pass.', workspace: { path: 'C:/work/korus-bitbots/fixtures', worktree: { repo: 'C:/work/korus', branch: 'bitbots/fixtures', path: 'C:/work/korus-bitbots/fixtures' } } }),
    ledger('e', 'failed', 'Draw the icon', 'agent-pololo', { error: 'The coding agent stopped unexpectedly.' }),
    ledger('f', 'cancelled', 'Review the plan', 'agent-claude'),
    ledger('g', 'interrupted', 'Tidy the docs', 'agent-opencode'),
  ], extraSessions: [side('a', 'Research the picker', 'agent-pololo', 'working'), side('b', 'Write the copy', 'agent-claude', 'idle'), side('c', 'Check the licences', 'agent-opencode', 'idle'), side('d', 'Update the fixtures', 'agent-invoice', 'completed'), side('e', 'Draw the icon', 'agent-pololo', 'failed'), side('f', 'Review the plan', 'agent-claude', 'completed'), side('g', 'Tidy the docs', 'agent-opencode', 'completed')] }),
  chips: () => ({ title: 'Team messages', state: 'idle', messages: [
    user('Ask the team.'),
    notice('Find an effort picker.', { kind: 'delegation', direction: 'sent', peerAgentId: 'agent-pololo', peerName: 'Pololo', topic: 'Effort picker', sideSessionId: 'session-team-side' }),
    notice('Could not reach Pololo: that bot is archived.', { kind: 'delegation', direction: 'failed', peerAgentId: 'agent-pololo', peerName: 'Pololo', topic: 'Effort picker' }),
    user('[Update from Pololo]\nWaiting for your approval.', { meta: { kind: 'blob_update', fromAgentId: 'agent-pololo', fromName: 'Pololo', sideSessionId: 'session-team-side', requestKind: 'approval', title: 'Run npm test' } }),
    user('[Update from Pololo]\nHas a question for you.', { meta: { kind: 'blob_update', fromAgentId: 'agent-pololo', fromName: 'Pololo', sideSessionId: 'session-team-side', requestKind: 'question', title: 'Which direction?' } }),
    user('[Reply from Pololo]\nNothing pixel-exact exists as a package. Closest: a PostHog dropdown, and a model selector on 21st.dev.', { meta: { kind: 'blob_reply', fromAgentId: 'agent-pololo', fromName: 'Pololo', sideSessionId: 'session-team-side' } }),
    notice('Created Scout.', { kind: 'blob_created', agentId: 'agent-pololo', name: 'Scout' }),
    bot('Pololo found it. Fork the PostHog one?'),
  ] }),

  queue: () => ({ title: 'Messages waiting', state: 'working', messages: [user('Fix the parser.'), bot('Working on it.')], queue: [
    { id: 'q1', kind: 'user', text: 'After that, run the whole suite.' },
    { id: 'q2', kind: 'user', text: 'And then write a short summary of what changed, with the file names, and put it in the notes. This one is long so it has to wrap inside the row.' },
    { id: 'q3', kind: 'send_later', text: 'Check the nightly build.', dueAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
    { id: 'q4', kind: 'retry', text: 'Please continue where you stopped.', dueAt: new Date(Date.now() + 90_000).toISOString() },
    { id: 'q5', kind: 'send_later', text: 'Carry on when the limit resets.', whenLimitResets: true },
    { id: 'q6', kind: 'user', text: 'This one could not be sent.', status: 'failed', error: 'The coding agent stopped unexpectedly.' },
  ] }),
  'queue-paused': () => ({ title: 'Queue paused', state: 'idle', messages: [user('Fix the parser.'), bot('Done.')], queue: [{ id: 'q1', kind: 'user', text: 'After that, run the whole suite.' }], queuePaused: true }),
}

export const sceneIds = () => Object.keys(SCENES)
export function sceneFor(id: string | null): Scene | null {
  const make = id ? SCENES[id] : undefined
  return make ? make() : null
}
