// Wave 14: a message sent through the Bitbots MCP carries `origin: { kind: 'mcp', client }`, at the top level
// or in `meta`. The transcript and the companion show who sent it, so a message from an outside session never
// reads as one the owner typed.

/** `claude-code` reads as "Claude Code"; anything else is shown as the client named itself. */
export function clientLabel(client: string | null): string {
  if (!client) return 'an MCP client'
  if (/^claude[-_ ]?code$/i.test(client)) return 'Claude Code'
  return client
}

/** The sender's name when the message came through the MCP, else null. */
export function outsideSender(message: Record<string, unknown> | undefined): string | null {
  if (!message) return null
  const meta = message.meta && typeof message.meta === 'object' ? message.meta as Record<string, unknown> : null
  const raw = message.origin ?? meta?.origin
  if (!raw || typeof raw !== 'object') return null
  const origin = raw as Record<string, unknown>
  if (origin.kind !== 'mcp') return null
  const client = typeof origin.client === 'string' && origin.client.trim() && origin.client.trim().toUpperCase() !== 'MCP' ? origin.client.trim() : null
  return client ? clientLabel(client) : 'an MCP client'
}
