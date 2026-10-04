import type { CSSProperties } from 'react'
import './providerBrand.css'

const providerAssets = import.meta.glob('../assets/providers/*.{svg,png,webp}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const brands = {
  claude: { name: 'Claude Code', mark: 'C', file: 'claude' },
  codex: { name: 'Codex', mark: 'O', file: 'codex' },
  openai: { name: 'Codex', mark: 'O', file: 'codex' },
  opencode: { name: 'OpenCode', mark: 'O', file: 'opencode' },
  'opencode-go': { name: 'OpenCode', mark: 'O', file: 'opencode' },
  'opencode-zen': { name: 'OpenCode', mark: 'O', file: 'opencode' },
  anthropic: { name: 'Claude Code', mark: 'C', file: 'claude' },
} as const

export function providerBrand(provider: string) {
  const key = provider.toLowerCase()
  return brands[key as keyof typeof brands] ?? { name: provider || 'Coding agent', mark: (provider || '?').slice(0, 1).toUpperCase(), file: '' }
}

export function ProviderLogo({ provider, size = 18 }: { provider: string; size?: number }) {
  const brand = providerBrand(provider)
  const light = document.documentElement.dataset.theme === 'light'
  const entries = Object.entries(providerAssets)
  const themed = entries.find(([path]) => path.toLowerCase().endsWith(`/providers/${brand.file}-${light ? 'light' : 'dark'}.svg`))?.[1]
  const entry = themed ?? entries.find(([path]) => path.toLowerCase().endsWith(`/providers/${brand.file}.svg`))?.[1]
  const style = { width: size, height: size, '--provider-logo-size': `${size}px` } as CSSProperties
  return <span className="provider-logo" style={style} aria-hidden="true">{entry ? <img className="provider-logo-image" src={entry} width={size} height={size} alt="" /> : <span>{brand.mark}</span>}</span>
}
