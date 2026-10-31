// Phase 6: HTML or SVG a bot returns, drawn in an isolated frame. The frame's sandbox has no
// permissions at all, so nothing in it runs, reaches the app or leaves the computer.
import { useState } from 'react'
import './machines.css'

const FRAME_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"

/** The frame's whole document. The policy travels with it, on top of the empty sandbox. */
export function visualDocument(code: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}"><style>html,body{margin:0;padding:8px;background:#fff;color:#111;font:14px system-ui,sans-serif}svg{max-width:100%;height:auto}</style></head><body>${code}</body></html>`
}

/** A fence the frame can draw, and whether it opens drawn. Only `bitbots-visual` asks for that. */
export function visualFence(language: string, code: string): { start: 'preview' | 'code' } | null {
  const tag = language.trim().toLowerCase().split(/\s+/)[0] ?? ''
  if (tag === 'bitbots-visual') return { start: 'preview' }
  if (tag === 'html') return { start: 'code' }
  if (tag === 'svg' && /<svg[\s>]/i.test(code)) return { start: 'code' }
  return null
}

export function VisualFrame({ code }: { code: string }) {
  return <iframe className="visual-frame" title="Picture from the bot" sandbox="" srcDoc={visualDocument(code)} referrerPolicy="no-referrer" />
}

export function VisualReply({ code, start, renderCode }: { code: string; start: 'preview' | 'code'; renderCode: () => React.ReactNode }) {
  const [view, setView] = useState(start)
  return <div className="rich-dual">
    <div className="rich-switch" role="group" aria-label="View"><button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')}>Preview</button><button type="button" aria-pressed={view === 'code'} onClick={() => setView('code')}>Code</button></div>
    {view === 'preview' ? <VisualFrame code={code} /> : renderCode()}
  </div>
}
