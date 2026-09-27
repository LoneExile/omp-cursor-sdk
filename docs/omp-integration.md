# OMP × omp-cursor-sdk: Integration Architecture

This document explains, in full detail, how the `omp-cursor-sdk` plugin works
inside OMP (Oh My Pi, `@oh-my-pi` 18.x). It covers the loading lifecycle,
provider registration, model discovery, authentication, the turn path, the
OMP API surfaces the port had to adapt, and the known OMP-side behaviors and
limitations. The facts were first verified live against OMP 17.3.0
(2026-08-13..16) and re-checked against OMP 18.3.4 (2026-09-27).

---

## 1. Why this plugin exists

Cursor does not expose an OpenAI-compatible chat API. Verified facts:

- The Cursor Cloud Agents API (`api.cursor.com`) is an agent-orchestration
  REST API: `/v1/agents`, `/v1/agents/{id}/runs`, `/v1/models`, `/v1/me`,
  `/v1/repositories`, `/v1/sub-tokens`. It has **no**
  `/v1/chat/completions`, `/v1/responses`, or `/v1/completions` (all probe
  as 404).
- Therefore Cursor cannot be a plain `models.yml` provider in OMP, which
  requires an OpenAI-compatible endpoint.
- The working integration is the `@cursor/sdk` agent runtime: the agent
  **loop runs locally** (tool calls, sessions, thinking), while model
  inference is served by Cursor's backend, authenticated with a Cursor
  Dashboard API key (`crsr_...`).

`omp-cursor-sdk` is the OMP port of `fitchmultz/pi-cursor-sdk` (a Pi 0.84
provider extension). Pi and OMP are forks with diverged APIs; the port
remapped every import and adapted every drifted surface (see §7).

## 2. How OMP loads the plugin

- Install: `omp plugin link "$PWD"` from an `npm install`ed checkout (a
  symlink under `~/.omp/plugins/node_modules/`), or
  `omp plugin install github:LoneExile/omp-cursor-sdk`; see the README.
- OMP stores plugins under `~/.omp/plugins/` and loads each plugin's
  extension entry (the `pi.extensions` field in `package.json` →
  `./src/index.ts`) at session start, during the `loadExtensions` startup
  phase.
- The extension's default export receives the OMP `ExtensionAPI` object
  (`pi`). Plugins are loaded per session process: a fresh `omp` invocation
  loads the plugin fresh; the plugin does **not** persist between sessions.
- The plugin's `@oh-my-pi/*` packages are declared as regular `dependencies`
  (not dev/peer): OMP's plugin installer does not install devDependencies,
  and the host loader does not map every `@oh-my-pi` subpath for plugin
  imports (`@oh-my-pi/omptype/typebox` failed to resolve when they were
  devDeps).

## 3. Provider registration and model discovery

### 3.1 Registration

At load, the extension calls:

```
pi.registerProvider(CURSOR_PROVIDER /* "cursor-sdk" */, {
  baseUrl: "https://cursor.com",
  apiKey: CURSOR_API_KEY_CONFIG_VALUE,   // placeholder, see §4
  api: "cursor-sdk",                     // custom transport; OMP honors provider-supplied streamSimple
  models,                                // discovered catalog
  streamSimple: streamCursorLazy,        // the whole turn path (§5)
});
```

OMP's model registry accepts a provider-supplied `streamSimple` ("If provider
has streamSimple: registers a custom API streaming function"), so the
unknown `api: "cursor-sdk"` value is carried as a label; the custom
`streamSimple` is what actually runs turns.

The provider id is `cursor-sdk` (`src/cursor-model.ts`). OMP 18.x ships a
built-in OAuth `cursor` provider (api `cursor-agent`); registering the plugin
under that id merged both catalogs and let the plugin's Cursor-only hooks claim
built-in rows. `isCursorModel()` recognizes only `provider === "cursor-sdk"` or
`api === "cursor-sdk"`.

### 3.2 Model discovery

- `discoverModels()` loads `@cursor/sdk`'s `Cursor.models.list()` with the
  resolved API key.
- The raw SDK catalog is **41 models** (2026-09-27: composer-2.5, claude-opus-5,
  claude-fable-5, grok-4.7, gpt-5.6-sol/terra/luna, gemini-3.x, kimi-k3,
  glm-5.2, `default`/Auto, ...), each with `parameters` (effort,
  reasoning_effort, fast, thinking, context, reasoning) and `variants`.
- The extension expands these into **242 registered OMP model ids** via
  `getCursorModelSelectionIdentities()`:
  - base id: `grok-4.6`
  - context variants: `gpt-5.6-sol@272k`, `@1m`
  - fast variants: `grok-4.6@fast`, `grok-4.6@slow`
  - aliases: `gpt-5-6-sol`, `gpt-latest`, `kimi`, `composer-2-5`, ...
- The catalog is cached at `~/.omp/agent/cursor-sdk-model-list.json`,
  keyed by `sha256(apiKey)[:16]` (the key itself is never stored), with a
  24h TTL. `/cursor-refresh-models` bypasses the cache.
- The model list is **not** hand-maintained in `models.yml` — it comes from
  Cursor's live catalog, so new Cursor models appear after a refresh.

### 3.3 Context windows

Cursor's catalog publishes **no context window** for any model. The
extension resolves each id's window (`getContextWindow()` in
`src/model-discovery.ts`) from the bundled map in
`src/bundled-context-windows.ts` (measured from SDK checkpoints on
2026-09-27), overlaid by `~/.omp/agent/cursor-sdk-context-windows.json`
(written automatically from each completed run's
`checkpoint.tokenDetails.maxTokens`, used from the next registration). Keys are
tried in order: the exact id, its canonical default-lane id, the same model and
context without `@fast`/`@slow` (the lane does not change the window), then the
catalog context label (`@1m` → 1000000), the base id, and `"default"`.

Cursor Max-mode windows are not reachable: the SDK `ModelSelection`
(`{ id, params }`) has no max-mode field. Measured `@1m` variants run at
200k–300k (GPT `@1m` at 272000), and `grok-4.7@500k` is refused with
`Invalid parameters for registry model`; the provider error appends a hint naming the
next smaller catalog context (`@256k`), and none when the model has no smaller
context (`src/cursor-provider-errors.ts`).

## 4. Authentication and key resolution

Cursor Dashboard API key (`crsr_...`), stored in `~/.omp/.env` as
`CURSOR_API_KEY`.

### 4.1 Key precedence (turn time)

```
options.apiKey (from OMP's registry)  ->  resolveCursorStringApiKey()
    -> resolves ApiKeyResolver forms via OMP's resolveApiKeyOnce
process.env.CURSOR_API_KEY   (OMP loads ~/.omp/.env once, at startup)
ctx.modelRegistry.getApiKeyForProvider("cursor-sdk")   (OMP's store for this provider id)
```

Implementation: `resolveCursorApiKey()` normalizes placeholders
(`$CURSOR_API_KEY`, `${CURSOR_API_KEY}`, the provider-config sentinel) to the
env value; `resolveCursorStringApiKey()` resolves an `ApiKey`
(`string | ApiKeyResolver`) to the literal string the Cursor SDK needs.

### 4.2 The registration placeholder

`registerProvider` uses a non-empty placeholder
(`omp-cursor-sdk-cursor-api-key-placeholder`) so the provider registers even
before auth exists. The real key is resolved at discovery and turn time.
OMP's registry stores the placeholder as the provider's config key
(`ModelRegistry.registerProvider` → `authStorage.keys.setConfig`), and a
config key counts as auth in `KeyCascade.source()`, so `cursor-sdk` models are
available in `omp models` and the `/model` picker without stored credentials.
The legacy `pi-cursor-sdk-...` placeholder string is still recognised for
compatibility with older saved configs.

### 4.3 Why the plugin never opens OMP's agent.db

Earlier port versions opened a second sqlite connection to OMP's credential
store (`SqliteAuthCredentialStore` on `~/.omp/agent/agent.db`) to read/write
a stored credential. That second connection's `close()` triggered
nine macOS `EXC_GUARD` kills (guarded sqlite fds closed from a bun
background thread — identical guard token across all crash reports), so the
plugin now resolves the key env-only. Keys stored for the `cursor-sdk`
provider id are read via `ctx.modelRegistry.getApiKeyForProvider("cursor-sdk")`
— by OMP's connection, never a second one. The built-in `cursor` provider's
OAuth credential (omp `/login`) is never read: it is an OAuth access token, not
a Cursor SDK API key. Do not reintroduce a direct `SqliteAuthCredentialStore`
open from the plugin.

## 5. The turn path

When OMP needs a model turn for a `cursor-sdk/*` model, it calls the
provider's `streamSimple`:

```
streamCursor(model, context, options)
  -> createAssistantMessageEventStream()
  -> CursorProviderTurnRunner.run()
       -> prepare: buildCursorModelSelection(model.id, reasoning, fastEnabled)
            -> maps OMP's --thinking level (already clamped by OMP to the
               model's advertised `thinking.efforts`) to the SDK's
               effort/reasoning_effort/reasoning/thinking param
            -> fastEnabled from the model's fast override (@fast/@slow) or
               --cursor-fast/--cursor-no-fast or the model default
       -> load @cursor/sdk, Agent.create({ apiKey, model: selection, mode, local })
            -> local agent loop (session, tools, thinking) runs on the machine
       -> agent.send(payload, { mode, model, onDelta, onStep })
       -> run.wait()  ->  RunResult
       -> usage accounting applied to the assistant message
  -> stream events pushed back to OMP (start / text deltas / done | error)
```

### 5.1 Runtime selection

- **Local (default):** the SDK agent loop runs locally; models are served by
  Cursor's backend with the key.
- **Cloud (opt-in):** set `PI_CURSOR_RUNTIME=cloud` plus the ack/config env
  vars (`PI_CURSOR_CLOUD_ACK`, `PI_CURSOR_CLOUD_REPO`, ...). Cloud agents
  run in Cursor-hosted VMs.

### 5.2 Error handling and overflow normalization

- SDK errors are sanitized by `sanitizeCursorProviderError()` (scrubs the
  key from messages, classifies auth/network/rate-limit).
- **Context-overflow normalization:** OMP auto-compacts on
  `context_length_exceeded`. Pi rewrote overflow failures via the
  `message_end` event; OMP's `message_end` handler cannot return a
  replacement message, so the rewrite runs in the provider's terminal-error
  path (`pushTerminalError`) instead.
- `ApiKey` values that are resolvers are never stringified into requests.

### 5.3 Usage accounting

Per-run SDK `TokenUsage` (input/output/cacheRead/cacheWrite/totalTokens) is
applied to the assistant message so OMP's dashboard and `stats.db` see
real usage. Context-window budget math null-guards OMP's `Model` fields
(`contextWindow`/`maxTokens` are nullable in OMP). When the SDK reports no
usable usage, the estimate is floored at the newest same-model assistant usage
accepted by the forward scan of OMP's `findRequestUsageAnchor` (`pi-agent-core`
compaction/transcript-tokens.ts): a compaction or branch summary
(`historyRewriteAt`) or a pruned tool result (`prunedAt`) raises the rewrite
time, and an assistant listed after it qualifies only if its timestamp is later.
Assistants listed before the rewrite stay valid.

## 6. Session lifecycle integration

The extension wires into OMP's session events:

- **session scope:** cwd/session-file tracking via `session_start`
  (OMP's event carries no project-trust or session-info payload — Pi's
  `project_trust` and `session_info_changed` events do not exist in OMP).
- **agent pooling & resume:** session-scoped Cursor SDK agents are pooled
  and resumed across turns within a session. A follow-up turn is sent
  incrementally with every user and developer message appended since the
  last send (OMP adds plan/goal context, `!` output, @file mentions,
  `before_agent_start` and nextTurn messages around the prompt); the agent is
  reset and re-bootstrapped only when the context diverges structurally
  (system prompt change, edited or shrunk history, a summary, or tool results
  with no live run).
- **compaction summarizer:** OMP runs it on the session side-stream, outside
  the agent loop, and with async compaction concurrently with normal turns.
  The plugin registers no `session_before_compact` handler: its presence alone
  disables speculative compaction for every session in the process
  (`session-maintenance.ts` `hasHandlers("session_before_compact")` checks in
  `maybeStartSpeculativeCompaction`, `deferThresholdCompactionToSpeculation`,
  `#claimArmedSpeculation`). Instead `session.compacting` (emitted and awaited
  before the summarizer's LLM call on every compaction path) opens a window
  that `session_compact` or the next `before_agent_start` closes. Inside it, a
  request that does not continue the pooled conversation runs on a one-shot
  agent: no pool entry, no pi tool bridge, no live run, no resume handle, a
  temporary store removed afterwards. Turn events cannot mark it: the agent
  loop delivers `turn_start`/`turn_end` to extensions fire-and-forget
  (`pi-agent-core` `agent.ts` `#emit`), so they are not ordered before the
  provider call. Handoff generation emits no `session.compacting` and still
  uses the pooled agent.
- **tool bridge:** an MCP bridge can expose OMP tools to the Cursor agent. Its
  `tool_call`/`tool_result` handlers attach on the first Cursor run that
  exposes pi tools, because any such handler turns off OMP's speculative
  local-read tool execution (`speculation/host.ts` `hasLifecycleHandlers`) and
  OMP has no unsubscribe.
- **native tool display:** the port registers only the self-contained
  `cursor_replay_activity` tool. Pi shadowed the builtin
  read/bash/edit/write/grep/find/ls tools to render Cursor-native activity;
  OMP exposes no wrapped builtin definition to delegate execution to, so
  builtin shadowing is **not portable** and those names are never
  registered (registering one throws "Unsupported Cursor native replay
  tool" — fixed by filtering to replay-only names).

## 7. OMP API surfaces the port adapted

Verified drift table (OMP 17.3.0, re-checked on 18.3.4, vs Pi 0.84):

| Surface | Pi 0.84 | OMP 17.3.0 / 18.3.4 | Port action |
|---|---|---|---|
| imports | `@earendil-works/pi-*` | `@oh-my-pi/pi-*` | remapped |
| tool schemas | `typebox` | `@oh-my-pi/omptype/typebox` (OMP's legacy shim) | import swap |
| `getSystemPrompt()` | string | `string[]` | `.join("\n")` |
| `BeforeAgentStartEvent.systemPrompt` | string | `string[]` | join; result `systemPrompt: string[]` |
| `BeforeAgentStartEvent.systemPromptOptions` | present | absent | source skills from `getActiveSkills()` |
| `ctx.getSystemPrompt()` | string | `string[]` | join |
| `ctx.mode` / `isProjectTrusted` / `signal` | present | absent | drop / AbortController / `hasUI` |
| `SessionShutdownEvent.reason` | present | absent | always dispose |
| `model_select` event | present | absent | not registered (handlers inert) |
| `project_trust` / `session_info_changed` | present | absent | dropped |
| `message_end` result rewrite | supported | not supported | moved into provider error path |
| `ToolDefinition` fields | `promptSnippet`, `promptGuidelines`, `executionMode` | not present | removed |
| `renderCall` / `renderResult` | `(args, theme, context)` | `(args, options, theme)` / `(result, options, theme, args?)` | signature swap; `fg`/`bold` via Theme |
| `Skill.disableModelInvocation` | present | absent | filter on `Skill.hide` |
| thinking levels | `ModelThinkingLevel`/`ThinkingLevelMap` on the model | `ProviderModelConfig.thinking` (`{ mode, efforts, requiresEffort? }`); `thinkingLevelMap` ignored | internal level map kept for selection; each model advertises `thinking: { mode: "effort", efforts, requiresEffort }` derived from it |
| provider id `cursor` | free | built-in OAuth provider (18.x) | plugin registers `cursor-sdk` |
| `CONFIG_DIR_NAME` | pi-coding-agent | `@oh-my-pi/pi-utils` | import moved (value `.omp`) |
| `readStoredCredential` | shim export | absent | env key + `modelRegistry.getApiKeyForProvider` |
| `create*ToolDefinition` | root exports | absent | not used (shadowing dropped) |
| config paths | `~/.pi` | `~/.omp` | automatic via pi-utils |

## 8. OMP-side behaviors and limitations

### 8.1 Availability and the `/model` picker

`omp models` and the `/model` picker both list `ModelRegistry.getAvailable()`
(`cli/models-cli.ts`, `modes/controllers/selector-controller.ts`). A provider is
available when `authStorage.keys.source(provider)` reports auth, and a config
key installed by `registerProvider({ apiKey })` counts (§4.2). With OMP 18.3.4,
`omp models cursor-sdk` lists the plugin's rows and `omp models cursor` lists
only the built-in provider's rows. The 17.x limitation (cursor models missing
from the picker) no longer applies.

### 8.2 The `:fast`/`:slow` id collision

OMP's model-id grammar treats `model:level` as thinking-level syntax
(`opencode-go/deepseek-v4-flash:xhigh`). Pi's `:fast`/`:slow` suffix was
normalized away at registration and could never be selected. The port
renamed the suffix to `@fast`/`@slow` (OMP treats `@` literally, proven by
the `@context` variants).

Where the `:<level>` suffix works for `cursor-sdk` models (omp 18.3.4, 2026-09-27):

- `modelRoles` in `config.yml` (and roles saved from `/model`): yes. A
  `--config` overlay with `default: cursor-sdk/kimi-k3:low` ran with
  `reasoning=low`, and `default: cursor-sdk/grok-4.7@256k:xhigh` sent
  `reasoning_effort=xhigh` (debug `metadata.json`). Roles resolve after
  extensions register.
- `--model`: no. `--model cursor-sdk/kimi-k3:low`,
  `cursor-sdk/grok-4.7@256k:low` and `…@256k@slow:low` exit with
  `Model "…" not found`, also at commit 466af27 (before the thinking-metadata
  change). Use `--model cursor-sdk/<id> --thinking <level>` instead.

Cause (host): `main.ts:1342-1374` resolves `--model` before extensions load.
On a miss it defers to the post-extension resolution (`options.modelPattern` →
`sdk.ts:2594-2713`, which handles `:level`) only when
`!parsed.model.includes(":")` (`main.ts:1367`); a selector carrying a
thinking suffix exits at `main.ts:1372-1373`. The resolver itself accepts the
id shape: once the provider is registered, `resolveCliModel` returns
`cursor-sdk/grok-4.7@256k@slow` with level `xhigh`. Built-in
(`cursor/gpt-5.6-luna:low`) and `models.yml` providers exist before that
check, so their suffixes resolve.

### 8.3 Backend flakiness

Cursor's backend intermittently returns gRPC `UNAUTHENTICATED`
("Connect error unauthenticated: Error") for some grok requests through the
SDK path, even when the identical key/params succeed standalone and in
other runs. It is non-deterministic and backend-side; retry or use the
`@fast` variant (observed reliable).

### 8.4 Priced variants

Cursor's pricing distinguishes standard and Fast variants (Grok 4.6:
$2/$0.50/$6 per M standard, $4/$1/$12 Fast; 50% launch discount from
2026-08-12). The plain base id defaults to the model's default variant
(fast:true for grok-4.6), so to guarantee standard pricing use the explicit
`@slow` id. Fast is a speed tier, not a different model — `--thinking`
controls reasoning depth on both variants.

## 9. Operation reference

### Slash commands (in-session)

- `/cursor-refresh-models` — refresh the live catalog (bypasses cache)
- `/cursor-fast` — toggle fast mode for the current Cursor model
- `/cursor-tools` — live tool-surface debug report
- `/cursor-mode <agent|plan>` — agent/plan mode

### Flags

- `--cursor-fast` / `--cursor-no-fast` — force fast mode on/off
- `--cursor-mode <agent|plan>` — CLI mode override
- `--thinking <level>` — one of the model's advertised efforts (the
  `thinking` column of `omp models cursor-sdk`), or `off` where Cursor has an
  off value; mapped to the SDK effort/reasoning_effort/reasoning/thinking param

### Environment

- `CURSOR_API_KEY` — API key (`~/.omp/.env` is loaded once at omp startup)
- `PI_CURSOR_RUNTIME=cloud` — opt into cloud agents
- `PI_CURSOR_CLOUD_ACK=1` (+ `PI_CURSOR_CLOUD_REPO`, ...) — cloud ack/config
- `fastDefaults` in `~/.omp/agent/cursor-sdk.json` — saved per-model fast defaults
- `PI_CURSOR_SDK_EVENT_DEBUG=1` — SDK event debug logging

### Files

- `~/.omp/agent/cursor-sdk-model-list.json` — model catalog cache (fingerprint-keyed)
- `~/.omp/agent/cursor-sdk-context-windows.json` — measured context windows
  (written from run checkpoints; user-editable)
- `~/.omp/agent/cursor-sdk.json`, `<cwd>/.omp/cursor-sdk.json` — user and
  project config

### Verification

- `npm run typecheck:src` — typecheck against OMP 18.3.4 types.
- `bun test` — the port-relevant unit suite, run in the **Bun runtime** (the
  runtime OMP loads the plugin in). The upstream 126-file suite was written
  for Pi and is partially OMP-incompatible (imports of Pi-only exports such
  as `createEventBus` / `InMemoryCredentialStore`); `npm test` scopes to the
  port-relevant files and `npm run test:full` runs the rest, which still has
  known Pi-bound failures. Do not run the suite under Node — the `@oh-my-pi`
  packages are Bun-targeted (`import.meta.dir`, `Bun.env`).
- `omp -e ./src/index.ts --model cursor-sdk/composer-2.5 --no-session -p "Reply with exactly OK"` — smoke turn
- `omp -e ./src/index.ts --model cursor-sdk/grok-4.7@256k --thinking xhigh ...` — variant turn
- `omp models cursor-sdk -e ./src/index.ts` — registered rows, windows, thinking levels
- `omp plugin list` — plugin enabled
- `bun -e 'import("./src/index.ts").then(m=>console.log(typeof m.default==="function"))'`
  — load-under-Bun proof (mirrors OMP's loader)
