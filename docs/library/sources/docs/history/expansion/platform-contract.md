# Platform contract

Status: historical record, superseded in part (see update). Implementation contract for the platform lane; names are additive to the existing daemon and Tauri APIs. Daemon RPCs remain local by default. The UI must not receive provider credentials or raw provider protocol JSON.

## Daemon RPCs

The platform module handles `platform.setup.*`, `platform.github.*`, `platform.connectors.*`, `platform.computer.*`, and `remote.relay.*`. Each handler returns normalized JSON and a stable error code; subprocess output is bounded and redacted before it can reach RPC results or logs.

### Runtime setup

- `platform.setup.start({provider, action})` where `action` is `install`, `signin`, or `check`; returns `{jobId}`.
- `platform.setup.status({jobId})` returns `{jobId,state,stage,progress?,message?,errorCode?}`. State is `queued`, `running`, `succeeded`, `failed`, or `cancelled`.
- `platform.setup.cancel({jobId})` returns `{cancelled}`.
- `platform.free.catalog({})` refreshes the provider's current free-model metadata and returns verified entries with provenance/fetched time and explicit expiry/rate-limit notes; an empty or stale result cannot be selected.
- `platform.free.readiness({provider,model})` performs a real isolated tool-call readiness probe and returns `ready`, `not_ready`, or `unknown` with a normalized reason. Merely discovering a model or observing a zero price is not proof of free access.
- `platform.setup.free.catalog({runtimeId?})` returns `{models:[{id,name,provider,free:true,source,verifiedAt}],available,reason?}` from a fresh OpenCode Zen metadata query; no permanent free-tier promise is cached. Empty or unavailable metadata blocks selection.
- `platform.setup.free.check.start({runtimeId,modelId})` starts a readiness job and returns `{jobId}`. `platform.setup.status({jobId})` includes `evidence.verifiedToolRoundTrip` only after the installed native agent reads a randomized file in a disposable project and returns its marker. The probe policy blocks other tools and external directories; listing, installation, or a zero price never sets evidence true. A paid fallback is never selected.

### GitHub inbox

- `platform.github.status({})` returns CLI presence and authentication status without exposing auth files or tokens.
- `platform.github.inbox({repo?,kind?,cursor?})` returns bounded issue, pull request, and review items plus an optional cursor.
- `platform.github.details({url})` accepts only a canonical GitHub URL and returns a normalized read-only detail DTO.

GitHub uses the installed `gh` CLI's own login. It has no write operation in this API.

### MCP connectors

- `platform.connectors.registry.search({query,cursor?})` returns `{items:[{id,name,title,description,version,status,transportKinds,source}],nextCursor?,fetchedAt}`; `.featured({})` returns the current active registry entries matching common filesystem, Git, fetch, search and memory categories, with `{featured:true}`. `.list({scopeKind?,projectId?})` returns `{connections:[{id,connectorId,scopeKind,projectId,transport,state,credentialConfigured,createdAt,updatedAt}]}`; `.inspect({connectorId})` returns `{item}`. Server metadata is untrusted and cannot authorize tools.
- `.install({connectorId,scope})` installs or records a connector definition. Installation does not grant access.
- `.connect({connectorId,scopeKind,projectId?,definition?})` establishes a connection and returns `{connectionId,state}`. Scope is `user` or `project`; project scope requires `projectId`. A custom `stdio` definition is `{transport:'stdio',command:absolutePath,args:string[],envRefs?:Record<string,credentialRef>}`. A `streamable_http` definition is `{transport:'streamable_http',url,authHeaderName?,credentialRef?}`. Commands are never shell-interpolated. Credential values are supplied through a separate transient secret flow and stay in the OS credential store; persistent configuration holds references only.
- `.secret.set({connectionId,name,value}) -> {connectionId,credentialRef,stored:true}` is a transient local request whose result never echoes the value. Secret names are per connector and user-chosen; stdio definitions map environment variable names to references. `.oauth.start({connectionId,scopes?}) -> {flowId,connectionId,authorizationUrl,callbackUri,expiresAt}` discovers an OAuth server, performs legacy DCR and S256 PKCE, and binds a short-lived loopback callback. `.oauth.status({flowId})` returns the normalized flow state; `.oauth.cancel({flowId})` cancels it. Tokens are saved only in the Windows credential vault. The implementation still needs refresh-token handling and full current Protected Resource Metadata/CIMD discovery.
- `.disconnect({connectionId})` stops active transports. `.remove({connectorId})` removes an unused definition.
- `.tools.list({connectionId})` returns `{tools:[{name,title,description,inputSchema}]}` and `.resources.list({connectionId})` returns `{resources:[{uri,name,description,mimeType}]}`. Tool schemas and descriptions are bounded normalized DTOs, not raw protocol envelopes.
- `.test({connectionId})` performs a bounded health check.
- `.grant({connectionId,agentId,projectId?,allowedTools,originPolicy,deviceId?})` grants exact tool names to one bot and optional project; `originPolicy` is `local_only` or `operator_remote` (default `local_only`). Remote grants require the exact trusted paired-device id from the session context. Each connector action also needs an explicit local owner approval; neither bot mode nor provider annotations bypass it. `.grant.revoke({grantId})` revokes it immediately.
- `.grants.list({connectionId?,agentId?,projectId?})` returns `{grants:[{id,connectionId,agentId,projectId,allowedTools,originPolicy,expiresAt,revokedAt}]}`.
- `.reconnect({connectionId})` restarts a lost transport and reports its real health state.

Connector tools are brokered by the daemon. Each call checks the current session's agent, project, origin, remote tier/device and local grant. Provider annotations and connector-supplied metadata never authorize a call. Revocation cancels in-flight work where possible. Registry stdio packages that lack a verified managed installer return `setup_required` instead of pretending installation succeeded.

### Local computer control

- `platform.computer.status({agentId?})` returns `{available,enabled,activeAgentId?,errorCode?}` without screen content.
- `platform.computer.windows.list({})` returns `{windows:[{windowId,title,processName,visible,selected}]}` with bounded visible-window summaries and opaque selectable ids; `.windows.select({windowId})` validates a currently available target.
- `platform.computer.grant({agentId,windowId,actions,expiresAt?})` creates a local owner-approved grant scoped to a bot and window. Allowed action names are `window.read`, `screen.capture`, `pointer.click`, `pointer.scroll`, `keyboard.type`, and `keyboard.key`.
- `platform.computer.grants.list({agentId?})` returns `{grants:[{grantId,agentId,windowId,actions,expiresAt,revokedAt}]}`. `platform.computer.revoke({grantId})` revokes it; `platform.computer.stop({})` cancels active control globally.

The actual window and input operations are exposed only to the per-session daemon broker, not as remote RPCs or general Tauri commands. Default is disabled. Only one bot may control the desktop at a time; remote work additionally needs the operator tier and a local grant for that bot. No elevated or UAC interaction is supported.

### Relay

- `remote.relay.status({})` returns `{enabled,method,endpoint?,hostFingerprint?,offersCount,pairingsCount}`.
- `remote.relay.offer.create({tier?})` returns `{offerId,qrPayload,hostFingerprint,expiresAt,attemptsRemaining}` for a short-lived one-time offer, defaulting to chat tier. The QR payload carries the host identity, local-development relay endpoint, ephemeral handshake key, offer id and expiry; it contains no daemon capability or provider credential.
- `remote.relay.offer.cancel({offerId})`, `.pairings.list({}) -> {pairings:[{deviceId,name,tier,approvedAt,revokedAt,lastSeenAt}]}`, and `.pairings.revoke({deviceId})` manage local pairing lifecycle.
- Pending local-owner decisions are listed by `.pairing.requests.list({}) -> {requests:[{offerId,requestId,deviceId,deviceName,deviceKeyFingerprint,requestedAt}]}` and emitted as `remote.relay.pairing.requested` with the same DTO. `.pairing.approve({offerId,requestId,deviceId,tier})` and `.pairing.reject({offerId,requestId,deviceId})` record the explicit desktop-owner decision.

Relay is local-development-only in this lane. Pairing requires desktop approval. The relay forwards ciphertext only; decrypted requests pass through the same remote tier policy and redaction used by the existing gateway.

## Native shell

PTY commands are native-only: `pty_spawn({projectPath,cwd?,shell?}) -> {ptyId,pid}`, `pty_write({ptyId,data})`, `pty_resize({ptyId,cols,rows})`, `pty_status({ptyId})`, `pty_kill({ptyId})`. Events are `pty_output({ptyId,data,sequence})` and `pty_exit({ptyId,exitCode})`. Sessions are memory-only, hidden docks keep running, and shutdown reaps child process trees. The shell environment removes Bitbots capability variables.

Chat background assets have a separate local namespace from wallpapers: `select_chat_background_image({}) -> selectionToken?`, `chat_background_import({selectionToken})`, `chat_background_read({}) -> binary image response`, and `chat_background_clear({})`. The shell-issued opaque selection token prevents the renderer from supplying arbitrary paths. Import validates size, MIME signature, decoding and dimensions, uses atomic replacement, and does not upload the image. The remote bridge must refuse these calls.

## Events and data handling

Setup progress is queried with `.status`; no provider output or credentials are emitted as events. Computer-control activity events contain only action category, agent and timestamp, never screenshot pixels or typed text. Relay status and activity contain no message content, token, capability or traffic payload. Connector errors are normalized and redacted before returning to the UI.

