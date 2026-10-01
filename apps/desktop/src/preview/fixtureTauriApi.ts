// Development-only stand-ins for @tauri-apps/api/event and /window.
export async function listen() { return () => undefined }
export async function emit() {}
export function getCurrentWindow() {
  return { onDragDropEvent: async () => () => undefined }
}
