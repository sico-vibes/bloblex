// Which runtime a bot runs on, for the Haze look's logo marks. A look carries
// no runtime (it is stored and shared on its own), so `agentLook` records the
// agent's runtime beside each look object it returns and the window records
// each runtime's provider. Nothing here is persisted.

import { useSyncExternalStore } from 'react'

const lookRuntime = new WeakMap<object, string>()
let providers = new Map<string, string>()
const listeners = new Set<() => void>()

/** Remembers the runtime of the agent a look was built for. */
export function rememberLookRuntime(look: object, runtimeId: unknown) {
  if (typeof runtimeId === 'string' && runtimeId) lookRuntime.set(look, runtimeId)
}

/** Called whenever the window's runtime list changes. */
export function setRuntimeProviders(runtimes: ReadonlyArray<{ id: string; provider?: string | null }>) {
  const next = new Map(runtimes.filter((runtime) => runtime.id && runtime.provider).map((runtime) => [runtime.id, String(runtime.provider)]))
  if (next.size === providers.size && [...next].every(([id, provider]) => providers.get(id) === provider)) return
  providers = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => providers

/** The provider for a look built by `agentLook`, or null when it is not known. */
export function useLookProvider(look: object | null | undefined): string | null {
  const map = useSyncExternalStore(subscribe, snapshot, snapshot)
  const runtimeId = look ? lookRuntime.get(look) : undefined
  return runtimeId ? map.get(runtimeId) ?? null : null
}
