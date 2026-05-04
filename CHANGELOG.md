# Changelog

All notable changes to openclick are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to a 4-digit versioning scheme: `MAJOR.MINOR.PATCH.MICRO`.

## [0.2.0.0] - 2026-05-04

### Added
- Renamed the macOS desktop helper to signed + notarized `OpenclickHelper.app` with bundle ID `com.openclick.helper`, signed by Speedrun Labs Ltd (team `LH7NH6SPDB`). Single-app architecture: a Swift dispatcher at `Contents/MacOS/OpenclickHelper` either shows the GUI or `execv`s the embedded daemon at `Contents/Resources/openclick-daemon` based on argv. macOS TCC binds a single identity for both jobs.
- Step-by-step permission setup window (Accessibility, Screen Recording, Automation, Developer Tools — last two env-gated) with live TCC polling, deep-links to the right Settings panes, retry-on-timeout, and a `Done` button that returns control to the calling CLI.
- The CLI auto-opens the permission window on first `openclick run`, polls the helper's status file, and continues after a successful grant. If the user closes the window without clicking `Done` but TCC permissions are actually granted, the CLI does a final `check_permissions` and continues anyway.
- `openclick uninstall` removes `/Applications/OpenclickHelper.app`, resets TCC entries, and deletes `~/.openclick/`. `--keep-config` preserves user data; `--yes` skips the confirmation prompt for scripted uninstalls.
- New `scripts/sign-and-notarize.sh` and `scripts/build-universal.sh` produce the signed/notarized `.app` from the maintainer's Mac (Developer ID Application + hardened runtime + apple-events entitlement, daemon signed first then bundle, JSON parsed via `plutil`).
- New `scripts/dev-install.sh` for local iteration: builds the dispatcher, embeds the daemon, signs with Developer ID (skips notarization), and installs to `/Applications/OpenclickHelper.app` so macOS Launch Services finds it for auto-relaunches after Screen Recording grants.
- New npm subpackage `@openclick/openclick-helper-darwin` (replaces `@openclick/cua-driver-darwin-arm64`); idempotent `postinstall.js` copies the `.app` to `/Applications/` (fallback `~/Applications/`).
- Provider abstraction for Anthropic/OpenAI model calls without changing the AX/helper action loop.
- OpenAI Responses API provider support for planner, verifier, result, and compile model calls.
- Mac app Settings window for choosing Anthropic/OpenAI and changing the saved API key without revealing it.
- `openclick settings provider ...`, `openclick settings model ...`, `openclick settings api-key ...`, and `openclick settings openai-api-key ...` for CLI-only provider management.
- `openclick server` local HTTP API, `openclick mcp` stdio MCP server, and `openclick daemon install|uninstall|status` for a launchd-backed always-on API server.

### Changed
- `src/paths.ts` resolves `/Applications/OpenclickHelper.app/Contents/MacOS/OpenclickHelper` first, falls back to `~/Applications/`, then the npm-bundled path. The previous unsigned `bin/cua-driver` resolution path is gone.
- `src/run.ts` captures daemon stderr to `~/.openclick/helper-daemon.stderr.log` and surfaces it on startup failure, replacing the silent 6-second timeout that masked permission and signature issues.
- After a successful `launch_app` step in `--allow-foreground` mode, openclick now runs `/usr/bin/open -b <bundle_id>` to bring the launched app to the front. Background mode (default) is unchanged.

### Fixed
- Hotkey shifted-symbol normalization now handles symbols anywhere in a `keys` array (`["+"]`, `["shift","+"]`, `["command","+"]`, `["control","shift","?"]`, etc.). Previous logic only caught two specific patterns and let unknown symbols reach the daemon, producing `Unknown key name: +`.

### Removed
- The migration step from the permission setup window — there are no real users on the prior `CuaDriver`-named install to migrate.

## [0.1.0.0] - 2026-04-25

Inaugural public release. openclick records a macOS task once and replays it via cua-driver. The runtime planner reads SKILL.md intent + a live screenshot + the AX tree, then emits a sequence of cua-driver tool calls executed locally.

### Added
- `openclick record <name>` — capture a macOS demonstration (CGEventTap + ScreenCaptureKit + AX snapshots) into a trajectory directory.
- `openclick compile <name>` — call Opus over the trajectory + sampled screenshots, emit a hybrid SKILL.md (cua + agentskills compatible) with structured `target.bundle_id`, `target.app_name`, and an `intent` block (goal, success_signals, subgoals, observed_input_modes).
- `openclick run <name> [--live] [--fast] [--cursor]` — replay. Default `--fast` plans once with Sonnet 4.6 against intent + screenshot + AX, then executes locally. Replans on failure with executed-step history + live AX tree.
- `openclick doctor [--fix]` — preflight checks for cua-driver path, daemon, Accessibility, Screen Recording, ANTHROPIC_API_KEY. `--fix` auto-starts the daemon.
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
