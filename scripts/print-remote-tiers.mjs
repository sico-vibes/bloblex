// Prints the remote method tier table used by docs/remote/PROTOCOL.md.
//
// Run from the repository root:
//   npx vite-node scripts/print-remote-tiers.mjs
//
// vite-node (already installed) resolves the TypeScript module and its
// `./remoteContract` import, so the table is generated, never duplicated.

import { renderTierTableMarkdown } from '../apps/desktop/src/remote/remoteTiers.ts'

process.stdout.write(renderTierTableMarkdown() + '\n')
