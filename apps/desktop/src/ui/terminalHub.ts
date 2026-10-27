import { listenForTerminalExit, listenForTerminalOutput, type TerminalExit, type TerminalOutput } from '../tauri'

/**
 * One listener pair for every terminal. Output can arrive before a terminal's view has mounted (the shell
 * starts talking as soon as it is spawned), so output for an id nobody has attached to yet is held, bounded,
 * and replayed in order when the view attaches.
 */
type Sink = { write: (data: string) => void; exit: (exit: TerminalExit) => void }

const HELD_LIMIT = 512 * 1024
const sinks = new Map<string, Sink>()
const held = new Map<string, { chunks: string[]; size: number; exit: TerminalExit | null }>()
let started: Promise<void> | null = null

function route(output: TerminalOutput) {
  const sink = sinks.get(output.id)
  if (sink) { sink.write(output.data); return }
  const entry = held.get(output.id) ?? { chunks: [], size: 0, exit: null }
  entry.chunks.push(output.data)
  entry.size += output.data.length
  // Drop the oldest output rather than grow without bound while nobody is looking.
  while (entry.size > HELD_LIMIT && entry.chunks.length > 1) entry.size -= entry.chunks.shift()!.length
  held.set(output.id, entry)
}

function routeExit(exit: TerminalExit) {
  const sink = sinks.get(exit.id)
  if (sink) { sink.exit(exit); return }
  const entry = held.get(exit.id) ?? { chunks: [], size: 0, exit: null }
  entry.exit = exit
  held.set(exit.id, entry)
}

/** Idempotent; the listeners live as long as the window. */
export function startTerminalHub(): Promise<void> {
  started ??= Promise.all([listenForTerminalOutput(route), listenForTerminalExit(routeExit)]).then(() => undefined)
  return started
}

export function attachTerminal(id: string, sink: Sink): () => void {
  sinks.set(id, sink)
  const pending = held.get(id)
  if (pending) {
    held.delete(id)
    for (const chunk of pending.chunks) sink.write(chunk)
    if (pending.exit) sink.exit(pending.exit)
  }
  return () => { if (sinks.get(id) === sink) sinks.delete(id) }
}

export function forgetTerminal(id: string) {
  sinks.delete(id)
  held.delete(id)
}
