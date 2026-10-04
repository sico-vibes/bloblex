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

export const PROVIDER_GUIDES: Record<'claude' | 'codex' | 'opencode', ProviderGuide> = {
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
}
