# Installation

OpenClick has two install surfaces:

- CLI-only: install the `openclick` npm package and use the `openclick` command.
- Mac app: install/build the native macOS app. The app bundles the CLI and exposes the same command locally.

## Requirements

- macOS 14+
- Bun
- Anthropic or OpenAI API key
- macOS Accessibility and Screen Recording permissions

The npm package includes the signed `cua-driver` helper for macOS arm64. `cua-driver` is the small local helper that performs desktop actions for OpenClick. Source builds can also use a manually installed `cua-driver` through `OPENCLICK_CUA_DRIVER_BIN`, `CUA_DRIVER`, or `PATH`.

## npm Install

```sh
npm install -g openclick
openclick setup
```

Run a live task:

```sh
openclick run "open Calculator and calculate 17 times 23" --live
```

`openclick setup` is the recommended first-run path. It guides terminal users through provider selection, model defaults/custom model selection, API-key storage, and macOS permission checks.

For scripted setup:

```sh
openclick setup \
  --provider openai \
  --api-key sk-... \
  --model gpt-4.1 \
  --yes
```

Useful setup flags:

| Flag | Purpose |
| --- | --- |
| `--provider anthropic|openai` | Select model provider without prompting. |
| `--api-key <key>` | Save the provider API key without prompting. |
| `--model <model>` | Use one model for planner, verifier, and result roles. |
| `--yes` | Accept defaults where possible. |
| `--skip-doctor` | Skip macOS/helper checks. Useful in CI. |

`openclick doctor` only checks dependencies and permissions. If `cua-driver` is installed but its helper is down, OpenClick tries to start it automatically.

```sh
openclick doctor --fix
openclick doctor --json
```

## Source Install

Install dependencies:

```sh
bun install
```

Run the CLI directly from the repo:

```sh
bun ./bin/openclick --help
bun ./bin/openclick doctor
bun ./bin/openclick run "open Safari and search Google for OpenAI" --live
```

Optionally link the CLI for local development:

```sh
bun link
openclick doctor
openclick run "open Calculator and calculate 18 times 24" --live
```
