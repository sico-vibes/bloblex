import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Bot, ChevronDown, Plus, RotateCcw, SquareTerminal, X } from 'lucide-react'
import { terminalClose, terminalList, terminalOpen, terminalResize, terminalWrite, type TerminalExit, type TerminalShell } from '../tauri'
import { attachTerminal, forgetTerminal, startTerminalHub } from './terminalHub'
import type { Session } from '../types'
import { BotCommands, botCommands } from './BotCommands'
import { openSafeLink } from './openSafeLink'
import { terminalLinks } from './terminalLinks'
import './terminal.css'

type Tab = { id: string; shell: string; cwd: string; exited: boolean; exitCode: number | null }

const HEIGHT_KEY = 'bitbots.terminal.height'
const MIN_HEIGHT = 140
const SHELLS: Array<{ id: TerminalShell; label: string }> = [{ id: 'powershell', label: 'PowerShell' }, { id: 'pwsh', label: 'PowerShell 7' }, { id: 'cmd', label: 'Command Prompt' }]
const shellLabel = (id: string) => SHELLS.find((shell) => shell.id === id)?.label ?? 'Shell'
const folderOf = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

function storedHeight() {
  try { const value = Number(window.localStorage.getItem(HEIGHT_KEY)); return Number.isFinite(value) && value >= MIN_HEIGHT ? value : 280 } catch { return 280 }
}

/** Whether a CSS colour is dark, read through a 1x1 canvas so any colour syntax the page uses works. */
function isDark(color: string): boolean {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.fillStyle = '#000'
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) < 128
  } catch { return true }
}

const DARK_ANSI = { black: '#2b2d30', red: '#ff6b6b', green: '#3ddc97', yellow: '#ffae42', blue: '#6ea8ff', magenta: '#d68cf0', cyan: '#5fd1d9', white: '#d7d7d4', brightBlack: '#6b6e73', brightRed: '#ff8f8f', brightGreen: '#6ee7b0', brightYellow: '#ffc470', brightBlue: '#93bdff', brightMagenta: '#e4aef5', brightCyan: '#8be0e6', brightWhite: '#f3f3f2' }
const LIGHT_ANSI = { black: '#2b2d30', red: '#c9304a', green: '#117a55', yellow: '#8a5a00', blue: '#2556b8', magenta: '#8a3fb0', cyan: '#0e7a86', white: '#70726f', brightBlack: '#55585c', brightRed: '#d23a52', brightGreen: '#14875f', brightYellow: '#a86a00', brightBlue: '#2f6bd6', brightMagenta: '#a04bc8', brightCyan: '#12909e', brightWhite: '#1b1b1a' }

/** The terminal wears the look's own tokens; the dock surface behind it supplies the background. */
function themeFor(host: HTMLElement): ITheme {
  const css = getComputedStyle(host)
  const text = css.getPropertyValue('--text-1').trim() || '#f3f3f2'
  const dark = !isDark(text)
  return { ...(dark ? DARK_ANSI : LIGHT_ANSI), background: '#00000000', foreground: text, cursor: text, cursorAccent: css.getPropertyValue('--surface-panel').trim() || '#161616', selectionBackground: dark ? 'rgba(120, 160, 255, 0.35)' : 'rgba(47, 107, 214, 0.28)' }
}

function TerminalView({ tab, active, onExit, onFocusLost }: { tab: Tab; active: boolean; onExit: (exit: TerminalExit) => void; onFocusLost: () => void }) {
  const host = useRef<HTMLDivElement | null>(null)
  const term = useRef<XTerm | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  useEffect(() => {
    const node = host.current
    if (!node) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const css = getComputedStyle(node)
    const instance = new XTerm({
      allowTransparency: true,
      cursorBlink: !reduced,
      cursorStyle: 'bar',
      fontFamily: css.getPropertyValue('--font-mono').trim() || 'Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      // Text must stay readable on whatever the dock sits over, in every look.
      minimumContrastRatio: 4.5,
      theme: themeFor(node),
    })
    const fitAddon = new FitAddon()
    instance.loadAddon(fitAddon)
    instance.open(node)
    const links = instance.registerLinkProvider({
      provideLinks: (lineNumber, callback) => {
        const line = instance.buffer.active.getLine(lineNumber - 1)?.translateToString(true) ?? ''
        const found = terminalLinks(line)
        callback(found.length ? found.map((link) => ({ text: link.url, range: { start: { x: link.start, y: lineNumber }, end: { x: link.end, y: lineNumber } }, activate: () => openSafeLink(link.url) })) : undefined)
      },
    })
    term.current = instance
    fit.current = fitAddon
    // Keys the app keeps: Ctrl+` hides the dock; copy and paste behave like the rest of Windows.
    instance.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (event.ctrlKey && event.code === 'Backquote') return false
      if (event.ctrlKey && !event.shiftKey && event.code === 'KeyC' && instance.hasSelection()) { void navigator.clipboard.writeText(instance.getSelection()).catch(() => undefined); instance.clearSelection(); return false }
      if (event.ctrlKey && !event.altKey && event.code === 'KeyV') return false
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') { if (instance.hasSelection()) void navigator.clipboard.writeText(instance.getSelection()).catch(() => undefined); return false }
      return true
    })
    const input = instance.onData((data) => { void terminalWrite(tab.id, data).catch(() => undefined) })
    const resized = instance.onResize(({ cols, rows }) => { void terminalResize(tab.id, cols, rows).catch(() => undefined) })
    const detach = attachTerminal(tab.id, {
      write: (data) => instance.write(data),
      exit: (exit) => { instance.write(`\r\n\x1b[2m[Process exited${exit.exitCode === null ? '' : ` with code ${exit.exitCode}`}]\x1b[0m\r\n`); onExitRef.current(exit) },
    })
    let frame = 0
    const refit = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { if (node.offsetParent !== null && node.clientWidth > 0 && node.clientHeight > 0) { try { fitAddon.fit() } catch { /* hidden while measuring */ } } })
    }
    const observer = new ResizeObserver(refit)
    observer.observe(node)
    // A look or theme change repaints the terminal with the new tokens.
    const retheme = new MutationObserver(() => { instance.options.theme = themeFor(node) })
    retheme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-style', 'data-surface-theme'] })
    refit()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      retheme.disconnect()
      links.dispose()
      detach()
      input.dispose()
      resized.dispose()
      instance.dispose()
      term.current = null
      fit.current = null
    }
  }, [tab.id])

  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => { try { fit.current?.fit() } catch { /* not measurable yet */ } term.current?.focus() })
    return () => cancelAnimationFrame(frame)
  }, [active])

  return <div className="terminal-view" hidden={!active} ref={host} role="group" aria-label={`${shellLabel(tab.shell)} terminal in ${folderOf(tab.cwd)}`} onKeyDown={(event) => { if (event.key === 'Escape' && event.shiftKey) { event.preventDefault(); onFocusLost() } }} />
}

/**
 * Real shells in the selected project's folder (Windows ConPTY through the desktop shell). The dock stays mounted
 * while hidden, so closing it does not end a running command; closing a tab does.
 */
export function TerminalDock({ open, projectPath, onHide, onError, session, botName = 'The bot' }: { open: boolean; projectPath: string | null; onHide: () => void; onError: (message: string) => void; session?: Session | null; botName?: string }) {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [botView, setBotView] = useState(false)
  const commandCount = botCommands(session).length
  const [activeId, setActiveId] = useState<string | null>(null)
  const [height, setHeight] = useState(storedHeight)
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const dock = useRef<HTMLElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const adopted = useRef(false)
  const opening = useRef(false)

  // Terminals that outlived a reload of the page are still running in the shell; pick them up again.
  useEffect(() => {
    if (adopted.current) return
    adopted.current = true
    void startTerminalHub().then(() => terminalList()).then((list) => {
      const running = list.filter((item) => item.running)
      if (!running.length) return
      setTabs((current) => [...current, ...running.filter((item) => !current.some((tab) => tab.id === item.id)).map((item): Tab => ({ id: item.id, shell: item.shell, cwd: item.cwd, exited: false, exitCode: null }))])
      setActiveId((current) => current ?? running[0]!.id)
    }).catch(() => undefined)
  }, [])

  const create = useCallback(async (shell: TerminalShell, cwd?: string) => {
    const root = cwd ?? projectPath
    if (!root || opening.current) return
    opening.current = true
    setBusy(true)
    try {
      await startTerminalHub()
      const info = await terminalOpen(root, { shell })
      setTabs((current) => [...current, { id: info.id, shell: info.shell, cwd: info.cwd, exited: false, exitCode: null }])
      setActiveId(info.id)
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
    } finally { opening.current = false; setBusy(false) }
  }, [projectPath, onError])

  // Showing the dock with nothing in it starts one shell.
  useEffect(() => { if (open && adopted.current && !tabs.length && projectPath && !busy) void create('powershell') }, [open, projectPath]) // eslint-disable-line react-hooks/exhaustive-deps

  const closeTab = useCallback((id: string) => {
    void terminalClose(id).catch(() => undefined)
    forgetTerminal(id)
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id)
      setActiveId((active) => (active === id ? next[next.length - 1]?.id ?? null : active))
      return next
    })
  }, [])

  const restart = useCallback(async (tab: Tab) => {
    const shell = (SHELLS.find((item) => item.id === tab.shell)?.id ?? 'powershell') as TerminalShell
    closeTab(tab.id)
    await create(shell, tab.cwd)
  }, [closeTab, create])

  useEffect(() => {
    if (!menu) return
    const onDown = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(false) }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true) }
  }, [menu])

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startY = event.clientY
    const startHeight = height
    const limit = () => Math.max(MIN_HEIGHT, Math.round((dock.current?.parentElement?.clientHeight ?? 800) * 0.7))
    const move = (next: PointerEvent) => setHeight(Math.min(limit(), Math.max(MIN_HEIGHT, startHeight + (startY - next.clientY))))
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      setHeight((value) => { try { window.localStorage.setItem(HEIGHT_KEY, String(value)) } catch { /* private mode */ } return value })
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }
  const resizeByKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowUp' ? 24 : event.key === 'ArrowDown' ? -24 : 0
    if (!step) return
    event.preventDefault()
    setHeight((value) => { const next = Math.max(MIN_HEIGHT, value + step); try { window.localStorage.setItem(HEIGHT_KEY, String(next)) } catch { /* private mode */ } return next })
  }

  const active = tabs.find((tab) => tab.id === activeId) ?? null
  return <section ref={dock} className="terminal-dock" hidden={!open} style={{ height }} aria-label="Terminal">
    <div className="terminal-resize" role="separator" aria-orientation="horizontal" aria-label="Resize terminal" aria-valuenow={height} aria-valuemin={MIN_HEIGHT} tabIndex={0} onPointerDown={startResize} onKeyDown={resizeByKey} />
    <header className="terminal-head">
      <div className="terminal-tabs" role="tablist" aria-label="Terminals">
        {tabs.map((tab) => <div key={tab.id} className={`terminal-tab${tab.id === activeId ? ' active' : ''}${tab.exited ? ' exited' : ''}`}>
          <button type="button" role="tab" aria-selected={tab.id === activeId} className="terminal-tab-button" onClick={() => { setBotView(false); setActiveId(tab.id) }} title={tab.cwd}><SquareTerminal size={13} aria-hidden="true" /><span>{shellLabel(tab.shell)}</span><small>{folderOf(tab.cwd)}</small></button>
          <button type="button" className="terminal-tab-close" aria-label={`Close ${shellLabel(tab.shell)} in ${folderOf(tab.cwd)}`} title="Close terminal" onClick={() => closeTab(tab.id)}><X size={12} aria-hidden="true" /></button>
        </div>)}
        {session && <div className={`terminal-tab${botView ? ' active' : ''}`}>
          <button type="button" role="tab" aria-selected={botView} className="terminal-tab-button" title={`Commands ${botName} ran, read only`} onClick={() => setBotView(true)}><Bot size={13} aria-hidden="true" /><span>{botName}</span><small>{commandCount}</small></button>
        </div>}
      </div>
      <div className="terminal-actions">
        <div className="terminal-new" ref={menuRef}>
          <button type="button" className="terminal-icon" aria-label="New terminal" title={projectPath ? `New terminal in ${folderOf(projectPath)}` : 'Open a conversation in a project first'} disabled={!projectPath || busy} onClick={() => void create('powershell')}><Plus size={14} aria-hidden="true" /></button>
          <button type="button" className="terminal-icon small" aria-label="Choose a shell" aria-haspopup="menu" aria-expanded={menu} disabled={!projectPath || busy} onClick={() => setMenu((value) => !value)}><ChevronDown size={12} aria-hidden="true" /></button>
          {menu && <div className="menu-surface terminal-menu" role="menu">{SHELLS.map((shell) => <button type="button" role="menuitem" className="menu-item" key={shell.id} onClick={() => { setMenu(false); void create(shell.id) }}>{shell.label}</button>)}</div>}
        </div>
        <button type="button" className="terminal-icon" aria-label="Hide terminal" title="Hide terminal (Ctrl+` or Shift+Esc). Commands keep running." onClick={onHide}><X size={14} aria-hidden="true" /></button>
      </div>
    </header>
    <div className="terminal-body">
      {tabs.map((tab) => <TerminalView key={tab.id} tab={tab} active={tab.id === activeId && open && !botView} onFocusLost={onHide} onExit={(exit) => setTabs((current) => current.map((item) => (item.id === tab.id ? { ...item, exited: true, exitCode: exit.exitCode } : item)))} />)}
      {botView && session && <BotCommands session={session} botName={botName} />}
      {!botView && !tabs.length && <div className="terminal-empty">{projectPath ? (busy ? 'Starting a terminal…' : 'No terminal is open.') : 'Open a conversation in a project to start a terminal in its folder.'}</div>}
      {!botView && active?.exited && <div className="terminal-exited" role="status"><span>The shell ended{active.exitCode === null ? '' : ` with code ${active.exitCode}`}.</span><button type="button" className="secondary-button small" onClick={() => void restart(active)}><RotateCcw size={12} aria-hidden="true" />Restart</button></div>}
    </div>
  </section>
}
