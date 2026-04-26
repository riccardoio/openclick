# showme

`showme` is a macOS automation CLI that completes desktop tasks from natural-language prompts.

It uses a planner model to decide a small batch of actions, executes them locally through [`cua-driver`](https://github.com/trycua/cua), takes fresh screenshots/AX snapshots, verifies progress, and replans when needed. The current direction is prompt-first execution: you describe the task directly, and `showme` drives the UI.

## Status

`showme` is early and experimental. It can already handle simple app workflows, browser searches, Calculator tasks, and some canvas interactions. Complex visual creation is improving through local primitives such as drag, but still depends heavily on app accessibility, screenshot quality, and model judgment.

The older record/compile flow still exists for compatibility, but the active path is:

```sh
showme run "open Calculator and calculate 17 times 23" --live
```

## How It Works

`showme run` follows a tight loop:

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
- Anthropic API key
- macOS Accessibility and Screen Recording permissions

Run:

```sh
showme doctor
```

If the `cua-driver` daemon is not running, try:

```sh
showme doctor --fix
```

## Install For Development

```sh
bun install
```

Run from the repo:

```sh
bun ./bin/showme doctor
bun ./bin/showme run "open Safari and search Google for OpenAI" --live
```

If installed globally or linked as a package, use:

```sh
showme doctor
showme run "open Calculator and calculate 18 times 24" --live
```

## Usage

Dry-run a task. This asks the planner what it would do but does not execute UI actions:

```sh
showme run "open Calculator and calculate 17 times 23"
```

Run the task live:

```sh
showme run "open Calculator and calculate 17 times 23" --live
```

Launch the native macOS menu-bar chat bar. It lives in the status area next to the clock and can open a floating prompt bar with Option+Space:

```sh
showme bar
```

Show the agent cursor while it acts:

```sh
showme run "open Safari and search Google for OpenAI" --live --cursor
```

Add explicit success criteria. This makes verification stricter and gives the planner direct feedback for up to two refinement rounds:

```sh
showme run "open Figma and draw an analog clock" \
  --live \
  --criteria "the clock must be clean, show 10:10, have a circular outline, two hands, and 12 visible hour marks"
```

Use explicit budgets:

```sh
showme run "open Figma and draw a simple clock" \
  --live \
  --max-steps 120 \
  --max-batches 12 \
  --max-model-calls 24 \
  --max-screenshots 16
```

Useful cost/latency knobs:

```sh
SHOWME_VERIFIER_MODEL=claude-sonnet-4-6 \
SHOWME_SCREENSHOT_MAX_EDGE=1024 \
SHOWME_STEP_TIMEOUT_MS=20000 \
showme run "open Figma and draw a clean clock" --live --criteria "the clock shows 10:10 and has 12 hour marks"
```

Screenshots are optimized before model calls with `sips -Z`, which downsizes the longer edge without upscaling. Drawing plans receive the optimized screenshot dimensions so drag coordinates can be scaled back to the real window.

Disable memory reads or writes for a run:

```sh
showme run "open Figma and draw a clock" --live --no-memory
showme run "open Figma and draw a clock" --live --no-learn
```

Allow foreground/global control only when you are ready for `showme` to potentially interrupt the human seat:

```sh
showme run "do a task that cannot be completed in background mode" --live --allow-foreground
```

In default shared-seat mode, `showme` also watches for external seat activity such as cursor movement or a frontmost-app change. It continues running in the background, but disables learning for that run so polluted evidence does not become a bad memory.

Cancel a running task from another terminal:

```sh
showme cancel <run-id>
```

Each run prints its run id near startup. The native menu-bar app also exposes a stop button while a task is running.

## Debug Traces

`showme` writes lightweight run traces under `~/.showme/runs/<run-id>/trace.json`. A trace includes the prompt, criteria, plan steps, verifier replies, critique feedback, cost counters, and final status. It is a flight recorder for debugging live runs, not a recording-to-skill artifact.

Only one live run controls the desktop at a time. `showme` writes a run lock under `~/.showme/run.lock` and refuses a second live run while the first process is still alive.

## Commands

```sh
showme doctor [--fix]
showme bar [--detach]
showme run <task> [--live] [--cursor] [--confirm] [--criteria <text>] [--no-memory] [--no-learn] [--allow-foreground]
showme cancel <run-id>
showme memory list
showme memory export <file>
showme memory import <file>
showme record <task-name>
showme compile <skill-name>
```

`record` and `compile` are legacy commands from the original demonstration-to-`SKILL.md` workflow. They remain useful for fixtures and compatibility, but prompt-first `run` is the main path.

## App Memory

`showme` keeps optional local app memories under `~/.showme/apps/<bundle-id>/memory.json`. These are not replay scripts. They are structured affordances, avoid-rules, and observations such as “prefer the largest content window” or “this shortcut opened a new document”.

Each memory fact has a status, source, confidence, evidence count, scope, and cause. Only `active` facts are added to planner prompts. New negative facts and execution-critiques start as `candidate` memories, and one-off failures are not used as future guidance until repeated local evidence promotes them. Imported facts also start as candidates with reduced confidence, so shared memory can help discovery without silently overriding local behavior.

Share memories with another machine or project:

```sh
showme memory export showme-memory.json
showme memory import showme-memory.json
```

Negative memories are always soft cautions, not hard blocks. They should steer the planner away from likely failure modes, but they must not disable tools, shortcuts, windows, or future attempts. During `showme run`, relevant active memories for candidate apps are added to the planner prompt so repeated use can reduce rediscovery, improve reliability, and lower model spend.

Escape hatches:

```sh
showme run "open Figma and draw a clock" --live --no-memory
showme run "open Figma and draw a clock" --live --no-learn
```

## Architecture

- `src/cli.ts` parses commands and runtime budgets.
- `src/bar.ts` launches the native macOS menu-bar chat bar.
- `src/run.ts` owns the prompt-first execution loop, screenshots, modal state, visual-delta checks, verification, critique/replanning, run locking, traces, and cost telemetry.
- `src/planner.ts` builds planner prompts, validates model plans, and normalizes common planner mistakes.
- `src/executor.ts` executes local plans through `cua-driver`, resolves AX selectors, repairs context, and provides local virtual tools such as `drag`, modifier-held drags, `multi_drag`, and `click_hold`.
- `src/memory.ts` stores, imports, exports, promotes, and retrieves local app memory facts.
- `src/trace.ts` stores run traces, cancellation markers, and the single-run desktop lock.
- `src/doctor.ts` checks local dependencies and macOS permissions.
- `recorder/Sources/ShowmeBar/` contains the AppKit status-item chat bar.
- `recorder/` contains the Swift recorder used by the legacy recording workflow.
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
bun ./bin/showme run "open Calculator and calculate 22 times 27; stop when the display shows 594" --live
bun ./bin/showme run "open Safari and search Google for OpenAI; stop when Google search results are visible" --live
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
