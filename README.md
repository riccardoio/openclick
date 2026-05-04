# OpenClick

<video src="https://github.com/riccardoio/openclick/releases/download/v0.2.0/demo.mp4" controls width="720"></video>

> Demo: OpenClick completing a desktop task from a natural-language prompt. ([watch](https://github.com/riccardoio/openclick/releases/download/v0.2.0/demo.mp4))

OpenClick is a macOS automation system for completing desktop tasks from natural-language prompts.

OpenClick uses a signed local macOS helper named `OpenclickHelper` for desktop actions.

Website: [openclick.sh](https://openclick.sh)

The `openclick` CLI is the core package. The native macOS app is an optional wrapper around the same CLI: CLI-only users can install and run `openclick` without installing the Mac app, while Mac app installs bundle the CLI and expose the same command locally.

OpenClick uses hosted planner models, local helper primitives, screenshots, AX trees, verification, critique/replanning, and incremental local memories to keep working through multi-step desktop tasks.

## Status

OpenClick is early and experimental. It can handle simple app workflows, browser tasks, Calculator tasks, and some visual/canvas workflows. Reliability depends on app accessibility quality, screenshot evidence, model judgment, and OpenclickHelper behavior.

This release should be treated as an early `0.1.x` beta. The current basics are expected to work best for Chrome/Safari navigation, Gmail navigation, Finder folder opening, Calculator, TextEdit-style text entry, selection, copy/paste, and common app search/edit shortcuts. Complex multi-window work, canvas-heavy apps such as Figma, unusual native dialogs, and long workflows can still fail or require user takeover.

The active path is prompt-first execution:

```sh
openclick run "open Calculator and calculate 17 times 23" --live
```

The older `record`/`compile` workflow still exists for compatibility and tests, but it is not the main product path.

## Quick Start

```sh
npm install -g openclick
openclick setup
openclick run "open Calculator and calculate 17 times 23" --live
```

Requirements:

- macOS 13+
- Anthropic or OpenAI API key
- macOS Accessibility and Screen Recording permissions for OpenclickHelper

On first run after upgrading from CuaDriver, OpenclickHelper will guide you through re-granting macOS permissions. Old CuaDriver entries can be removed in System Settings.

The npm package installs the signed `OpenclickHelper.app` for macOS. OpenclickHelper is the small local helper that performs desktop actions for OpenClick. See [Installation](docs/installation.md) for source setup and local development install options.

## Core Concepts

| Concept | Summary | Details |
| --- | --- | --- |
| Installation | Install from npm, run from source, and complete first-run setup with `openclick setup`. | [docs/installation.md](docs/installation.md) |
| macOS permissions | Accessibility and Screen Recording are required because OpenClick acts on the local desktop. | [docs/permissions.md](docs/permissions.md) |
| Model providers | Configure Anthropic or OpenAI keys and role-specific models. | [docs/model-providers.md](docs/model-providers.md) |
| CLI usage | Run, verify, budget, cancel, and tune desktop tasks from the command line. | [docs/usage.md](docs/usage.md) |
| Mac app | Native menu bar app, onboarding, settings, task activity, and takeover UI. | [docs/mac-app.md](docs/mac-app.md) |
| Execution and learning | Planner/executor loop, shared-seat mode, user takeover, traces, and local learning. | [docs/execution-and-learning.md](docs/execution-and-learning.md) |
| HTTP API | Local API server, async runs, SSE events, and `StandardTaskOutput`. | [docs/api.md](docs/api.md) |
| MCP and daemon | MCP stdio server and launchd API daemon setup. | [docs/mcp-and-daemon.md](docs/mcp-and-daemon.md) |
| App memory | Local memory files, import/export, candidate facts, and advisory negative memories. | [docs/memory.md](docs/memory.md) |
| Architecture | Main TypeScript and Swift modules. | [docs/architecture.md](docs/architecture.md) |
| Development | Test commands, smoke tests, and contributor notes. | [docs/development.md](docs/development.md) |

## Common Commands

```sh
openclick doctor [--fix] [--json]
openclick setup [--provider <anthropic|openai>] [--api-key <key>] [--model <model>]
openclick run <task> [--live] [--criteria <text>] [--max-steps <n>] [--max-batches <n>]
openclick cancel <run-id>
openclick uninstall [--keep-config] [--yes]

openclick settings provider set <anthropic|openai>
openclick settings anthropic-api-key set <key>
openclick settings openai-api-key set <key>

openclick server --host 127.0.0.1 --port 4242
openclick daemon install --host 127.0.0.1 --port 4242
openclick mcp
```

## API Integration

Use the async API for host integrations such as OpenClaw:

```sh
openclick server --host 127.0.0.1 --port 4242
```

```sh
curl -X POST http://127.0.0.1:4242/v1/runs \
  -H "Content-Type: application/json" \
  -d '{"task":"read the latest unread email and return the content","live":true}'
```

OpenClick returns a stable `StandardTaskOutput` envelope for both blocking and async runs. Host apps should display `result.body` as the user-facing answer/confirmation and keep `stdout`/`stderr` behind logs/details UI. See [HTTP API](docs/api.md).

## Safety Defaults

OpenClick defaults to shared-seat background mode:

- it should not steal focus;
- it should not rely on the human's real cursor;
- it should stay pinned to task-level windows when possible;
- foreground/global primitives are blocked unless `--allow-foreground` is set.

When automation is blocked, OpenClick should ask for user takeover only after reasonable recovery options have been exhausted. See [Execution And Learning](docs/execution-and-learning.md).

## Privacy And Logs

OpenClick does not send logs, traces, local memories, API keys, or debug files to OpenClick servers. We do not run a hosted backend for your runs.

Runtime logs and traces are stored locally on your Mac, primarily under `~/.openclick/`. They may include task text, window titles, app names, URLs, file/document names, AX tree snippets, screenshots, model responses, and execution details. Treat them as local debug data and avoid sharing them publicly if they contain private information.

During a run, OpenClick sends the task prompt and the minimum context needed for planning or verification, which may include screenshots or AX text, to the model provider you configured, such as Anthropic or OpenAI. Those requests go directly from your machine to that provider, not to OpenClick servers.
