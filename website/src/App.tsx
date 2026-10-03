import { useEffect, useState } from 'react'
import { Effect } from 'effect'
import { Download, Github, Terminal, Shield, DollarSign, Database, Sparkles, RotateCcw } from 'lucide-react'
import { BlobCanvas } from './blob/BlobCanvas'
import { Button } from './components/Button'
import { Card } from './components/Card'
import { Badge } from './components/Badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from './components/Tabs'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from './components/Accordion'
import { fetchLatestRelease, type ReleaseInfo } from './lib/release'
import { formatBytes, formatDate } from './lib/utils'
import type { BlobMood } from './blob/types'

const BLOB_COLOR = '#ffc9a3'

const BLOB_MOODS: Array<{ mood: BlobMood; label: string; description: string }> = [
  { mood: 'idle', label: 'Idle', description: 'Resting. Eyes blink on their own.' },
  { mood: 'online', label: 'Online', description: 'Awake and available.' },
  { mood: 'listening', label: 'Listening', description: 'Ready for a message.' },
  { mood: 'working', label: 'Working', description: 'A turn is in progress.' },
  { mood: 'thinking', label: 'Thinking', description: 'Looking aside while it plans.' },
  { mood: 'question', label: 'Confused', description: 'Tilted, with a question badge.' },
  { mood: 'permission', label: 'Approval', description: 'Waiting on you. This one does not time out.' },
  { mood: 'success', label: 'Happy', description: 'A finished turn holds this face, then relaxes.' },
  { mood: 'error', label: 'Needs attention', description: 'Something failed.' },
  { mood: 'sleeping', label: 'Sleeping', description: 'Quiet after a long idle.' },
  { mood: 'offline', label: 'Offline', description: 'Daemon or runtime is gone.' },
]

function greetingSize() {
  if (typeof window === 'undefined') return 100
  return Math.max(40, Math.min(100, ((window.innerWidth - 40) / 640) * 100))
}

function clampPercent(value: number) {
  return Math.max(12, Math.min(88, value))
}

function App() {
  const [release, setRelease] = useState<ReleaseInfo | null>(null)
  const [greetingRun, setGreetingRun] = useState(0)
  const [heroSize, setHeroSize] = useState(greetingSize)
  const [companionPos, setCompanionPos] = useState({ x: 50, y: 78 })
  const [isDragging, setIsDragging] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const fiber = Effect.runPromise(fetchLatestRelease).then(setRelease)
    return () => {
      void fiber
    }
  }, [])

  useEffect(() => {
    const fit = () => setHeroSize(greetingSize())
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  const moveCompanion = (dx: number, dy: number) => {
    setCompanionPos((pos) => ({ x: clampPercent(pos.x + dx), y: clampPercent(pos.y + dy) }))
  }

  return (
    <div className="min-h-screen bg-app text-text-1">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-text-1 focus:px-3 focus:py-2 focus:text-text-inverse">
        Skip to content
      </a>
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-white/10 bg-app/95 backdrop-blur-sm">
        <div className="container mx-auto flex h-16 items-center justify-between gap-4 px-6">
          <a href="#top" className="flex items-center gap-3">
            <span className="flex items-center gap-2">
              <BlobCanvas color="#3b9eff" size={32} mood="online" mini interactive={false} label="Bloblex" />
              <span className="text-xl font-semibold">Bloblex</span>
            </span>
            <Badge variant="working">0.1.0-beta.3</Badge>
          </a>
          <nav className="hidden gap-6 md:flex" aria-label="Page">
            <a href="#features" className="text-text-2 hover:text-text-1">
              Features
            </a>
            <a href="#moods" className="text-text-2 hover:text-text-1">
              Character
            </a>
            <a href="#companion" className="text-text-2 hover:text-text-1">
              Companion
            </a>
            <a href="#privacy" className="text-text-2 hover:text-text-1">
              Privacy
            </a>
            <a href="#faq" className="text-text-2 hover:text-text-1">
              FAQ
            </a>
          </nav>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="small" as="a" href="https://github.com/sico-vibes/bloblex" target="_blank" rel="noopener noreferrer" aria-label="Bloblex on GitHub">
              <Github className="h-4 w-4" />
            </Button>
            {release?.installerUrl && (
              <Button as="a" href={release.installerUrl} download>
                <Download className="h-4 w-4" />
                Download
              </Button>
            )}
            <button
              type="button"
              className="inline-flex h-8 items-center rounded-pill px-3 text-sm text-text-2 hover:bg-white/5 hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/55 md:hidden"
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              onClick={() => setMenuOpen((open) => !open)}
            >
              Menu
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav id="mobile-nav" className="flex flex-col gap-1 border-t border-white/10 px-6 py-3 md:hidden" aria-label="Page">
            {[
              ['#features', 'Features'],
              ['#moods', 'Character'],
              ['#companion', 'Companion'],
              ['#privacy', 'Privacy'],
              ['#faq', 'FAQ'],
            ].map(([href, label]) => (
              <a key={href} href={href} className="rounded-md px-2 py-2 text-text-2 hover:bg-white/5 hover:text-text-1" onClick={() => setMenuOpen(false)}>
                {label}
              </a>
            ))}
          </nav>
        )}
      </header>

      <main id="main" className="pt-16">
        <section id="top" className="container mx-auto px-4 py-16 text-center sm:px-6 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <div className="mb-6 flex justify-center overflow-hidden">
              <BlobCanvas key={greetingRun} color="#3b9eff" size={heroSize} greeting label="Bloblex" />
            </div>
            <div className="mb-8">
              <Button variant="ghost" size="small" type="button" onClick={() => setGreetingRun((run) => run + 1)}>
                <RotateCcw className="h-3.5 w-3.5" />
                Replay the wave
              </Button>
            </div>
            <h1 className="mb-4 text-4xl font-semibold tracking-tight sm:text-5xl md:text-6xl">A control plane for coding agents</h1>
            <p className="mx-auto mb-8 max-w-2xl text-lg text-text-2 sm:text-xl">
              A local Windows desktop for Claude Code, Codex, and OpenCode. One chat, one companion, and a Rust daemon that owns sessions, permissions, budgets, and usage.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-4">
              {release?.installerUrl ? (
                <Button as="a" href={release.installerUrl} download>
                  <Download className="h-5 w-5" />
                  Download {release.version}
                  {release.installerSize ? <span className="text-text-3">({formatBytes(release.installerSize)})</span> : null}
                </Button>
              ) : (
                <Button as="a" href="https://github.com/sico-vibes/bloblex" target="_blank" rel="noopener noreferrer">
                  <Github className="h-5 w-5" />
                  Source on GitHub
                </Button>
              )}
              <Button variant="secondary" as="a" href="https://github.com/sico-vibes/bloblex/blob/main/README.md" target="_blank" rel="noopener noreferrer">
                Build instructions
              </Button>
            </div>
            <p className="mt-6 text-sm text-text-3">
              Current release {release?.version ?? '0.1.0-beta.3'}
              {release?.publishedAt ? ` · ${formatDate(release.publishedAt)}` : ''}
              {release && !release.installerUrl ? ' · signed installer still pending' : ''}
            </p>
          </div>
        </section>

        <section id="features" className="border-t border-white/10 bg-sidebar py-20 sm:py-24">
          <div className="container mx-auto px-4 sm:px-6">
            <h2 className="mb-4 text-center text-3xl font-semibold sm:text-4xl">One interface, separate logins</h2>
            <p className="mx-auto mb-12 max-w-2xl text-center text-text-2">Each CLI keeps its own authentication. Bloblex does not copy provider credentials or scrape a terminal.</p>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              <Card>
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-blob-working/20">
                  <Terminal className="h-6 w-6 text-blob-working" aria-hidden="true" />
                </div>
                <h3 className="mb-2 text-xl font-semibold">Sessions</h3>
                <p className="text-text-2">Start or resume Claude Code, Codex, and OpenCode from one conversation UI. The daemon normalizes events so the shell and the companion read the same state.</p>
              </Card>
              <Card>
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-blob-approval/20">
                  <Shield className="h-6 w-6 text-blob-approval" aria-hidden="true" />
                </div>
                <h3 className="mb-2 text-xl font-semibold">Permissions</h3>
                <p className="text-text-2">The daemon decides. The default is ask. Auto-approve covers a conservative set of low-risk actions, and bypass is per blob with an explicit confirmation. Automatic decisions are recorded.</p>
              </Card>
              <Card>
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-blob-finished/20">
                  <DollarSign className="h-6 w-6 text-blob-finished" aria-hidden="true" />
                </div>
                <h3 className="mb-2 text-xl font-semibold">Usage and budgets</h3>
                <p className="text-text-2">Usage stays with the daemon. Budgets can warn and stop a turn. An unknown price stays unknown.</p>
              </Card>
              <Card>
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-blob-thinking/20">
                  <Database className="h-6 w-6 text-blob-thinking" aria-hidden="true" />
                </div>
                <h3 className="mb-2 text-xl font-semibold">Local daemon</h3>
                <p className="text-text-2">bloblexd keeps sessions, permission decisions, and analytics in local SQLite. The React/Tauri shell is a view of that state.</p>
              </Card>
              <Card>
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-blob-online/20">
                  <Sparkles className="h-6 w-6 text-blob-online" aria-hidden="true" />
                </div>
                <h3 className="mb-2 text-xl font-semibold">Companion</h3>
                <p className="text-text-2">A rounded rectangular bill, bottom-center by default. Drag it anywhere and it keeps that place. Launch plays the welcome wave.</p>
              </Card>
              <Card>
                <div className="mb-4">
                  <BlobCanvas color="#8b5cf7" size={48} mood="thinking" label="Thinking blob" />
                </div>
                <h3 className="mb-2 text-xl font-semibold">Mouth-free blobs</h3>
                <p className="text-text-2">Original circular characters. State is color, eyes, a badge, and motion. Hover one, click to poke, or click three times.</p>
              </Card>
            </div>
          </div>
        </section>

        <section id="moods" className="py-20 sm:py-24">
          <div className="container mx-auto px-4 sm:px-6">
            <h2 className="mb-4 text-center text-3xl font-semibold sm:text-4xl">The same face as the app</h2>
            <p className="mx-auto mb-12 max-w-2xl text-center text-lg text-text-2">These are the engine states from the desktop character. Hover and they look at you. A long hover gets hearts. Three quick pokes and they go dizzy.</p>
            <div className="grid gap-8 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {BLOB_MOODS.map(({ mood, label, description }) => (
                <div key={mood} className="flex flex-col items-center text-center">
                  <div className="mb-4">
                    <BlobCanvas color={BLOB_COLOR} size={96} mood={mood} label={label} />
                  </div>
                  <h3 className="mb-1 font-semibold">{label}</h3>
                  <p className="text-sm text-text-3">{description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="companion" className="border-t border-white/10 bg-sidebar py-20 sm:py-24">
          <div className="container mx-auto px-4 sm:px-6">
            <h2 className="mb-4 text-center text-3xl font-semibold sm:text-4xl">Drag the island</h2>
            <p className="mx-auto mb-10 max-w-2xl text-center text-text-2">A small mock of the companion bill. Drag it, or focus it and use the arrow keys. In the app the window is transparent around a 22px-radius surface and starts bottom-center.</p>
            <Card className="mx-auto max-w-4xl">
              <div
                className="relative mx-auto h-80 overflow-hidden rounded-lg bg-app sm:h-96"
                style={{ background: 'linear-gradient(160deg, #1a1a1a 0%, #0a0a0a 100%)' }}
              >
                <div className="pointer-events-none absolute inset-0 opacity-20" style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, white 1px, transparent 0)', backgroundSize: '40px 40px' }} />
                <div
                  role="group"
                  tabIndex={0}
                  aria-label="Companion island. Drag to move, or press the arrow keys."
                  className="absolute cursor-grab rounded-[22px] border border-white/10 bg-raised px-3 py-2 shadow-lg focus-visible:outline-none active:cursor-grabbing"
                  style={{
                    left: `${companionPos.x}%`,
                    top: `${companionPos.y}%`,
                    transform: 'translate(-50%, -50%)',
                    touchAction: 'none',
                  }}
                  onPointerDown={(event) => {
                    const parent = event.currentTarget.parentElement
                    if (!parent) return
                    event.currentTarget.setPointerCapture(event.pointerId)
                    setIsDragging(true)
                  }}
                  onPointerMove={(event) => {
                    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                    const parent = event.currentTarget.parentElement
                    if (!parent) return
                    const rect = parent.getBoundingClientRect()
                    const x = ((event.clientX - rect.left) / rect.width) * 100
                    const y = ((event.clientY - rect.top) / rect.height) * 100
                    setCompanionPos({ x: clampPercent(x), y: clampPercent(y) })
                  }}
                  onPointerUp={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                    setIsDragging(false)
                  }}
                  onKeyDown={(event) => {
                    const step = event.shiftKey ? 8 : 4
                    if (event.key === 'ArrowLeft') moveCompanion(-step, 0)
                    else if (event.key === 'ArrowRight') moveCompanion(step, 0)
                    else if (event.key === 'ArrowUp') moveCompanion(0, -step)
                    else if (event.key === 'ArrowDown') moveCompanion(0, step)
                    else return
                    event.preventDefault()
                  }}
                >
                  <div className="flex items-center gap-3">
                    <BlobCanvas color="#54d598" size={44} mood="online" interactive={false} label="Companion" />
                    <div className="text-left">
                      <div className="text-sm font-medium">Claude</div>
                      <div className="text-xs text-text-3">{isDragging ? 'Dragging' : 'Online'}</div>
                    </div>
                  </div>
                </div>
              </div>
              <p className="mt-6 text-center text-sm text-text-3">Rounded corners, not a pill. Placement is yours to keep.</p>
            </Card>
          </div>
        </section>

        <section id="privacy" className="py-20 sm:py-24">
          <div className="container mx-auto px-4 sm:px-6">
            <div className="mx-auto max-w-4xl">
              <h2 className="mb-4 text-center text-3xl font-semibold sm:text-4xl">Local-first</h2>
              <p className="mb-12 text-center text-lg text-text-2">Provider traffic stays between the CLI you already trust and that provider. Bloblex keeps the control plane on the machine.</p>
              <Tabs defaultValue="storage">
                <TabsList className="mb-8 grid w-full grid-cols-1 sm:grid-cols-3" aria-label="Privacy topics">
                  <TabsTrigger value="storage">Storage</TabsTrigger>
                  <TabsTrigger value="authentication">Authentication</TabsTrigger>
                  <TabsTrigger value="network">Network</TabsTrigger>
                </TabsList>
                <TabsContent value="storage">
                  <Card>
                    <h3 className="mb-4 text-xl font-semibold">On this computer</h3>
                    <ul className="space-y-2 text-text-2">
                      <li>Sessions and analytics live in local SQLite.</li>
                      <li>Development builds use an isolated database path, not your real Bloblex data.</li>
                      <li>The desktop default location is %LOCALAPPDATA%\Bloblex.</li>
                    </ul>
                  </Card>
                </TabsContent>
                <TabsContent value="authentication">
                  <Card>
                    <h3 className="mb-4 text-xl font-semibold">Logins stay with the CLI</h3>
                    <ul className="space-y-2 text-text-2">
                      <li>Claude Code, Codex, and OpenCode each keep their own login.</li>
                      <li>Bloblex does not copy provider API keys into its database or docs.</li>
                      <li>Prompts go through the daemon protocol, not shell command text.</li>
                    </ul>
                  </Card>
                </TabsContent>
                <TabsContent value="network">
                  <Card>
                    <h3 className="mb-4 text-xl font-semibold">No extra account</h3>
                    <ul className="space-y-2 text-text-2">
                      <li>There is no Bloblex account and no Bloblex price.</li>
                      <li>Provider usage is whatever that provider already charges for the CLI.</li>
                      <li>This page reads the public GitHub release API only to find an installer, and falls back to 0.1.0-beta.3 if that fails.</li>
                    </ul>
                  </Card>
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </section>

        <section id="faq" className="border-t border-white/10 bg-sidebar py-20 sm:py-24">
          <div className="container mx-auto px-4 sm:px-6">
            <h2 className="mb-12 text-center text-3xl font-semibold sm:text-4xl">Questions</h2>
            <div className="mx-auto max-w-3xl">
              <Accordion type="single" collapsible>
                <AccordionItem value="what">
                  <AccordionTrigger>What is Bloblex?</AccordionTrigger>
                  <AccordionContent>
                    <p className="text-text-2">A local Windows desktop control plane for coding-agent CLIs. The React/Tauri shell and the companion window share state from bloblexd. You discover a runtime, start or resume a session, and follow its events.</p>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="providers">
                  <AccordionTrigger>Do I give Bloblex an API key?</AccordionTrigger>
                  <AccordionContent>
                    <p className="text-text-2">No. Sign in with the CLI the way you already do. Bloblex does not ask for provider credentials.</p>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="pricing">
                  <AccordionTrigger>What does it cost?</AccordionTrigger>
                  <AccordionContent>
                    <p className="text-text-2">Bloblex does not sell a subscription. Token cost, when the daemon can price it, comes from the provider account on that CLI. Unknown prices are not shown as zero.</p>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="windows">
                  <AccordionTrigger>Which systems does this release run on?</AccordionTrigger>
                  <AccordionContent>
                    <p className="text-text-2">Windows, with the MSVC C++ toolchain, Rust, Node, and WebView2 for development. This beta does not ship a signed installer yet. The local bundle path is NSIS/MSI.</p>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="source">
                  <AccordionTrigger>Where is the source?</AccordionTrigger>
                  <AccordionContent>
                    <p className="text-text-2">
                      The repository is{' '}
                      <a href="https://github.com/sico-vibes/bloblex" className="text-blob-working underline-offset-2 hover:underline" target="_blank" rel="noopener noreferrer">
                        sico-vibes/bloblex
                      </a>
                      . It contains the desktop app, the daemon, and the CLI adapters.
                    </p>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="beta">
                  <AccordionTrigger>What does beta mean here?</AccordionTrigger>
                  <AccordionContent>
                    <p className="text-text-2">0.1.0-beta.3 has the session, permission, budget, and companion work in the tree, covered by unit tests and fake-process tests. A signed installer, a clean-machine install, and a native window pass of the current tree are still open.</p>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </div>
        </section>

        <section className="py-20 sm:py-24">
          <div className="container mx-auto px-4 text-center sm:px-6">
            <div className="mx-auto max-w-2xl">
              <div className="mb-8 flex justify-center">
                <BlobCanvas color="#3b9eff" size={88} mood="success" label="Bloblex" />
              </div>
              <h2 className="mb-4 text-3xl font-semibold sm:text-4xl">Try the beta on Windows</h2>
              <p className="mb-8 text-lg text-text-2">{release?.installerUrl ? 'The latest GitHub release includes an installer.' : 'The signed installer is still pending. The source and build instructions are on GitHub.'}</p>
              <div className="flex flex-wrap items-center justify-center gap-4">
                {release?.installerUrl ? (
                  <Button as="a" href={release.installerUrl} download>
                    <Download className="h-5 w-5" />
                    Download {release.version}
                  </Button>
                ) : (
                  <Button as="a" href="https://github.com/sico-vibes/bloblex" target="_blank" rel="noopener noreferrer">
                    <Github className="h-5 w-5" />
                    Open the repository
                  </Button>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 py-8">
        <div className="container mx-auto px-6 text-center text-sm text-text-3">
          <p>Bloblex · local-first · Windows beta</p>
          <div className="mt-2 flex items-center justify-center gap-4">
            <a href="https://github.com/sico-vibes/bloblex" className="hover:text-text-2" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            <span aria-hidden="true">·</span>
            <a href="https://github.com/sico-vibes/bloblex/blob/main/README.md" className="hover:text-text-2" target="_blank" rel="noopener noreferrer">
              Docs
            </a>
            <span aria-hidden="true">·</span>
            <a href="https://github.com/sico-vibes/bloblex/issues" className="hover:text-text-2" target="_blank" rel="noopener noreferrer">
              Issues
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default App
