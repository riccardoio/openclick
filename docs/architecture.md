# Architecture

Core files:

- `bin/openclick`: CLI entrypoint.
- `src/cli.ts`: command parsing and runtime budgets.
- `src/run.ts`: prompt-first execution, screenshots, modal state, verification, critique/replanning, run locking, traces, and cost telemetry.
- `src/planner.ts`: planner prompts, model plan validation, and common planner mistake normalization.
- `src/executor.ts`: local plan execution through `cua-driver`, AX selector resolution, context repair, and task-level window leases.
- `src/settings.ts`: provider, model, and API-key configuration.
- `src/server.ts`: HTTP API and MCP stdio server.
- `src/api-runs.ts`: async API run registry, event stream state, persisted output contract, and run status recovery.
- `src/daemon.ts`: launchd API daemon installation and management.
- `src/memory.ts`: local app memory storage, import/export, promotion, and retrieval.
- `src/trace.ts`: run traces, intervention markers, takeover resume markers, cancellation markers, and the single-run desktop lock.
- `src/doctor.ts`: local dependency and macOS permission checks.
- `src/mac-app.ts`: local development helper for building and launching the native Mac app bundle.

Native app:

- `mac-app/Sources/OpenClickApp/`: native menu bar app, onboarding, settings, chat bar, and task activity UI.
- `mac-app/Sources/Recorder/`: legacy Swift recorder executable.
- `mac-app/Sources/RecorderCore/`: recorder shared code and tests.

Tests:

- `tests/`: Bun tests and fixtures.

