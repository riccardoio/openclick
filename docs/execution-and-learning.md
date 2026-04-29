# Execution And Learning

`openclick run` follows a bounded loop:

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

If external seat activity is detected during a shared-seat run, OpenClick keeps running but disables learning for that run so polluted evidence does not become a bad memory.

## User Takeover

When OpenClick cannot safely continue, it can pause for manual takeover. The Mac app handles this through the task activity panel. The CLI marker command is:

```sh
openclick takeover finish \
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
openclick memory learn-takeover \
  --bundle-id com.google.Chrome \
  --app-name "Google Chrome" \
  --issue "Wrong Chrome window selected" \
  --summary "Keep actions pinned to the task window id unless it disappears"
```

## Debug Traces

OpenClick writes lightweight run traces under:

```sh
~/.openclick/runs/<run-id>/trace.json
```

A trace includes the prompt, criteria, plan steps, verifier replies, critique feedback, cost counters, interventions, and final status.

Only one live run controls the desktop at a time. OpenClick writes a run lock under `~/.openclick/run.lock` and refuses a second live run while the first process is still alive.

