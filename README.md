# Open42

Open42 is a macOS automation system for completing desktop tasks from natural-language prompts.

The `open42` CLI is the core package. The native macOS app is an optional wrapper around the same CLI: CLI-only users can install and run `open42` without installing the Mac app, while Mac app installs bundle the CLI and expose the same command locally.

Open42 uses a planner model, local `cua-driver` primitives, screenshots, AX trees, verification, critique/replanning, and incremental local memories to keep working through multi-step desktop tasks.

## Status

Open42 is early and experimental. It can handle simple app workflows, browser tasks, Calculator tasks, and some visual/canvas workflows. Reliability depends on app accessibility quality, screenshot evidence, model judgment, and `cua-driver` behavior.

The active path is prompt-first execution:

```sh
open42 run "open Calculator and calculate 17 times 23" --live
```

The older `record`/`compile` workflow still exists for compatibility and tests, but it is not the main product path.

## Requirements

- macOS 14+
- [Bun](https://bun.sh)
- `cua-driver`
- Anthropic or OpenAI API key
- macOS Accessibility and Screen Recording permissions

Run the doctor first:

```sh
open42 doctor
```

`open42 doctor` checks dependencies and permissions. If `cua-driver` is installed but its helper is down, Open42 tries to start it automatically. `--fix` is still accepted as a compatibility alias:

```sh
open42 doctor --fix
open42 doctor --json
```

## macOS Permissions

Open42 needs a few macOS permissions because it acts on the local desktop instead of a remote browser sandbox. The onboarding screen and `open42 doctor` check these for you.

Enable these in System Settings > Privacy & Security:

| Permission | Why Open42 needs it |
| --- | --- |
| Accessibility | Lets Open42 and `cua-driver` inspect accessible UI elements, focus windows, press buttons, type, click, and use AX-backed app controls. Without it, Open42 cannot reliably act inside other apps. |
| Screen Recording | Lets Open42 capture screenshots for visual state, verification, progress checks, stuck-state detection, and takeover learning. Without it, the planner and verifier lose the evidence they need to know what happened. |

Also required:

- Model API key: Anthropic or OpenAI is required for planning, verification, result summaries, and compile flows. Keys saved through the Mac app are stored in Keychain and shown only as asterisks.
- `cua-driver` helper: executes the local desktop primitives. Open42 starts the helper automatically when possible; users should not need to start it manually.

Grant permissions to the app/process macOS shows for the way you run Open42. For the native app, this is the Open42 app. For CLI development, it may be your terminal app, Bun, or the `cua-driver` helper. After rebuilding a local app binary, macOS may require granting permissions again because the binary identity changed.

## Install From Source

Install dependencies:

```sh
bun install
```

Run the CLI directly from the repo:

```sh
bun ./bin/open42 --help
bun ./bin/open42 doctor
bun ./bin/open42 run "open Safari and search Google for OpenAI" --live
```

Optionally link the CLI for local development:

```sh
bun link
open42 doctor
open42 run "open Calculator and calculate 18 times 24" --live
```

## Model Provider Setup

Choose a provider and save its API key:

```sh
open42 settings provider set anthropic
open42 settings anthropic-api-key set sk-ant-...

open42 settings provider set openai
open42 settings openai-api-key set sk-...
```

`settings api-key` is kept as the Anthropic key shortcut:

```sh
open42 settings api-key status
open42 settings api-key set sk-ant-...
open42 settings api-key clear
```

Provider and model commands:

```sh
open42 settings provider status
open42 settings provider set anthropic
open42 settings provider set openai

open42 settings model status
open42 settings model set planner <model>
open42 settings model set verifier <model>
open42 settings model set result <model>
open42 settings model set compile <model>
```

Environment variables also work:

```sh
ANTHROPIC_API_KEY=sk-ant-... open42 run "..." --live
OPENAI_API_KEY=sk-... open42 run "..." --live
OPEN42_MODEL_PROVIDER=openai open42 run "..." --live
```

The default action loop remains optimized for hosted Anthropic/OpenAI models plus AX and `cua-driver` grounding. Local/open-model providers are planned behind the same abstraction, but should not reduce the default hosted-model accuracy.

## CLI And Mac App

Open42 has two install surfaces:

- CLI-only: install or link the JavaScript/Bun package and use the `open42` command.
- Mac app: build/install the native app from `mac-app/`; the app bundles the CLI and installs `~/.local/bin/open42` on launch.

The Mac app includes:

- menu bar chat bar
- onboarding and permission checks
- provider/API-key settings
- task activity panel
- takeover/learning UI

For local Mac app development:

```sh
bun run build:mac-app
bun run launch:mac-app
```

The CI/release Swift package commands are:

```sh
swift build --package-path mac-app -c release
swift test --package-path mac-app
```

Swift products:

- `open42-app` - native menu bar app
- `open42-recorder` - legacy recorder executable used by the old recording workflow
- `RecorderCore` - shared recorder core library

## Usage

Dry-run a task. This asks the planner what it would do, but does not execute UI actions:

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

Add explicit success criteria for stricter verification and retry feedback:

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

Disable memory reads or writes for a run:

```sh
open42 run "open Figma and draw a clock" --live --no-memory
open42 run "open Figma and draw a clock" --live --no-learn
```

Allow foreground/global control only when you are ready for Open42 to potentially interrupt the human seat:

```sh
open42 run "do a task that cannot be completed in background mode" --live --allow-foreground
```

Cancel a running task from another terminal:

```sh
open42 cancel <run-id>
```

Each run prints its run id near startup. The native Mac app also exposes a stop button while a task is running.

## How Execution Works

`open42 run` follows a bounded loop:

1. Discover relevant apps, current usable windows, and active local app memories.
2. Capture AX state, modal/window state, and an optimized screenshot.
3. Ask the planner for a small, safe action batch with visible postconditions for risky actions.
4. Execute locally through `cua-driver`.
5. Revalidate task-level window leases before window-targeted actions.
6. Run cheap local visual-delta checks before spending verifier calls.
7. Verify the result from screenshot and AX evidence.
8. Replan with verifier feedback or execution critique when the task is not done.
9. Ask for user takeover only when automation is blocked and reasonable recovery options have been exhausted.
10. Save scoped local memories from useful successes, repeated failures, and successful takeovers.

The default runtime is shared-seat background mode: it should not steal focus, require the target app to be frontmost, or rely on the real mouse cursor. It uses pid/window-targeted `cua-driver` primitives wherever possible. Foreground/global primitives are blocked unless `--allow-foreground` is set.

If external seat activity is detected during a shared-seat run, Open42 keeps running but disables learning for that run so polluted evidence does not become a bad memory.

## User Takeover And Learning

When Open42 cannot safely continue, it can pause for manual takeover. The Mac app handles this through the task activity panel. The CLI marker command is:

```sh
open42 takeover finish \
  --run-id <run-id> \
  --issue "Confirmation click required" \
  --summary "The user opened the email manually" \
  --outcome success
```

Optional takeover fields:

```sh
--bundle-id <bundle-id>
--app-name <name>
--task <task>
--reason-type <reason>
--feedback <text>
--trajectory-path <file>
```

Directly save a takeover learning:

```sh
open42 memory learn-takeover \
  --bundle-id com.google.Chrome \
  --app-name "Google Chrome" \
  --issue "Wrong Chrome window selected" \
  --summary "Keep actions pinned to the task window id unless it disappears"
```

## Local API Server

Start a local HTTP API server:

```sh
open42 server --host 127.0.0.1 --port 4242
```

Use a token when exposing the server beyond localhost:

```sh
open42 server --host 127.0.0.1 --port 4242 --token <token>
```

Send the token as either:

```sh
Authorization: Bearer <token>
X-Open42-Token: <token>
```

HTTP API endpoints:

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/health` | none | `{ "ok": true, "name": "open42", "version": "..." }` |
| `GET` | `/v1/status` | none | Runs `open42 doctor` and returns `{ "ok": boolean, "report": ... }` |
| `GET` | `/v1/settings/api-key` | none | Returns selected provider, availability, source, and masked key. The raw key is never returned. |
| `POST` | `/v1/settings/api-key` | `{ "apiKey": "..." }`, `{ "api_key": "..." }`, or `{ "apiKey": "...", "provider": "openai" }` | Saves/replaces the provider key and returns masked key status. |
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

## MCP Server

For MCP clients that launch a stdio server:

```sh
open42 mcp
```

MCP tools:

| Tool | Arguments | Result |
| --- | --- | --- |
| `run_task` | `{ "task": string, "live"?: boolean, "allowForeground"?: boolean, "criteria"?: string }` | Runs a natural-language macOS desktop task through Open42 and returns CLI text output. `live` defaults to `true`. |
| `status` | none | Runs `open42 doctor --json` and returns the JSON status text. |

## API Daemon

Install the local API server as a user launchd daemon so it starts at login and stays running:

```sh
open42 daemon install --host 127.0.0.1 --port 4242
open42 daemon status
open42 daemon uninstall
```

With token auth:

```sh
open42 daemon install --host 127.0.0.1 --port 4242 --token <token>
```

The daemon label is `dev.open42.server`. Logs are written under `~/.open42/server.log` and `~/.open42/server.err.log`.

## Debug Traces

Open42 writes lightweight run traces under:

```sh
~/.open42/runs/<run-id>/trace.json
```

A trace includes the prompt, criteria, plan steps, verifier replies, critique feedback, cost counters, interventions, and final status.

Only one live run controls the desktop at a time. Open42 writes a run lock under `~/.open42/run.lock` and refuses a second live run while the first process is still alive.

## Commands

```sh
open42 doctor [--fix] [--json]
open42 run <task> [--live] [--cursor] [--confirm] [--criteria <text>] [--max-steps <n>] [--max-batches <n>] [--max-model-calls <n>] [--max-screenshots <n>] [--no-memory] [--no-learn] [--allow-foreground] [--agent]
open42 cancel <run-id>
open42 takeover finish --run-id <id> --issue <text> --summary <text> [--outcome success|failed|cancelled]

open42 settings provider status|set <anthropic|openai>
open42 settings model status|set <planner|verifier|result|compile> <model>
open42 settings api-key status|set|clear
open42 settings anthropic-api-key status|set|clear
open42 settings openai-api-key status|set|clear

open42 server [--host 127.0.0.1] [--port 4242] [--token <token>]
open42 mcp
open42 daemon install [--host 127.0.0.1] [--port 4242] [--token <token>]
open42 daemon status
open42 daemon uninstall

open42 memory list
open42 memory export <file>
open42 memory import <file>
open42 memory learn-takeover --bundle-id <id> --issue <text> --summary <text> [--app-name <name>] [--task <task>]

open42 record <task-name>
open42 compile <skill-name>
```

## App Memory

Open42 keeps optional local app memories under:

```sh
~/.open42/apps/<bundle-id>/memory.json
```

These are not replay scripts. They are structured affordances, avoid-rules, and observations such as "prefer the largest content window" or "this shortcut opened a new document".

Each memory fact has a status, source, confidence, evidence count, scope, and cause. Only `active` facts are added to planner prompts. New negative facts and execution critiques start as `candidate` memories, and one-off failures are not used as future guidance until repeated local evidence promotes them. Imported facts also start as candidates with reduced confidence, so shared memory can help discovery without silently overriding local behavior.

Share memories with another machine or project:

```sh
open42 memory export open42-memory.json
open42 memory import open42-memory.json
```

Negative memories are soft cautions, not hard blocks. They should steer the planner away from likely failure modes, but must not disable tools, shortcuts, windows, or future attempts.

## Architecture

- `bin/open42` is the CLI entrypoint.
- `src/cli.ts` parses commands and runtime budgets.
- `src/run.ts` owns prompt-first execution, screenshots, modal state, verification, critique/replanning, run locking, traces, and cost telemetry.
- `src/planner.ts` builds planner prompts, validates model plans, and normalizes common planner mistakes.
- `src/executor.ts` executes local plans through `cua-driver`, resolves AX selectors, repairs context, and maintains task-level window leases.
- `src/settings.ts` manages provider, model, and API-key configuration.
- `src/server.ts` implements the HTTP API and MCP stdio server.
- `src/daemon.ts` installs and manages the launchd API daemon.
- `src/memory.ts` stores, imports, exports, promotes, and retrieves local app memory facts.
- `src/trace.ts` stores run traces, intervention markers, takeover resume markers, cancellation markers, and the single-run desktop lock.
- `src/doctor.ts` checks local dependencies and macOS permissions.
- `src/mac-app.ts` is a local development helper for building and launching the native Mac app bundle.
- `mac-app/Sources/Open42App/` contains the native menu bar app, onboarding, settings, chat bar, and task activity UI.
- `mac-app/Sources/Recorder/` contains the legacy Swift recorder executable.
- `mac-app/Sources/RecorderCore/` contains recorder shared code and tests.
- `tests/` contains Bun tests and fixtures.

## Development

```sh
bun run format
bun run lint
bun run typecheck
bun test
swift build --package-path mac-app -c release
swift test --package-path mac-app
```

Useful live smoke tests:

```sh
bun ./bin/open42 run "open Calculator and calculate 22 times 27; stop when the display shows 594" --live
bun ./bin/open42 run "open Safari and search Google for OpenAI; stop when Google search results are visible" --live
```

## Notes For Contributors

- Prefer generic capabilities over app-specific prompt hacks.
- Keep model budgets visible and bounded.
- Preserve shared-seat behavior by default: classify new primitives as background-safe or foreground-required before exposing them to the planner.
- Treat screenshots as primary evidence for visual apps and browser content.
- Treat AX trees as useful but often incomplete.
- Do not accept weak visual success criteria just because an app or canvas is visible.
- Give high-risk visual actions a concrete expected visible change and critique/replan when the change does not appear.
- Add new UI primitives at the executor/capability layer when possible, then teach the planner about them.
- Store memories as scoped facts with evidence, not brittle click scripts or app-specific prompt hacks.
- Treat imported and negative memories as advisory until local runs prove them useful.
