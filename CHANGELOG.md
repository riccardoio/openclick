# Changelog

All notable changes to open42 are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to a 4-digit versioning scheme: `MAJOR.MINOR.PATCH.MICRO`.

## Unreleased

### Added
- Provider abstraction for Anthropic/OpenAI model calls without changing the AX/cua-driver action loop.
- OpenAI Responses API provider support for planner, verifier, result, and compile model calls.
- Mac app Settings window for choosing Anthropic/OpenAI and changing the saved API key without revealing it.
- `open42 settings provider ...`, `open42 settings model ...`, `open42 settings api-key ...`, and `open42 settings openai-api-key ...` for CLI-only provider management.
- `open42 server` local HTTP API, `open42 mcp` stdio MCP server, and `open42 daemon install|uninstall|status` for a launchd-backed always-on API server.

## [0.1.0.0] - 2026-04-25

Inaugural public release. open42 records a macOS task once and replays it via cua-driver. The runtime planner reads SKILL.md intent + a live screenshot + the AX tree, then emits a sequence of cua-driver tool calls executed locally.

### Added
- `open42 record <name>` — capture a macOS demonstration (CGEventTap + ScreenCaptureKit + AX snapshots) into a trajectory directory.
- `open42 compile <name>` — call Opus over the trajectory + sampled screenshots, emit a hybrid SKILL.md (cua + agentskills compatible) with structured `target.bundle_id`, `target.app_name`, and an `intent` block (goal, success_signals, subgoals, observed_input_modes).
- `open42 run <name> [--live] [--fast] [--cursor]` — replay. Default `--fast` plans once with Sonnet 4.6 against intent + screenshot + AX, then executes locally. Replans on failure with executed-step history + live AX tree.
- `open42 doctor [--fix]` — preflight checks for cua-driver path, daemon, Accessibility, Screen Recording, ANTHROPIC_API_KEY. `--fix` auto-starts the daemon.
- Pre-discovery: launch_app + get_window_state populate the executor with pid, window_id, AX index BEFORE the planner runs, so `pid: $pid` / `window_id: $window_id` placeholders resolve at runtime.
- Defensive `pid: 0` / `window_id: 0` substitution in the executor when the model hallucinates placeholder integers.
- Multimodal planner: Sonnet sees a base64 screenshot + AX tree at plan time.
- AX selectors via `__selector: { title, ax_id, role, ordinal }` resolved against a fresh AX snapshot before each click. Element-index banned (stale by next call).
- Tristate stopWhen verifier (yes / no / unknown). Sparse evidence returns `unknown` and is treated as success-with-warning rather than a hard fail. Threads intent.goal + intent.success_signals + executed step purposes into the verifier prompt; screenshot is primary, AX is supplementary.
- `assert` step (now no-op): legacy plans don't crash; they're silently consumed.

### Changed
- Compile prompt no longer asks for a `## Anchors` section. Coordinates, pixel-position prose, region descriptions, element_index hints are all explicitly banned. Schema validator rejects coord-leak patterns in the body.
- Planner system prompt stripped to first principles (~50 lines). Drops `assert` from the tool grammar; demands strict JSON output (first char `{`, last char `}`); `stripFences` extracts the JSON object even when the model leaks prose preamble.
- Replan plumbing: planner now receives executed-step history + live AX tree at the failure point, and is told to switch primitive (not just retry the broken one with different args).

### Fixed
- Daemon-not-running cache loss: `--fast` auto-starts the cua-driver daemon via `ensureDaemonRunning()`.
- SIGINT no longer calls `process.exit` mid-loop (was silently killing the run); aborts via flag instead.
- All child spawns use `stdin: "ignore"` so they don't inherit and consume the parent TTY.
- Screen Recording permission parser handles cua-driver's title-case output.
- PNG vs JPEG media-type detection via magic-byte sniffing.

### Distribution
- Notarized DMG path + source-build path documented in README. Source builds and DMG installs have different cdhashes — re-grant Accessibility/Screen Recording on rebuild.
