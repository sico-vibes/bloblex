# Bitbots documentation library

Open [DOCUMENTATION.html](../DOCUMENTATION.html) in a browser. It is one self-contained file at the top of `docs/`: navigation, search, the light and dark themes, diagrams, screenshots and the Markdown download all work without a server or a network connection.

The library has two parts:

- **New guides and references** in [content/](content/): the five-minute path, the task guides and the developer reference for this release.
- **Every existing project document**, included under clearly labelled Project library sections: plans, FIX-wave history, release notes, Remote specifications, evidence, audits and the project's own reference pages. Original paths are preserved because scripts and historical records depend on them.

## Rebuild

From the repository root:

```powershell
node scripts/docs-library.mjs build
node scripts/docs-library.mjs check
```

`build` writes `docs/DOCUMENTATION.html`, `catalog.json` and a Markdown snapshot for every source under `sources/`. `check` verifies the source hashes and snapshots, the document inventory, every internal link and image, that no executable link is present, and that the output is self-contained.

For a local preview:

```powershell
node scripts/docs-library.mjs serve --port 5205
```

The preview binds `127.0.0.1` only and serves the viewer at `/`, with its Markdown snapshots under `/library/sources/`. It does not serve the application, the rest of the checkout or any credential. The HTML file also opens directly from disk.

The build uses the root `marked` dev dependency. It adds no other dependency and makes no network request. Icons are taken from the installed `lucide-react` package at build time and inlined as SVG.

## Structure

- `content/`: the new pages, one document per page.
  - `overview.md` and `glossary.md`: what Bitbots is and the words it uses.
  - `guides/`: task-oriented pages for users.
  - `reference/`: how the system works, for developers.
- `assets/`: the viewer source (`viewer.js`, `viewer.css`, `tokens.css`), the 96 px Bitbots logo from `assets/icon/bloblex-master.png`, `screens/` and `diagrams/`.
- `audits/`: the documentation lane's inventory, progress log and review records. These are included in the library under Documentation.
- `sources/`: generated Markdown snapshots, retaining the original repository path. Edit originals, never these copies.
- `../DOCUMENTATION.html`: the generated viewer with every document, image and diagram embedded. It is the file to open.
- `catalog.json`: the generated manifest of paths, titles, sections, statuses, SHA-256 hashes and headings, plus unresolved links.

## Content policy

The new pages describe implemented behaviour, not intent in a plan. Claims about the code are cited as `path:line`; where a line may move, the function or test is named as well. Anything that was not checked says so and names the environment. Historical records keep their own wording and are labelled as historical, evidence or release notes; they are not rewritten as current guidance.

Every screenshot is demonstration data from the browser preview (`apps/desktop/src/preview`), not a real account. The command that produced it is in the work log at [audits/library-progress.md](audits/library-progress.md). Diagrams are hand-authored SVG in `assets/diagrams/`; they use the viewer's theme tokens and contain no script.

The viewer follows the Frost look: flat surfaces, hairline borders, rounded rectangles, no glow or gradient, Inter for text. It has no external font, stylesheet or script.

## Adding a page

1. Add a Markdown file under `content/` with a level-one heading and the front block used by the project (`What this is`, `Status`, `Last updated`).
2. Put it in the right section in `scripts/docs-library.mjs` (`definitions`). A page not named there is classified by its source path.
3. Cite code as `path:line`. Mark unverified claims.
4. Put images in `assets/` and link them relatively from the page; the build embeds them.
5. Run `build` and `check`.

A new diagram is an SVG in `assets/diagrams/`. Use the `--dg-*` tokens so it reads in both themes; the build scopes its styles and inlines it.
