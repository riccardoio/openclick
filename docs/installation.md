# Installation

OpenClick installs as a CLI plus a signed macOS helper app named `OpenclickHelper`.
The helper is installed at `/Applications/OpenclickHelper.app` when possible, with
`~/Applications/OpenclickHelper.app` as the fallback.

## Requirements

- macOS 13 Ventura or later
- Bun for source installs
- Anthropic or OpenAI API key
- Accessibility and Screen Recording permissions for `OpenclickHelper`

## npm Install

```sh
npm install -g openclick
openclick setup
```

`openclick setup` configures your model provider and opens the
OpenclickHelper permission window. Existing users migrating from CuaDriver will
be asked to grant macOS permissions again because permissions do not carry over
between bundle IDs.

Run a live task:

```sh
openclick run "open Calculator and calculate 17 times 23" --live
```

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
| `--skip-doctor` | Skip helper and macOS permission setup. Useful in CI. |

## Health Checks

```sh
openclick doctor --fix
openclick doctor --json
```

`openclick doctor` checks Bun, macOS version, OpenclickHelper install path,
helper signing, daemon status, permissions, and the configured API key.

## Uninstall

```sh
openclick uninstall
```

This trashes OpenclickHelper, resets its Accessibility and Screen Recording
entries, removes `~/.openclick/`, and prints the npm command for removing the CLI.

Use `--keep-config` to preserve `~/.openclick/`, and `--yes` or `-y` for scripts.

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

For helper development, set `OPENCLICK_HELPER_BIN` to a local
`OpenclickHelper.app/Contents/MacOS/OpenclickHelper` path. Doctor suppresses
signing warnings when this override is present.
