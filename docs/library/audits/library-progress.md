# Documentation library work log

> **What this is:** the running log of the library build lane (branch `docs-library`, worktree `D:\fx50`), kept so a successor can resume after an interruption.
> **Status:** complete for this brief; the checks and the report are recorded below.
> **Last updated:** 2026-10-19

## Rules in force

- Work only in `D:\fx50`. No `git commit`, `git push`, `git reset`, `git stash`, or checkout of other branches.
- Keep tool output small. This log is updated after each step.
- The library is self-contained: no network at build or view time. One dev dependency was added: `marked`.

## Steps

### 1. Surveyed the sources

- Read the reference library design (`scripts/docs-library.mjs`, `assets/viewer.*`, `tokens.css`, `README.md`) without copying its text or branding.
- Mapped the Bitbots docs tree: 267 Markdown files before this pass, 2.6 MB, already organised by the documentation lane under `docs/reference`, `guides`, `design`, `plans`, `operations`, `audits`, `history`, `evidence`, `releases`, `remote` and `library/audits`.
- Read `docs/STYLE.md`, `docs/README.md`, `docs/library/audits/inventory.md`, `DESIGN.md`, the Frost/Pop/Dot/Legacy stylesheets, the IPC contract, the approval-mode contract, the updater contract and the FIX20/21/31/32/36/40/41 records.

### 2. Added the dependency

- `npm install -D marked` at the root. No other package was added; the viewer uses the already installed `lucide-react` icon data at build time.

### 3. Screenshots

Started the preview in the background:

```powershell
npx vite --config apps/desktop/vite.preview.config.ts apps/desktop --port 5190 --strictPort --host 127.0.0.1
```

Captured with headless Microsoft Edge over the DevTools protocol, after seeding `localStorage` so the tour and the plan hint were dismissed. Each file is PNG, 1440×900 unless noted, and under 500 KB:

| File | URL |
| --- | --- |
| `main-bitbots-dark.png` | `/?style=bitbots` |
| `main-bitbots-light.png` | `/?style=bitbots&theme=light` |
| `main-blobots.png` | `/?style=blobots&theme=dark` |
| `main-legacy.png` | `/?style=legacy&theme=dark` |
| `main-pop.png` | `/?style=pop&theme=light` |
| `main-dot.png` | `/?style=dot&theme=dark` |
| `settings-appearance.png` | `/?preview-settings&style=bitbots`, then the Appearance page |
| `bot-art-sheet.png` | `/preview.html?theme=dark` (1200×900) |
| `bot-art-painted.png` | `/preview.html?art=painted&theme=dark` (1200×900) |
| `companion.png` | `/?companion&mode=home&view=chat&style=bitbots&seen-hints` (720×420) |
| `onboarding.png` | `/launch-preview.html?fixture=onboarding-step-1` |
| `launch.png` | `/launch-preview.html?fixture=in-progress` |
| `dictation.png` | `/dictation-preview.html?state=live&style=bitbots` (900×300) |

The launch and onboarding captures hide the preview fixture switcher with injected CSS. All captures are demonstration data from fixtures, not a real account. The preview server was stopped after the pass.

### 4. Diagrams

Six hand-authored SVGs in `assets/diagrams/`, using the `--dg-*` theme tokens and no script:

- `architecture.svg`
- `conversation-turn.svg`
- `approval-flow.svg`
- `look-art.svg`
- `remote-gateway.svg`
- `release-pipeline.svg`

They are inlined at build time and scoped to `svg.diagram-svg`; a reader can expand any diagram to the viewport with its Expand button or Escape.

### 5. Pages

23 pages in `content/`: `overview.md`, `glossary.md`, nine guides and twelve reference pages. Every page has the project front block. The guides use user terms; the reference pages cite code as `path:line` and name anything unverified. Three pages were added to the definitions in the build script so they sort first in their sections.

### 6. Build and viewer

- `scripts/docs-library.mjs` with `build`, `check` and `serve`.
- `assets/tokens.css`, `viewer.css`, `viewer.js`, the 96 px logo, the screenshots and the diagrams.
- The build discovers every Markdown file (tracked and new), classifies it, escapes raw HTML, rejects executable schemes, keeps local links inside the checkout, embeds local images and inlines SVG, writes one `docs/DOCUMENTATION.html`, a `catalog.json` and a Markdown snapshot per source.
- `serve` binds `127.0.0.1` only and serves the viewer at `/`; the viewer, its Markdown snapshots and the catalogue are also served under `/library/`.
- `docs/library/README.md` written; `docs/README.md` gained an entry; root `package.json` gained `docs:build`, `docs:check` and `docs:serve`.

## Checks

```text
node scripts/docs-library.mjs build
Built 293 documents into docs/DOCUMENTATION.html (14.83 MiB). 0 unresolved links recorded in catalog.json.

node scripts/docs-library.mjs check
Documentation check passed: 293 source hashes and snapshots match; every catalogue document exists; links and images resolve; no executable link; no reference project name; the HTML is self-contained.

npm run typecheck
exit 0
```

- Opened `file:///D:/fx50/docs/DOCUMENTATION.html` in headless Edge with no server: navigation, search (30 results for "remote native"), theme switch, six figures on the looks page, the architecture diagram and the mobile menu all worked; no console exception and no broken image.
- Case-sensitive search for the reference project's name in `DOCUMENTATION.html` and `catalog.json`: none. The check's broader case-insensitive word test also passes; a base64 image happens to contain those letters inside a longer run and is not a name.
- `docs/DOCUMENTATION.html` is about 15.55 million bytes (14.83 MiB) at the final build. It contains every document, image and diagram; it has no external script, stylesheet, font or image.

## Not verified

- The native transparent companion, a real microphone, a live provider turn, a real phone over Tailscale or Native, and a clean-machine install. Those need the native app and the release path, not the browser preview.
- The screenshots show fixture data; they do not establish provider behaviour.
