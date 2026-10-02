# Parts of Bloblex derived from Multica

Multica (https://github.com/multica-ai/multica, commit 2ea01ae reviewed, Multica License = Apache 2.0 plus extra conditions, Copyright 2025-2026 Index Labs (Hong Kong) Limited) is the reference for Bloblex's provider-runtime hardening and usage/analytics logic. The owner decided on 2 October 2026 to adapt it for personal, non-commercial use. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and the comparisons in [MULTICA_RUNTIME_COMPARISON.md](MULTICA_RUNTIME_COMPARISON.md) and [MULTICA_ANALYTICS_COMPARISON.md](MULTICA_ANALYTICS_COMPARISON.md).

## Rules for every adapted file

1. Add a header comment: `Adapted from Multica (Multica License, Copyright 2025-2026 Index Labs (Hong Kong) Limited), <multica path>; changed: <what>`.
2. Re-implement in Rust/TS; never commit Multica files verbatim and never copy its logo, product name or copyright text into the UI.
3. Add the file to the table below in the same commit.
4. Keep derived code separable (own module or clearly marked functions) so it can be replaced if Bloblex is ever distributed, sold or hosted.
5. Never adopt behaviour that breaks the Bloblex invariants (AGENTS.md): no copied provider credentials, no terminal scraping, no raw provider JSON in React, unknown never shown as zero.

## Derived files

| Bloblex file | Multica source | Backlog item | Status |
| --- | --- | --- | --- |
| (none yet) | | | |

Backlog: runtime items A1-A14 (MULTICA_RUNTIME_COMPARISON.md) and analytics items A1-A18 (MULTICA_ANALYTICS_COMPARISON.md).
