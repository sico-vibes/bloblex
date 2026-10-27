/**
 * A local file attached to a message by path. Bitbots does not read the file or send its bytes: the message carries
 * one sentence naming it, and the coding agent opens it with its own tools if its permissions allow. The same
 * sentence is built when sending and parsed when showing the message, so the transcript can show a file chip.
 */
export type LocalFileRef = { fileName: string; path: string; sizeBytes: number }

const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const SENTENCE = /Local file reference selected by the user: (.+?) \((.+), ([0-9.,]+ (?:B|KB|MB|GB))\)\. File contents were not read by Bitbots\. The provider may only access this path if its own process permissions and working directory allow it\./

export function fileReferenceText(file: LocalFileRef): string {
  return `Local file reference selected by the user: ${file.fileName} (${file.path}, ${formatSize(file.sizeBytes)}). File contents were not read by Bitbots. The provider may only access this path if its own process permissions and working directory allow it.`
}

/** The message text without the sentence, and the file it named. A message with no sentence comes back unchanged. */
export function splitFileReference(text: string): { body: string; file: { fileName: string; path: string; size: string } | null } {
  const match = SENTENCE.exec(text)
  if (!match) return { body: text, file: null }
  const body = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim()
  return { body, file: { fileName: match[1]!, path: match[2]!, size: match[3]! } }
}

/** The path relative to the project folder when it is inside it (so the daemon may preview it), else null. */
export function projectRelative(path: string, projectPath: string | null | undefined): string | null {
  if (!projectPath) return null
  const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const file = norm(path)
  const root = norm(projectPath)
  return file.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? file.slice(root.length + 1) : null
}
