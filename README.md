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

From a local checkout (`link` symlinks it, so edits apply on the next omp start), or from GitHub:

```bash
git clone https://github.com/LoneExile/omp-cursor-sdk && cd omp-cursor-sdk
npm install
omp plugin link "$PWD"

omp plugin install github:LoneExile/omp-cursor-sdk    # alternative: install from GitHub
```

Manage it (restart omp after any change):

```bash
omp plugin list                                              # shows omp-cursor-sdk@<version>
omp plugin install github:LoneExile/omp-cursor-sdk --force   # update a GitHub install
omp plugin disable omp-cursor-sdk                            # keep installed, stop loading
omp plugin enable omp-cursor-sdk
omp plugin uninstall omp-cursor-sdk                          # also removes a link, not your checkout
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
(used from the next session). Cursor Max-mode windows are not available through the SDK, so most
`@1m` variants measure 200k–300k (GPT `@1m` runs at 272k, Claude `@1m` at 300k or less), and
`grok-4.7@500k` is refused by Cursor (see Troubleshooting).

## Commands and flags

| Command | Purpose |
|---|---|
| `/cursor-refresh-models` | Fetch the live catalog now and re-register models |
| `/cursor-fast` | Toggle fast mode for the selected model |
| `/cursor-mode agent\|plan` | Cursor conversation mode |
| `/cursor-runtime local\|cloud [--save-user\|--save-project]` | Local or Cursor Cloud runtime |
| `/cursor-cloud list \| archive <id> \| delete <id> --yes` | Manage recorded Cloud agents |
| `/cursor-http [on\|off\|toggle]` | HTTP/1.1/SSE transport compatibility |
| `/cursor-refresh-config` | Reload Cursor config into the current pooled agent |
| `/cursor-local-resume-cleanup [--dry-run\|--yes]` | Delete superseded local SDK agents |
| `/cursor-tools` | Tool-surface report (debug) |

Flags: `--cursor-fast`, `--cursor-no-fast`, `--cursor-mode <agent|plan>`, `--cursor-runtime <local|cloud>`, `--cursor-cloud-*`.

## Environment and files

Full lists: [docs/omp-integration.md](docs/omp-integration.md), [docs/cursor-model-ux-spec.md](docs/cursor-model-ux-spec.md).

| Name | Meaning |
|---|---|
| `CURSOR_API_KEY` | Cursor API key (required) |
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
- **`AI Model Not Found Invalid parameters for registry model`**: Cursor refused the selected
  parameters. For a larger context variant the plugin adds a hint: it can need Cursor Max mode,
  which the SDK cannot request. Use the model's smaller `@<context>` variant.
- **Intermittent `unauthenticated` errors** with a valid key have been seen from Cursor's backend
  for some requests; retrying, or another lane (`@fast`/`@slow`), has worked.
- **Refused by account policy**: some models need an acknowledgement on the Cursor side first. Claude
  Fable selections failed with "You must acknowledge Claude Fable 5's data retention policy to use the model."
- **Stale or missing models**: the catalog is cached for 24 h; run `/cursor-refresh-models`.
- **Debugging a turn**: run with `PI_CURSOR_SDK_EVENT_DEBUG=1`; `.debug/cursor-sdk-events/**/metadata.json` holds the exact
  model selection sent, `wait-result.json` the SDK result. They can contain prompts and tool output; delete them afterwards.

## Development

```bash
npm install
npm test                 # bun test over the port-relevant suites
npm run typecheck:src
omp -e ./src/index.ts --model cursor-sdk/composer-2.5   # run from a checkout without linking
npm run refresh:cursor-snapshots                          # dry run; add --write to update snapshots
```

## Credits and license

Port of [fitchmultz/pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk) by Mitch Fultz, adapted
for omp. MIT licensed; see [LICENSE](LICENSE).
