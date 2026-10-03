# Bloblex Marketing Website

Marketing landing page for Bloblex, built with React, TypeScript, Effect, and Tailwind CSS.

This package lives outside the root npm workspaces, so `npm ci` / `npm run build` at the repo root still only build the desktop app. Install and build from `website/`.

## Development

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

The site will be available at http://127.0.0.1:3000

## Build

Build for production:

```bash
npm run build
```

The build writes `public/release.json` with `npm run fetch-release` (an Effect script that reads the latest GitHub release, or the known 0.1.0-beta.3 fallback), typechecks, then emits `dist/`.

## Type Checking

Run type checks:

```bash
npm run typecheck
```

## Stack

- **React 19** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server
- **Effect** - Typed functional effects for data fetching and schemas
- **Tailwind CSS** - Utility-first styling
- **Radix UI** - Accessible component primitives
- **Lucide React** - Icon system

## Structure

```
website/
├── src/
│   ├── components/      # React components
│   ├── blob/           # Blob animation engine (ported from desktop app)
│   ├── lib/            # Utilities and Effect logic
│   ├── App.tsx         # Main app component
│   └── main.tsx        # Entry point
├── public/             # Static assets
└── index.html          # HTML template
```
