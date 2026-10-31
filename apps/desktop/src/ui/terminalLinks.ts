// Phase 6: links in a terminal line. Only http and https, the same as everywhere else in the app.
const URL_PATTERN = /https?:\/\/[^\s"'<>`]+/g

export type TerminalLink = { start: number; end: number; url: string }

/** The links in one line of text, with 1-based columns as the terminal counts them. Trailing punctuation stays out. */
export function terminalLinks(line: string): TerminalLink[] {
  const links: TerminalLink[] = []
  for (const match of line.matchAll(URL_PATTERN)) {
    let url = match[0]
    while (/[.,;:!?)\]}]$/.test(url)) {
      if (url.endsWith(')') && url.includes('(')) break
      url = url.slice(0, -1)
    }
    const start = (match.index ?? 0) + 1
    links.push({ start, end: start + url.length - 1, url })
  }
  return links
}
