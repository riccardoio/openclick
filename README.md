# open42

Open42 is a macOS automation project for completing desktop tasks from natural-language prompts. The `open42` CLI is the core installable package; the Mac app is a separate native wrapper around the same CLI.

It uses a planner model to decide a small batch of actions, executes them locally through [`cua-driver`](https://github.com/trycua/cua), takes fresh screenshots/AX snapshots, verifies progress, and replans when needed. The current direction is prompt-first execution: you describe the task directly, and `open42` drives the UI.

## Status

`open42` is early and experimental. It can already handle simple app workflows, browser searches, Calculator tasks, and some canvas interactions. Complex visual creation is improving through local primitives such as drag, but still depends heavily on app accessibility, screenshot quality, and model judgment.

The older record/compile flow still exists for compatibility, but the active path is:

```sh
open42 run "open Calculator and calculate 17 times 23" --live
```

## How It Works

`open42 run` follows a tight loop:

1. Discover relevant apps, the current usable window, and any active local app memories.
2. Capture AX state, modal/window state, and an optimized screenshot.
3. Ask the planner for a small, safe action batch with visible postconditions for risky actions.
4. Execute the batch locally with `cua-driver`.
5. Run cheap visual-delta checks before spending a verifier call.
6. Verify the result from screenshot + AX evidence when local evidence changed.
7. Replan with verifier feedback or a focused execution critique when the task is not done.
8. Save safe memory candidates from useful successes and repeated failures.

This keeps model calls bounded while still allowing the agent to recover from blocking dialogs, stale UI, failed clicks, sparse AX trees, or partial progress.

The runtime defaults to shared-seat background mode: it should not steal focus, require the target app to be frontmost, or rely on the real mouse cursor. It uses `cua-driver` pid/window-targeted AX, keyboard, screenshot, and pixel-event primitives wherever possible. Foreground/global primitives are blocked unless you explicitly opt in.

## Requirements

- macOS
- [Bun](https://bun.sh)
- `cua-driver`
- Anthropic or OpenAI API key
- macOS Accessibility and Screen Recording permissions

Run:

```sh
open42 doctor
```

Choose a model provider and save its API key without exposing it in the app UI:

```sh
open42 settings provider set anthropic
open42 settings api-key set sk-ant-...

open42 settings provider set openai
open42 settings openai-api-key set sk-...
```

If the `cua-driver` daemon is not running, try:

```sh
open42 doctor --fix
```

## Install For Development

```sh
bun install
```

Run from the repo:

```sh
bun ./bin/open42 doctor
bun ./bin/open42 run "open Safari and search Google for OpenAI" --live
```

If installed globally or linked as a package, use:

```sh
open42 doctor
open42 run "open Calculator and calculate 18 times 24" --live
```

## Install Options

CLI-only users can install `open42` without installing the Mac app. The npm/Bun package exposes only the `open42` command and does not ship the native app bundle.

The Mac app is built separately from `mac-app/`. When installed, the app bundles the `open42` CLI and installs a user-local `~/.local/bin/open42` symlink on launch so terminal workflows use the same command as the app.

The Mac app also has a Settings window in the status-item menu for choosing Anthropic or OpenAI and changing the saved API key. Stored keys are masked in the UI and app-launched runs inject them into the CLI process.

Provider configuration:

```sh
open42 settings provider status
open42 settings provider set anthropic
open42 settings provider set openai

open42 settings model status
open42 settings model set planner gpt-4.1
open42 settings model set verifier gpt-4.1
open42 settings model set compile gpt-4.1
```

The action system remains optimized for high-accuracy hosted multimodal models plus AX/cua-driver grounding. Local/open-model providers are planned behind the same abstraction, but they should not reduce the default Anthropic/OpenAI behavior.

For local app development:

```sh
bun run build:mac-app
bun run launch:mac-app
```

## Usage

Dry-run a task. This asks the planner what it would do but does not execute UI actions:

```sh
open42 run "open Calculator and calculate 17 times 23"
```

Run the task live:

```sh
open42 run "open Calculator and calculate 17 times 23" --live
```

Show the agent cursor while it acts:

```sh
open42 run "open Safari and search Google for OpenAI" --live --cursor
```

Add explicit success criteria. This makes verification stricter and gives the planner direct feedback for up to two refinement rounds:

```sh
open42 run "open Figma and draw an analog clock" \
  --live \
  --criteria "the clock must be clean, show 10:10, have a circular outline, two hands, and 12 visible hour marks"
```

Use explicit budgets:

```sh
open42 run "open Figma and draw a simple clock" \
  --live \
  --max-steps 120 \
  --max-batches 12 \
  --max-model-calls 24 \
  --max-screenshots 16
```

Useful cost/latency knobs:

```sh
OPEN42_VERIFIER_MODEL=claude-sonnet-4-6 \
OPEN42_SCREENSHOT_MAX_EDGE=1024 \
OPEN42_STEP_TIMEOUT_MS=20000 \
open42 run "open Figma and draw a clean clock" --live --criteria "the clock shows 10:10 and has 12 hour marks"
```

Screenshots are optimized before model calls with `sips -Z`, which downsizes the longer edge without upscaling. Drawing plans receive the optimized screenshot dimensions so drag coordinates can be scaled back to the real window.

Disable memory reads or writes for a run:

```sh
open42 run "open Figma and draw a clock" --live --no-memory
open42 run "open Figma and draw a clock" --live --no-learn
```

Allow foreground/global control only when you are ready for `open42` to potentially interrupt the human seat:

```sh
open42 run "do a task that cannot be completed in background mode" --live --allow-foreground
```

In default shared-seat mode, `open42` also watches for external seat activity such as cursor movement or a frontmost-app change. It continues running in the background, but disables learning for that run so polluted evidence does not become a bad memory.

Cancel a running task from another terminal:

```sh
open42 cancel <run-id>
```

Each run prints its run id near startup. The native Mac app also exposes a stop button while a task is running.

## Local API / MCP Server

Start a local HTTP API server:

```sh
open42 server --host 127.0.0.1 --port 4242
```

HTTP API endpoints:

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/health` | none | `{ "ok": true, "name": "open42", "version": "..." }` |
| `GET` | `/v1/status` | none | Runs `open42 doctor` and returns `{ "ok": boolean, "report": ... }` |
| `GET` | `/v1/settings/api-key` | none | Returns whether a key exists for the selected provider, its source, and a masked value. The raw key is never returned. |
| `POST` | `/v1/settings/api-key` | `{ "apiKey": "sk-ant-..." }`, `{ "apiKey": "sk-...", "provider": "openai" }`, or `{ "api_key": "..." }` | Saves/replaces the key and returns masked key status. |
| `DELETE` | `/v1/settings/api-key` | none | Clears the saved key for the selected provider and returns key status. |
| `POST` | `/v1/run` | `{ "task": "...", "live": true, "allowForeground": false, "criteria": "..." }` | Runs `open42 run`; returns `{ "ok": boolean, "exitCode": number, "stdout": "...", "stderr": "..." }`. `live` defaults to `true`. |
| `POST` | `/v1/cancel` | `{ "runId": "..." }` or `{ "run_id": "..." }` | Runs `open42 cancel`; returns process output. |
| `GET` | `/v1/memory` | none | Runs `open42 memory list`; returns process output. |
| `OPTIONS` | any path | none | CORS preflight response. |

Example:

```sh
curl -X POST http://127.0.0.1:4242/v1/run \
  -H "Content-Type: application/json" \
  -d '{"task":"open Chrome and go to Gmail","live":true}'
```

For MCP clients that launch a stdio server:

```sh
open42 mcp
```

MCP tools:

| Tool | Arguments | Result |
| --- | --- | --- |
| `run_task` | `{ "task": string, "live"?: boolean, "allowForeground"?: boolean, "criteria"?: string }` | Runs a natural-language macOS desktop task through open42 and returns CLI text output. `live` defaults to `true`. |
| `status` | none | Runs `open42 doctor --json` and returns the JSON status text. |

Install the local API server as a user launchd daemon so it starts at login and stays running:

```sh
open42 daemon install --port 4242
open42 daemon status
open42 daemon uninstall
```

If you expose the server beyond localhost, set a token and send it as `Authorization: Bearer <token>` or `X-Open42-Token`.

## Debug Traces

`open42` writes lightweight run traces under `~/.open42/runs/<run-id>/trace.json`. A trace includes the prompt, criteria, plan steps, verifier replies, critique feedback, cost counters, and final status. It is a flight recorder for debugging live runs, not a recording-to-skill artifact.

Only one live run controls the desktop at a time. `open42` writes a run lock under `~/.open42/run.lock` and refuses a second live run while the first process is still alive.

## Commands

```sh
open42 doctor [--fix]
open42 run <task> [--live] [--cursor] [--confirm] [--criteria <text>] [--no-memory] [--no-learn] [--allow-foreground]
open42 cancel <run-id>
open42 settings provider status|set <anthropic|openai>
open42 settings model status|set <planner|verifier|result|compile> <model>
open42 settings api-key status|set|clear
open42 settings openai-api-key status|set|clear
open42 server [--host 127.0.0.1] [--port 4242] [--token <token>]
open42 mcp
open42 daemon install|uninstall|status
open42 memory list
open42 memory export <file>
open42 memory import <file>
open42 record <task-name>
open42 compile <skill-name>
```

`record` and `compile` are legacy commands from the original demonstration-to-`SKILL.md` workflow. They remain useful for fixtures and compatibility, but prompt-first `run` is the main path.

## App Memory

`open42` keeps optional local app memories under `~/.open42/apps/<bundle-id>/memory.json`. These are not replay scripts. They are structured affordances, avoid-rules, and observations such as “prefer the largest content window” or “this shortcut opened a new document”.

Each memory fact has a status, source, confidence, evidence count, scope, and cause. Only `active` facts are added to planner prompts. New negative facts and execution-critiques start as `candidate` memories, and one-off failures are not used as future guidance until repeated local evidence promotes them. Imported facts also start as candidates with reduced confidence, so shared memory can help discovery without silently overriding local behavior.

Share memories with another machine or project:

```sh
open42 memory export open42-memory.json
open42 memory import open42-memory.json
```

Negative memories are always soft cautions, not hard blocks. They should steer the planner away from likely failure modes, but they must not disable tools, shortcuts, windows, or future attempts. During `open42 run`, relevant active memories for candidate apps are added to the planner prompt so repeated use can reduce rediscovery, improve reliability, and lower model spend.

Escape hatches:

```sh
open42 run "open Figma and draw a clock" --live --no-memory
open42 run "open Figma and draw a clock" --live --no-learn
```

## Architecture

- `src/cli.ts` parses commands and runtime budgets.
- `src/run.ts` owns the prompt-first execution loop, screenshots, modal state, visual-delta checks, verification, critique/replanning, run locking, traces, and cost telemetry.
- `src/planner.ts` builds planner prompts, validates model plans, and normalizes common planner mistakes.
- `src/executor.ts` executes local plans through `cua-driver`, resolves AX selectors, repairs context, and provides local virtual tools such as `drag`, modifier-held drags, `multi_drag`, and `click_hold`.
- `src/memory.ts` stores, imports, exports, promotes, and retrieves local app memory facts.
- `src/trace.ts` stores run traces, cancellation markers, and the single-run desktop lock.
- `src/doctor.ts` checks local dependencies and macOS permissions.
- `src/mac-app.ts` is a local development helper for building and launching the native Mac app.
- `mac-app/Sources/Open42App/` contains the AppKit status-item chat bar.
- `mac-app/Sources/Recorder/` contains the Swift recorder used by the legacy recording workflow.
- `tests/` contains Bun tests and fixtures.

## Development

```sh
bun run format
bun run lint
bun run typecheck
bun test
```

Useful live smoke tests:

```sh
bun ./bin/open42 run "open Calculator and calculate 22 times 27; stop when the display shows 594" --live
bun ./bin/open42 run "open Safari and search Google for OpenAI; stop when Google search results are visible" --live
```

## Notes For Contributors

- Prefer generic capabilities over app-specific prompt hacks.
- Keep model budgets visible and bounded. Prefer the default prompt-first path; `--agent` is legacy, higher-cost, and does not use the prompt-first verifier loop.
- Preserve shared-seat behavior by default: classify new primitives as background-safe or foreground-required before exposing them to the planner.
- Treat screenshots as primary evidence for visual apps and browser content.
- Treat AX trees as useful but often incomplete.
- Do not accept weak visual success criteria just because an app or canvas is visible.
- Give high-risk visual actions a concrete expected visible change and critique/replan when the change does not appear.
- Add new UI primitives at the executor/capability layer when possible, then teach the planner about them.
- Store memories as scoped facts with evidence, not brittle click scripts or app-specific prompt hacks.
- Treat imported and negative memories as advisory until local runs prove them useful.
