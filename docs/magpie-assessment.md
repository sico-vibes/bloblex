# Magpie assessment, proposed expansion

Reviewed 1 October 2026 against the supplied research and the public repository. Recommendation only; the user has not yet requested implementation or modification of the authoritative plan.

## Decision

Allow an optional Magpie integration after native CLI execution passes QA. Keep the Rust daemon authoritative for sessions, process lifecycle, permissions and budgets. Initially connect to an independently installed gateway instead of embedding or rewriting it.

The gateway's documented model/API translation provides a useful separation between harness and model. The repository is MIT licensed. These are capabilities advertised or found in source, not an end-to-end Windows compatibility result.

- [Repository](https://github.com/yetone/magpie)
- [License](https://github.com/yetone/magpie/blob/main/LICENSE)
- [Go dependencies](https://github.com/yetone/magpie/blob/main/go.mod)

## Staged scope

| Stage | Proposed capability |
| --- | --- |
| Current v1 | Native provider sessions; extensible model, billing and telemetry provenance |
| Next phase | Optional gateway connection, model catalog, route visibility, correlated usage import, isolated per-session configuration |
| Later | Provider-specific subscription sharing, quota telemetry and controlled failover |

Preserve the existing three-column UI and the user's bottom-center draggable companion. Show model/provider information progressively in context or settings.

## Findings that change the pasted research's conclusion

Magpie reads CLI credentials and may write refreshed tokens back. Bloblex's existing CLI-only authentication boundary would need deliberate revision for equivalent subscription sharing. Private quota endpoints also have a different compatibility burden from provider-owned CLI commands.

The Claude subscription bridge runs the local binary and bridges caller tools over MCP. Its launch includes a permission-bypass flag. This requires a dedicated approval-boundary assessment before adoption, rather than assuming our native permission broker remains effective automatically.

Magpie's ledger combines gateway records and native session records using correlation. It prices records at query time. Bloblex should adopt source attribution and deduplication concepts while retaining versioned valuation records for auditable budget enforcement.

Its loopback gateway accepts arbitrary tokens. That behavior cannot replace Bloblex's authenticated, user-scoped control channel.

- [Subscription and quota source](https://github.com/yetone/magpie/blob/main/internal/provider/subscription_usage.go)
- [Claude subscription bridge](https://github.com/yetone/magpie/blob/main/internal/gateway/claude_subscription.go)
- [Usage ledger](https://github.com/yetone/magpie/blob/main/internal/usage/ledger.go)
- [Gateway access behavior](https://github.com/yetone/magpie/blob/main/internal/gateway/lan.go)

## Acceptance gates for a future integration

- Pin and test a supported Magpie version; no silent prerequisite or automatic global configuration rewrite.
- Preserve native sessions when the gateway is disabled or unavailable.
- Record Bloblex session/turn, native request ID, telemetry source, requested/served model, upstream provider, and pricing version; count each call once.
- Test streaming text, fragmented tool arguments, parallel tools, cancellation, permission rejection, errors and gateway restart for every supported harness/model/API path.
- Keep actual charges, estimates, subscription fees and provider quota distinct; show unsupported and stale telemetry explicitly.
- Preview and back up any configuration edits; restore only owned changes.
- Define who owns gateway credentials and approval enforcement before enabling subscription routes.
- Failover must preserve user-selected provider/budget boundaries and have an explicit policy.

No Magpie code, executable, credentials or configuration has been installed or imported into Bloblex by this assessment.
