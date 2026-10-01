# omp-cursor-sdk

An [omp](https://github.com/can1357/oh-my-pi) plugin that registers Cursor's model catalog as the
`cursor-sdk` provider. Turns run through the official [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript)
agent runtime, authenticated with a Cursor API key. It coexists with omp's built-in `cursor` provider;
the two share no models, credentials, or ids.

| | `cursor-sdk` (this plugin) | `cursor` (built into omp) |
|---|---|---|
| Auth | Cursor API key in `CURSOR_API_KEY` | omp `/login` (Cursor OAuth) |
| Transport | `@cursor/sdk` local agent loop | omp's direct Cursor agent API (`cursor-agent`) |
| Model ids | Cursor catalog ids plus variants: `grok-4.7@256k`, `grok-4.6@fast` | Effort-tier ids: `grok-4.7-high`, `grok-4.7-high-fast` |

## Requirements

- omp 18.3 or newer (tested with 18.3.4).
- A Cursor user API key or service-account API key (Cursor Dashboard → API Keys).
- For a local checkout: npm and Node ≥ 22.19.

## Install

From npm:

```bash
omp plugin install omp-cursor-sdk
```

From a local checkout, for development (`link` symlinks it, so edits apply on the next omp start):

```bash
git clone https://github.com/LoneExile/omp-cursor-sdk && cd omp-cursor-sdk
npm install
omp plugin link "$PWD"
```

The `github:` shorthand and raw git-URL specs are resolved differently by installer versions, so the
npm form above is the portable one; use it if either of those fails (see Troubleshooting).

Manage it (restart omp after any change):

```bash
omp plugin list                                        # shows omp-cursor-sdk@<version>
omp plugin install omp-cursor-sdk --force              # update an npm install
omp plugin disable omp-cursor-sdk                      # keep installed, stop loading
omp plugin enable omp-cursor-sdk
omp plugin uninstall omp-cursor-sdk                    # also removes a link, not your checkout
```

## API key

Add the key to `~/.omp/.env` (or export it in the environment), then restart omp. omp reads
`~/.omp/.env` only at startup.

```bash
echo 'CURSOR_API_KEY=crsr_...' >> ~/.omp/.env
omp models cursor-sdk
```

`omp models cursor-sdk` should list the live catalog (a few hundred rows). The plugin never writes the
key to disk; the catalog cache is keyed by a hash of it.

## Usage

Model selector: `cursor-sdk/<model>[@<context>][@fast|@slow]`. On the command line set the level with
`--thinking <level>`; `--model cursor-sdk/<id>:<level>` fails with "Model not found" because omp 18.3.4
resolves `--model` before plugins register. In `modelRoles` (config.yml, `/model` role assignment) the
`:<level>` suffix works, e.g. `default: cursor-sdk/grok-4.7@256k:xhigh`.

```bash
omp --model cursor-sdk/composer-2.5
omp --model cursor-sdk/grok-4.7@256k --thinking xhigh
omp --model cursor-sdk/claude-opus-5@300k@slow --thinking max
omp --model cursor-sdk/gpt-5.6-sol@272k --thinking off
```

- **Thinking levels** are exactly the ones Cursor exposes for the model (the `thinking` column of
  `omp models cursor-sdk`): `grok-4.7` offers `low..xhigh`, many Claude and GPT-5.6 models add `max`.
  `off` works only where Cursor has an off value (Claude `thinking=false`, GPT-5.4 and later `none`).
- **Context variants** (`@256k`, `@1m`, …) come from Cursor's catalog. A model with context variants
  is registered only as `<model>@<context>` rows (there is no bare `cursor-sdk/grok-4.7`, only
  `@256k` and `@500k`); a bare id exists only for models without a context parameter. The other
  parameters (effort, fast) start from Cursor's default variant.
- **Fast lanes**: `@fast` and `@slow` pin Cursor's fast parameter. Without a suffix the model's
  default applies; `/cursor-fast` toggles and saves it for that model, and `--cursor-fast` /
  `--cursor-no-fast` force it for one run.

## Context windows

Cursor's catalog does not publish context windows. The plugin uses windows measured from real SDK
runs: a bundled table, refined by each completed run into `~/.omp/agent/cursor-sdk-context-windows.json`
(used from the next session). Default runs stay on the non-Max window, so most `@1m` variants measure
200k–300k (GPT `@1m` at 272k, Claude `@1m` at 300k or less). Wider catalog variants such as
`grok-4.7@500k` reach their full window only with [Cursor Max Mode](#cursor-max-mode); without it
Cursor refuses the selection (see Troubleshooting).

## Cursor Max Mode

Cursor's `RequestedModel` carries a `max_mode` boolean, and `@cursor/sdk` never sets it. Without that
flag Cursor refuses catalog variants such as `grok-4.7@500k` (`AI Model Not Found Invalid parameters
for registry model`) and the wide `@1m` rows keep their non-Max window. Max Mode is opt-in and needs
both halves:

1. **Patch the SDK the plugin imports** — once per install:

   ```bash
   npm run patch:cursor-sdk                 # this checkout's node_modules/@cursor/sdk
   node scripts/patch-cursor-sdk.mjs --all  # ...and the hoisted ~/.omp/plugins copy, when present
   node scripts/patch-cursor-sdk.mjs --check --all   # per-file status for both copies; fails on drift
   ```

   An npm plugin install has no `node_modules/@cursor/sdk` of its own (the SDK is hoisted), so `--all`
   exits 1 there. Patch the hoisted copy by path, from the installed package directory:

   ```bash
   cd ~/.omp/plugins/node_modules/omp-cursor-sdk
   node scripts/patch-cursor-sdk.mjs --sdk ~/.omp/plugins/node_modules/@cursor/sdk
   ```

   The patch (marker `omp-cursor-sdk:max-mode-patch`) makes the SDK set `RequestedModel.maxMode` when
   the selection carries `{id:"max_mode", value:"true"}`, and strips that sentinel before the request
   leaves. It is local `node_modules` state and never ships in the published tarball.

2. **Turn it on** — `--cursor-max-mode`, `PI_CURSOR_MAX_MODE=1`, or `/cursor-max-mode on`
   (`--save-user` persists to `~/.omp/agent/cursor-sdk.json`; project config is never read).
   Precedence: `--cursor-no-max-mode` > `--cursor-max-mode` > `PI_CURSOR_MAX_MODE` > session toggle >
   user config > off. The status line shows `max:on` while it is active.

Restart omp after patching: a running process keeps the SDK module it already loaded, so the guard
reports `was patched after this process started` until you restart. Re-apply the patch after every
`omp plugin install` or reinstall. With Max Mode on and an unpatched (or stale) SDK, the turn fails
before the request and names the resolved path instead of silently sending the old selection.
The guard locates that copy by walking the `node_modules` chain from its own file, so it still finds
the SDK inside the single-file `omp` binary, where `import.meta.resolve` cannot resolve a bare
specifier for a plugin file.

Max Mode and long context bill at Cursor's higher long-context rates; the surcharge depends on your
plan and model, so check Cursor's pricing page. The default is off.

## omp advisors

An omp advisor (a `WATCHDOG.yml` advisor or the `advisor` model role) on a cursor-sdk model gets a
read-only Cursor agent: only the built-in `read`, `grep` and `glob` tools that omp granted the
advisor, with no Cursor shell, edits, MCP servers or subagents, even when the advisor's `tools` grant
omp's `bash` or `edit`. On the local runtime, compaction and branch summaries that use omp's summarization
prompt get no built-in tools at all, including the summary that compacts an advisor's context.
Cursor cloud agents cannot be limited this way, so the plugin refuses advisor requests on the cloud
runtime; summaries there keep Cursor's full cloud toolset. Advisors also get no pi tool bridge, so
without an owned dialect (`PI_DIALECT`) a cursor-sdk advisor has no `advise` tool and its notes never
reach the main session; run the advisor on another provider to get advice.

## Commands and flags

| Command | Purpose |
|---|---|
| `/cursor-refresh-models` | Fetch the live catalog now and re-register models |
| `/cursor-fast` | Toggle fast mode for the selected model |
| `/cursor-max-mode [on\|off\|toggle] [--save-user]` | Opt into Cursor Max Mode for this session. `--save-user` writes `~/.omp/agent/cursor-sdk.json` only |
| `/cursor-mode agent\|plan` | Cursor conversation mode |
| `/cursor-runtime local\|cloud [--save-user\|--save-project]` | Local or Cursor Cloud runtime |
| `/cursor-cloud list \| archive <id> \| delete <id> --yes` | Manage recorded Cloud agents |
| `/cursor-http [on\|off\|toggle]` | HTTP/1.1/SSE transport compatibility |
| `/cursor-refresh-config` | Reload Cursor config into the current pooled agent |
| `/cursor-local-resume-cleanup [--dry-run\|--yes]` | Delete superseded local SDK agents |
| `/cursor-tools` | Tool-surface report (debug) |

Flags: `--cursor-fast`, `--cursor-no-fast`, `--cursor-max-mode`, `--cursor-no-max-mode`, `--cursor-mode <agent|plan>`, `--cursor-runtime <local|cloud>`, `--cursor-cloud-*`.

## Environment and files

Full lists: [docs/omp-integration.md](docs/omp-integration.md), [docs/cursor-model-ux-spec.md](docs/cursor-model-ux-spec.md).

| Name | Meaning |
|---|---|
| `CURSOR_API_KEY` | Cursor API key (required) |
| `PI_CURSOR_MAX_MODE` | `1`/`true`/`on` or `0`/`false`/`off`. Forces Max Mode for the process. Below CLI flags, above the session toggle |
| `PI_CURSOR_RUNTIME` | `local` (default) or `cloud` |
| `PI_CURSOR_SETTING_SOURCES` | Cursor settings/rules the SDK loads: `all` (default), a comma list, or `none` |
| `PI_CURSOR_SDK_MODEL_CACHE_TTL_MS` | Catalog cache TTL (default 24 h); `PI_CURSOR_SDK_DISABLE_MODEL_CACHE=1` disables it |
| `PI_CURSOR_SDK_EVENT_DEBUG=1` | Write raw SDK event artifacts to `.debug/cursor-sdk-events/` in the cwd |
| `~/.omp/agent/cursor-sdk.json`, `<cwd>/.omp/cursor-sdk.json` | User and project config |
| `~/.omp/agent/cursor-sdk-model-list.json` | Catalog cache |
| `~/.omp/agent/cursor-sdk-context-windows.json` | Measured context windows |

**Cloud runtime** (opt-in): `--cursor-runtime cloud` or `PI_CURSOR_RUNTIME=cloud` runs the agent in a
Cursor-hosted VM against a Git repository instead of your machine. The first use needs an explicit
acknowledgement (`--cursor-cloud-ack` or `PI_CURSOR_CLOUD_ACK=1`); uncommitted or unpushed local
state is rejected unless allowed. `/cursor-cloud` lists, archives, or deletes the agents it created.

## Troubleshooting

- **No `cursor-sdk` rows**: the plugin is not loaded (`omp plugin list`) or is disabled. Without a key
  the plugin still lists a bundled fallback catalog and warns when you select a model; turns fail
  until `CURSOR_API_KEY` is set and omp restarted.
- **`Package installed but package.json not found at …/node_modules/omp-cursor-sdk/package.json`** (or
  at `…/node_modules/github:LoneExile/omp-cursor-sdk/package.json`): the installer resolves the spec to
  a directory name (`github:` and raw URLs are not mapped to the package name on every omp version), or
  `bun` never installed anything. Check `cat ~/.omp/plugins/package.json`: a failed `github:` attempt
  can leave a git spec or an empty version (`"omp-cursor-sdk": ""`) in `dependencies`, and the matching
  `bun.lock` entry can survive as a duplicate key that makes `bun add` exit instantly without installing
  (`warn: Duplicate key … at bun.lock`). Install with an explicit version after clearing that state:

  ```bash
  cd ~/.omp/plugins
  rm -f bun.lock                 # holds the failed resolution; bun regenerates it
  bun add omp-cursor-sdk@0.4.3   # writes a real range and installs the plugin's own dependencies
  ls node_modules/omp-cursor-sdk/package.json node_modules/@cursor/sdk/package.json
  omp plugin list
  ```

  Restart omp afterwards — plugins load at startup, so a session that was already running still sees the
  old module graph. Keep one source per plugin: with the npm version pinned in `~/.omp/plugins/package.json`,
  installing the `github:` form on top fails with `Package "omp-cursor-sdk@0.4.3" has a dependency loop`.
- **`AI Model Not Found Invalid parameters for registry model`**: Cursor refused the selected
  parameters. For a larger context variant that means Max Mode is not active — see
  [Cursor Max Mode](#cursor-max-mode). The hint names the smaller variant that works without it
  (for `grok-4.7@500k`: `@256k`).
- **Max Mode turn fails before the request**, or the guard says the SDK is unpatched / was patched
  after this process started: patch the copy the error names, then restart omp — see
  [Cursor Max Mode](#cursor-max-mode).
- **Intermittent `unauthenticated` errors** with a valid key have been seen from Cursor's backend
  for some requests; retrying, or another lane (`@fast`/`@slow`), has worked.
- **Refused by account policy**: some models need an acknowledgement on the Cursor side first. Claude
  Fable selections failed with "You must acknowledge Claude Fable 5's data retention policy to use the model."
- **Stale or missing models**: the catalog is cached for 24 h; run `/cursor-refresh-models`.
- **Shell call failed to spawn**: Cursor could not start its shell, for example because the call's working
  directory does not exist or is a file (Bun reports it as `ENOENT … posix_spawn '<spawned binary>'` or
  `ENOTDIR …`). The model receives `Command failed to spawn: …` and omp stays up.
- **`Cursor's ripgrep failed to start` in the omp log**: Cursor's ripgrep binary could not be started, most often
  because `CURSOR_RIPGREP_PATH` names a file that does not exist (`ENOENT … posix_spawn '<path>'`) or is not
  executable (`EACCES`). Cursor runs ripgrep for its Grep and Glob tools and for walks it starts itself, for
  example at startup in any git checkout and in any workspace with a `.cursor/rules` directory in it or an
  ancestor (ignore files, rules, skills and nested AGENTS.md) and behind its `ls` tool. omp stays up, the SDK
  skips a failed startup walk, and Grep and Glob return the error to the model. The log's `hint` says what to
  fix. Three errors say the binary is not the problem: `EAGAIN`, `EMFILE` or `ENFILE` mean a process or
  open-file limit, `ENOENT` for a file that exists means the working directory Cursor spawned it in may be
  gone, or the file is a script whose `#!` interpreter is missing, and `EACCES` for an executable regular file
  means the working directory may not be accessible, or the script's interpreter may not be executable. For any
  other error, if the hint says `CURSOR_RIPGREP_PATH` overrides the ripgrep (the variable names a file other
  than the SDK's bundled `bin/rg`), fix the path, or unset the variable so the plugin uses the SDK's bundled
  ripgrep, then restart omp. Otherwise the file is the SDK's bundled ripgrep (the plugin writes its path into
  the variable when you have not set one) or one found on `PATH`: make sure it exists and is executable, or
  reinstall `@cursor/sdk`, then restart omp.
- **Debugging a turn**: run with `PI_CURSOR_SDK_EVENT_DEBUG=1`; `.debug/cursor-sdk-events/**/metadata.json` holds the exact
  model selection sent, `wait-result.json` the SDK result. They can contain prompts and tool output; delete them afterwards.

## Development

```bash
npm install
npm test                                                # bun test over the port-relevant suites
npm run typecheck:src
omp -e ./src/index.ts --model cursor-sdk/composer-2.5   # run from a checkout without linking
npm run patch:cursor-sdk                                # patch this checkout's @cursor/sdk; required for Max Mode
npm run check:cursor-sdk-patch                          # fail if that copy is missing or drifted
npm run refresh:cursor-snapshots                        # dry run; add --write to update snapshots
```

An installed `omp-cursor-sdk` loads alongside `omp -e <repo>`, and either copy can serve a turn; add
`--no-extensions -e <repo>` to exercise the checkout in isolation.

### Releasing

1. Fold the user-visible changes into `CHANGELOG.md`, set the same `version` in `package.json`, commit,
   tag `v<version>`, and push the tag.
2. Publish a GitHub Release for the tag. `.github/workflows/release.yml` then publishes that version to
   npm with OIDC (no token secret, provenance automatic) unless the registry already has it;
   `workflow_dispatch` re-fires a failed publish. The workflow installs dependencies first, because npm
   bundles the declared `bundledDependencies` (`@hono/node-server`, `@modelcontextprotocol/sdk` — the
   tool bridge) out of `node_modules` and packs none of them when it is absent.

The first version, `0.4.0`, was published by hand — that is what created the package and made the
trusted publisher configurable on npmjs.com. Later versions go through CI only; the
already-published check keeps a hand-made release idempotent if both paths are ever used.

## Credits and license

Port of [fitchmultz/pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk) by Mitch Fultz, adapted
for omp. MIT licensed; see [LICENSE](LICENSE).
