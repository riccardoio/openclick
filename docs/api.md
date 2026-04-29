# HTTP API

Start a local HTTP API server:

```sh
openclick server --host 127.0.0.1 --port 4242
```

Use a token when exposing the server beyond localhost:

```sh
openclick server --host 127.0.0.1 --port 4242 --token <token>
```

Send the token as either:

```sh
Authorization: Bearer <token>
X-OpenClick-Token: <token>
```

## Endpoints

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/health` | none | `{ "ok": true, "name": "openclick", "version": "..." }` |
| `GET` | `/v1/status` | none | Runs `openclick doctor` and returns `{ "ok": boolean, "report": ... }` |
| `GET` | `/v1/capabilities` | none | Returns machine-readable desktop capabilities, supported run statuses, result kinds, and endpoint names for host integrations. |
| `GET` | `/v1/settings/api-key` | none | Returns selected provider, availability, source, and masked key. The raw key is never returned. |
| `POST` | `/v1/settings/api-key` | `{ "apiKey": "..." }`, `{ "api_key": "..." }`, or `{ "apiKey": "...", "provider": "openai" }` | Saves/replaces the provider key and returns masked key status. |
| `DELETE` | `/v1/settings/api-key` | none | Clears the saved key for the selected provider and returns key status. |
| `POST` | `/v1/run` | `{ "task": "...", "live": true, "allowForeground": false, "criteria": "..." }` | Blocking compatibility endpoint. Runs `openclick run`; returns process output plus a standard `output` envelope. `live` defaults to `true`. |
| `POST` | `/v1/runs` | `{ "task": "...", "live": true, "allowForeground": false, "criteria": "..." }` | Starts an async run and returns `{ "ok": true, "run": StandardTaskOutput }` with HTTP `202`. |
| `GET` | `/v1/runs/:runId` | none | Returns `{ "ok": boolean, "run": StandardTaskOutput }` for an async run. |
| `GET` | `/v1/runs/:runId/events` | none, optional `?after=<eventId>` | Server-Sent Events stream for run status, output, intervention, result, and finish events. |
| `POST` | `/v1/runs/:runId/cancel` | none | Cancels an async run and returns its standard output envelope. |
| `POST` | `/v1/cancel` | `{ "runId": "..." }` or `{ "run_id": "..." }` | Runs `openclick cancel`; returns process output. |
| `GET` | `/v1/memory` | none | Runs `openclick memory list`; returns process output. |
| `OPTIONS` | any path | none | CORS preflight response. |

## Examples

Blocking run:

```sh
curl -X POST http://127.0.0.1:4242/v1/run \
  -H "Content-Type: application/json" \
  -d '{"task":"open Chrome and go to Gmail","live":true}'
```

Async run:

```sh
curl -X POST http://127.0.0.1:4242/v1/runs \
  -H "Content-Type: application/json" \
  -d '{"task":"read the latest unread email and return the content","live":true}'

curl http://127.0.0.1:4242/v1/runs/<run-id>
curl -N http://127.0.0.1:4242/v1/runs/<run-id>/events
```

## Standard Task Output Contract

All host integrations should treat `StandardTaskOutput` as the stable API contract for task execution.

`POST /v1/runs` and `GET /v1/runs/:runId` return it as `run`. The blocking compatibility endpoint `POST /v1/run` returns it as `output`.

```ts
type ApiRunStatus =
  | "queued"
  | "running"
  | "intervention_needed"
  | "user_takeover"
  | "resuming"
  | "completed"
  | "failed"
  | "cancelled";

type ApiTaskResult = {
  kind: "answer" | "confirmation";
  title: string;
  body: string;
  created_at: string;
};

type StandardTaskOutput = {
  schema_version: 1;
  run_id: string;
  child_run_id?: string;
  task: string;
  status: ApiRunStatus;
  ok: boolean;
  live: boolean;
  allow_foreground: boolean;
  criteria?: string;
  result?: ApiTaskResult;
  intervention?: Record<string, unknown>;
  exit_code?: number;
  error?: string;
  stdout: string;
  stderr: string;
  started_at: string;
  ended_at?: string;
};
```

| Field | Meaning |
| --- | --- |
| `schema_version` | Contract version. Currently always `1`. |
| `run_id` | API-level run id used by `/v1/runs/:runId`. |
| `child_run_id` | Internal CLI runner id, when available. Useful for trace/debug correlation. |
| `task` | Original natural-language task. |
| `status` | Current lifecycle state. |
| `ok` | `true` only when `status` is `completed`. |
| `live` | Whether the run was allowed to perform real desktop actions. |
| `allow_foreground` | Whether foreground/global-control actions were allowed. |
| `criteria` | Optional explicit success criteria supplied by the caller. |
| `result` | User-facing final output. Hosts should display `result.body`. |
| `intervention` | Structured stuck/takeover payload when `status` is `intervention_needed`. |
| `exit_code` | Child CLI process exit code once available. |
| `error` | Human-readable failure summary for failed/cancelled/interrupted runs. |
| `stdout` / `stderr` | Full process logs. Use for details/debug UI, not primary display. |
| `started_at` / `ended_at` | ISO timestamps. `ended_at` is absent while active. |

Result semantics:

- `result.kind = "answer"`: the user asked OpenClick to read, return, summarize, extract, report, or answer something.
- `result.kind = "confirmation"`: the user asked OpenClick to perform an action and no informational answer is needed.
- If `result` is absent, the run is still active or failed before a final user-facing answer could be produced.

Example:

```json
{
  "schema_version": 1,
  "run_id": "api-...",
  "child_run_id": "176...",
  "task": "read the latest unread email and return the content",
  "status": "completed",
  "ok": true,
  "live": true,
  "allow_foreground": false,
  "criteria": "optional success criteria",
  "result": {
    "kind": "answer",
    "title": "Result",
    "body": "Final user-facing answer or confirmation.",
    "created_at": "2026-04-29T00:00:00.000Z"
  },
  "exit_code": 0,
  "stdout": "...",
  "stderr": "...",
  "started_at": "2026-04-29T00:00:00.000Z",
  "ended_at": "2026-04-29T00:00:10.000Z"
}
```

Async run state is persisted under `~/.openclick/runs/<runId>/`:

- `api-output.json`: latest `StandardTaskOutput`
- `api-events.jsonl`: Server-Sent Event history

If the API daemon restarts during an active run, OpenClick reloads the persisted run and marks it as `failed` with an interruption error instead of leaving it stuck as `running`.

## OpenClaw Integration

OpenClick should be integrated into OpenClaw as a local macOS desktop-control node or skill:

- Install and keep the OpenClick daemon running on the Mac with `openclick daemon install`.
- Call `GET /v1/capabilities` during node/skill discovery.
- Use `POST /v1/runs` for new desktop tasks instead of the blocking `/v1/run` endpoint.
- Subscribe to `GET /v1/runs/:runId/events` and forward status/result/intervention events into OpenClaw session/tool events.
- Map `intervention_needed` to OpenClaw execution approval or takeover UX rather than treating it as a permanent failure.
- Display `run.result.body` as the final answer or completion confirmation, and keep full logs behind details/debug UI.

