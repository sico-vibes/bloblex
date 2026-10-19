// Opens an http(s) link in the system browser; anything else stays inert.
import { invokeNative, isNative } from '../transport/nativeBridge'

export async function openSafeLink(url: string) {
  let parsed: URL
  try { parsed = new URL(url) } catch { return }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) return
  if (!isNative()) {
    window.open(parsed.href, '_blank', 'noopener,noreferrer')
    return
  }
  try {
    await invokeNative('plugin:opener|open_url', { url: parsed.href })
  } catch {
    // Keep links usable if the native opener is unavailable in a development build.
    window.open(parsed.href, '_blank', 'noopener,noreferrer')
  }
}
