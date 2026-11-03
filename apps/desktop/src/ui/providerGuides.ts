// Source: .local/reports/provider-facts-research.md, Part B. Checked 2026-10-04.
export const PROVIDER_GUIDES_CHECKED_AT = '2026-10-04'

export type ProviderCommand = { label: string; command: string; docsUrl?: string }
export type ProviderGuide = {
  name: string
  installSummary: string
  installCommands: readonly ProviderCommand[]
  installDocsUrl: string
  signInSummary: string
  signInCommand: string
  signInDocsUrl: string
  versionCheckCommand?: string
  versionDocsUrl?: string
  docsUrl: string
}

export const PROVIDER_GUIDES: Record<'claude' | 'codex' | 'opencode' | 'qwen' | 'cursor' | 'grok', ProviderGuide> = {
  claude: {
    name: 'Claude Code',
    installSummary: 'Native install supports Windows 10 1809+ or Server 2019+ and needs no Node.js; npm install requires Node.js 22+.',
    installCommands: [
      { label: 'PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' },
      { label: 'Command Prompt', command: 'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd' },
      { label: 'WinGet', command: 'winget install Anthropic.ClaudeCode' },
      { label: 'npm (Node.js 22+)', command: 'npm install -g @anthropic-ai/claude-code' },
    ],
    installDocsUrl: 'https://code.claude.com/docs/en/setup',
    signInSummary: 'Run the command and follow the browser prompts.',
    signInCommand: 'claude',
    signInDocsUrl: 'https://code.claude.com/docs/en/setup',
    versionCheckCommand: 'claude --version',
    versionDocsUrl: 'https://code.claude.com/docs/en/setup',
    docsUrl: 'https://code.claude.com/docs/en/setup',
  },
  codex: {
    name: 'Codex',
    installSummary: 'Native Windows is supported; WSL2 is optional.',
    installCommands: [
      { label: 'PowerShell', command: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"', docsUrl: 'https://developers.openai.com/codex/quickstart' },
    ],
    installDocsUrl: 'https://developers.openai.com/codex/quickstart',
    signInSummary: 'Choose Sign in with ChatGPT and complete the browser flow.',
    signInCommand: 'codex login',
    signInDocsUrl: 'https://developers.openai.com/codex/cli/reference',
    docsUrl: 'https://developers.openai.com/codex/quickstart',
  },
  opencode: {
    name: 'OpenCode',
    installSummary: 'WSL is recommended on Windows; native installs are also documented.',
    installCommands: [
      { label: 'WSL', command: 'curl -fsSL https://opencode.ai/install | bash', docsUrl: 'https://opencode.ai/docs/windows-wsl' },
      { label: 'Chocolatey', command: 'choco install opencode', docsUrl: 'https://opencode.ai/docs/' },
      { label: 'Scoop', command: 'scoop install opencode', docsUrl: 'https://opencode.ai/docs/' },
      { label: 'npm', command: 'npm install -g opencode-ai', docsUrl: 'https://opencode.ai/docs/' },
    ],
    installDocsUrl: 'https://opencode.ai/docs/',
    signInSummary: 'Choose a provider, then enter its API key.',
    signInCommand: 'opencode auth login',
    signInDocsUrl: 'https://opencode.ai/docs/cli/',
    versionCheckCommand: 'opencode --version',
    versionDocsUrl: 'https://opencode.ai/docs/cli/',
    docsUrl: 'https://opencode.ai/docs/',
  },
  // Phase 5: both run through ACP, which each vendor still marks experimental.
  cursor: {
    name: 'Cursor CLI',
    installSummary: 'Install the Cursor CLI. Bitbots talks to it through its ACP mode (agent acp).',
    installCommands: [{ label: 'PowerShell', command: 'irm https://cursor.com/install?win32=true | iex', docsUrl: 'https://cursor.com/docs/cli/overview' }],
    installDocsUrl: 'https://cursor.com/docs/cli/overview',
    signInSummary: 'Run agent login in a terminal and complete its sign-in.',
    signInCommand: 'agent login',
    signInDocsUrl: 'https://cursor.com/docs/cli/acp',
    versionCheckCommand: 'agent --version',
    docsUrl: 'https://cursor.com/docs/cli/acp',
  },
  grok: {
    name: 'Grok CLI',
    installSummary: 'Install the Grok CLI (Grok Build). Bitbots talks to it through its ACP mode (grok agent stdio).',
    installCommands: [],
    installDocsUrl: 'https://docs.x.ai/build/cli/headless-scripting',
    signInSummary: 'Run grok login in a terminal and complete its sign-in.',
    signInCommand: 'grok login',
    signInDocsUrl: 'https://docs.x.ai/build/cli/headless-scripting',
    versionCheckCommand: 'grok --version',
    docsUrl: 'https://docs.x.ai/build/cli/headless-scripting',
  },
  qwen: {
    name: 'Qwen Code',
    installSummary: 'Install it with npm. Bitbots talks to it through its experimental ACP mode.',
    installCommands: [{ label: 'npm', command: 'npm install -g @qwen-code/qwen-code', docsUrl: 'https://github.com/QwenLM/qwen-code' }],
    installDocsUrl: 'https://github.com/QwenLM/qwen-code',
    signInSummary: 'Run it once in a terminal and complete its sign-in.',
    signInCommand: 'qwen',
    signInDocsUrl: 'https://github.com/QwenLM/qwen-code',
    versionCheckCommand: 'qwen --version',
    docsUrl: 'https://github.com/QwenLM/qwen-code',
  },
}
