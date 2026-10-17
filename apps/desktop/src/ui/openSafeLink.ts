// Opens an http(s) link in the system browser; anything else stays inert.
import { invokeNative } from '../transport/nativeBridge'

export async function openSafeLink(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    await invokeNative('plugin:opener|open_url', { url: parsed.href })
  } catch { /* An unavailable opener leaves the link inert. */ }
}
