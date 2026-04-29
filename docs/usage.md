# CLI Usage

Dry-run a task. This asks the planner what it would do, but does not execute UI actions:

```sh
openclick run "open Calculator and calculate 17 times 23"
```

Run the task live:

```sh
openclick run "open Calculator and calculate 17 times 23" --live
```

Show the agent cursor while it acts:

```sh
openclick run "open Safari and search Google for OpenAI" --live --cursor
```

Add explicit success criteria for stricter verification and retry feedback:

```sh
openclick run "open Figma and draw an analog clock" \
  --live \
  --criteria "the clock must be clean, show 10:10, have a circular outline, two hands, and 12 visible hour marks"
```

Use explicit budgets:

```sh
openclick run "open Figma and draw a simple clock" \
  --live \
  --max-steps 120 \
  --max-batches 12 \
  --max-model-calls 24 \
  --max-screenshots 16
```

Useful cost/latency knobs:

```sh
OPENCLICK_VERIFIER_MODEL=claude-sonnet-4-6 \
OPENCLICK_SCREENSHOT_MAX_EDGE=1024 \
OPENCLICK_STEP_TIMEOUT_MS=20000 \
openclick run "open Figma and draw a clean clock" --live --criteria "the clock shows 10:10 and has 12 hour marks"
```

Disable memory reads or writes for a run:

```sh
openclick run "open Figma and draw a clock" --live --no-memory
openclick run "open Figma and draw a clock" --live --no-learn
```

Allow foreground/global control only when you are ready for OpenClick to potentially interrupt the human seat:

```sh
openclick run "do a task that cannot be completed in background mode" --live --allow-foreground
```

Cancel a running task from another terminal:

```sh
openclick cancel <run-id>
```

Each run prints its run id near startup. The native Mac app also exposes a stop button while a task is running.

## Command Reference

```sh
openclick setup [--provider <anthropic|openai>] [--api-key <key>] [--model <model>] [--yes] [--skip-doctor]
openclick doctor [--fix] [--json]
openclick run <task> [--live] [--cursor] [--confirm] [--criteria <text>] [--max-steps <n>] [--max-batches <n>] [--max-model-calls <n>] [--max-screenshots <n>] [--no-memory] [--no-learn] [--allow-foreground] [--agent]
openclick cancel <run-id>
openclick takeover finish --run-id <id> --issue <text> --summary <text> [--outcome success|failed|cancelled]

openclick settings provider status|set <anthropic|openai>
openclick settings model status|set <planner|verifier|result|compile> <model>
openclick settings api-key status|set|clear
openclick settings anthropic-api-key status|set|clear
openclick settings openai-api-key status|set|clear

openclick server [--host 127.0.0.1] [--port 4242] [--token <token>]
openclick mcp
openclick daemon install [--host 127.0.0.1] [--port 4242] [--token <token>]
openclick daemon status
openclick daemon uninstall

openclick memory list
openclick memory export <file>
openclick memory import <file>
openclick memory learn-takeover --bundle-id <id> --issue <text> --summary <text> [--app-name <name>] [--task <task>]

openclick record <task-name>
openclick compile <skill-name>
```
