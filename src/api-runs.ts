import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { currentOpenClickBin } from "./daemon.ts";
import { resolveApiRunEventsPath, resolveApiRunOutputPath } from "./paths.ts";
import { VERSION } from "./version.ts";

export type ApiRunStatus =
  | "queued"
  | "running"
  | "intervention_needed"
  | "user_takeover"
  | "resuming"
  | "completed"
  | "failed"
  | "cancelled";

export interface ApiTaskResult {
  kind: "answer" | "confirmation";
  title: string;
  body: string;
  created_at: string;
}

export interface StandardTaskOutput {
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
}

export interface ApiRunEvent {
  id: number;
  ts: string;
  type:
    | "created"
    | "stdout"
    | "stderr"
    | "status"
    | "result"
    | "intervention"
    | "finished";
  data: Record<string, unknown>;
}

export interface StartApiRunOptions {
  task: string;
  live: boolean;
  allowForeground: boolean;
  criteria?: string;
}

interface ApiRunRecord {
  output: StandardTaskOutput;
  events: ApiRunEvent[];
  nextEventId: number;
  process?: ReturnType<typeof Bun.spawn>;
}

const runs = new Map<string, ApiRunRecord>();

export function startApiRun(opts: StartApiRunOptions): StandardTaskOutput {
  const runId = createApiRunId();
  const now = new Date().toISOString();
  const record: ApiRunRecord = {
    output: {
      schema_version: 1,
      run_id: runId,
      task: opts.task,
      status: "queued",
      ok: false,
      live: opts.live,
      allow_foreground: opts.allowForeground,
      criteria: opts.criteria,
      stdout: "",
      stderr: "",
      started_at: now,
    },
    events: [],
    nextEventId: 1,
  };
  runs.set(runId, record);
  persistRecord(record);
  appendEvent(record, "created", { run_id: runId, task: opts.task });

  const args = ["run", opts.task];
  if (opts.live) args.push("--live");
  if (opts.allowForeground) args.push("--allow-foreground");
  if (opts.criteria?.trim()) args.push("--criteria", opts.criteria.trim());

  const proc = Bun.spawn([currentOpenClickBin(), ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, OPENCLICK_APP_USE_ENV: "1" },
  });
  record.process = proc;
  setStatus(record, "running");
  const stdoutDone = consumeProcessOutput(record, proc.stdout, "stdout");
  const stderrDone = consumeProcessOutput(record, proc.stderr, "stderr");
  void proc.exited.then(async (exitCode) => {
    await Promise.allSettled([stdoutDone, stderrDone]);
    finishRun(record, exitCode);
  });

  return snapshotOutput(record);
}

export function getApiRun(runId: string): StandardTaskOutput | null {
  const record = getOrLoadRecord(runId);
  return record ? snapshotOutput(record) : null;
}

export function getApiRunEvents(runId: string, afterId = 0): ApiRunEvent[] {
  const record = getOrLoadRecord(runId);
  if (!record) return [];
  return record.events.filter((event) => event.id > afterId);
}

export async function cancelApiRun(
  runId: string,
): Promise<StandardTaskOutput | null> {
  const record = runs.get(runId);
  if (!record) {
    const loaded = getApiRun(runId);
    if (!loaded) return null;
    if (
      loaded.status !== "completed" &&
      loaded.status !== "failed" &&
      loaded.status !== "cancelled"
    ) {
      loaded.status = "failed";
      loaded.ok = false;
      loaded.error = "run is not active in this daemon process";
      loaded.ended_at = loaded.ended_at ?? new Date().toISOString();
    }
    return loaded;
  }
  if (
    record.output.status === "completed" ||
    record.output.status === "failed" ||
    record.output.status === "cancelled"
  ) {
    return snapshotOutput(record);
  }
  if (record.output.child_run_id) {
    const proc = Bun.spawn(
      [currentOpenClickBin(), "cancel", record.output.child_run_id],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: { ...Bun.env, OPENCLICK_APP_USE_ENV: "1" },
      },
    );
    await proc.exited.catch(() => 1);
  }
  record.process?.kill();
  setStatus(record, "cancelled");
  record.output.ended_at = record.output.ended_at ?? new Date().toISOString();
  appendEvent(record, "finished", { status: "cancelled" });
  persistRecord(record);
  return snapshotOutput(record);
}

export function standardizeCommandResult(args: {
  runId?: string;
  task: string;
  live: boolean;
  allowForeground: boolean;
  criteria?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}): StandardTaskOutput {
  const output: StandardTaskOutput = {
    schema_version: 1,
    run_id: args.runId ?? createApiRunId(),
    task: args.task,
    status: args.exitCode === 0 ? "completed" : "failed",
    ok: args.exitCode === 0,
    live: args.live,
    allow_foreground: args.allowForeground,
    criteria: args.criteria,
    exit_code: args.exitCode,
    stdout: args.stdout,
    stderr: args.stderr,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
  };
  absorbOutputText(output, args.stdout, "stdout");
  absorbOutputText(output, args.stderr, "stderr");
  output.status = args.exitCode === 0 ? "completed" : "failed";
  output.ok = args.exitCode === 0;
  if (args.exitCode !== 0)
    output.error = lastMeaningfulLine(args.stderr || args.stdout);
  return output;
}

export function capabilitiesResponse(): Record<string, unknown> {
  return {
    schema_version: 1,
    name: "openclick",
    version: VERSION,
    capabilities: [
      "desktop.run",
      "desktop.cancel",
      "desktop.status",
      "desktop.events",
      "desktop.memory",
      "desktop.settings.api_key",
      "desktop.takeover",
    ],
    run_statuses: [
      "queued",
      "running",
      "intervention_needed",
      "user_takeover",
      "resuming",
      "completed",
      "failed",
      "cancelled",
    ],
    result_kinds: ["answer", "confirmation"],
    endpoints: {
      start_run: "POST /v1/runs",
      get_run: "GET /v1/runs/:runId",
      run_events: "GET /v1/runs/:runId/events",
      cancel_run: "POST /v1/runs/:runId/cancel",
      blocking_run: "POST /v1/run",
      status: "GET /v1/status",
    },
  };
}

export function forgetApiRunForTests(runId: string): void {
  runs.delete(runId);
}

function snapshotOutput(record: ApiRunRecord): StandardTaskOutput {
  return { ...record.output };
}

function getOrLoadRecord(runId: string): ApiRunRecord | null {
  const existing = runs.get(runId);
  if (existing) return existing;

  const loaded = loadPersistedRecord(runId);
  if (!loaded) return null;
  recoverLoadedRecord(loaded);
  runs.set(runId, loaded);
  return loaded;
}

function recoverLoadedRecord(record: ApiRunRecord): void {
  if (
    record.output.status === "queued" ||
    record.output.status === "running" ||
    record.output.status === "intervention_needed" ||
    record.output.status === "user_takeover" ||
    record.output.status === "resuming"
  ) {
    record.output.status = "failed";
    record.output.ok = false;
    record.output.error =
      "run was interrupted because the openclick API daemon restarted";
    record.output.ended_at = record.output.ended_at ?? new Date().toISOString();
    appendEvent(record, "status", { status: record.output.status });
    appendEvent(record, "finished", {
      status: record.output.status,
      ok: false,
      error: record.output.error,
    });
    persistRecord(record);
  }
}

async function consumeProcessOutput(
  record: ApiRunRecord,
  stream: unknown,
  streamName: "stdout" | "stderr",
): Promise<void> {
  if (!stream) return;
  const text = await new Response(stream as BodyInit).text();
  if (!text) return;
  if (streamName === "stdout") record.output.stdout += text;
  else record.output.stderr += text;
  absorbRecordText(record, text, streamName);
  appendEvent(record, streamName, { text });
}

function finishRun(record: ApiRunRecord, exitCode: number): void {
  record.output.exit_code = exitCode;
  record.output.ended_at = new Date().toISOString();
  if (record.output.status !== "cancelled") {
    setStatus(record, exitCode === 0 ? "completed" : "failed");
  }
  record.output.ok = record.output.status === "completed";
  if (!record.output.ok) {
    record.output.error = lastMeaningfulLine(
      record.output.stderr || record.output.stdout,
    );
  }
  appendEvent(record, "finished", {
    status: record.output.status,
    exit_code: exitCode,
    ok: record.output.ok,
  });
  persistRecord(record);
}

function setStatus(record: ApiRunRecord, status: ApiRunStatus): void {
  if (record.output.status === status) return;
  record.output.status = status;
  appendEvent(record, "status", { status });
}

function appendEvent(
  record: ApiRunRecord,
  type: ApiRunEvent["type"],
  data: Record<string, unknown>,
): void {
  record.events.push({
    id: record.nextEventId++,
    ts: new Date().toISOString(),
    type,
    data,
  });
  if (record.events.length > 1000)
    record.events.splice(0, record.events.length - 1000);
  persistRecord(record);
  const event = record.events.at(-1);
  if (event) persistEvent(record.output.run_id, event);
}

function absorbRecordText(
  record: ApiRunRecord,
  text: string,
  streamName: "stdout" | "stderr",
): void {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const previousStatus = record.output.status;
    const previousResult = record.output.result;
    const previousIntervention = record.output.intervention;
    absorbLine(record.output, line, streamName);
    if (record.output.status !== previousStatus) {
      appendEvent(record, "status", { status: record.output.status });
    }
    if (record.output.result && record.output.result !== previousResult) {
      appendEvent(record, "result", { ...record.output.result });
    }
    if (
      record.output.intervention &&
      record.output.intervention !== previousIntervention
    ) {
      appendEvent(record, "intervention", record.output.intervention);
    }
  }
}

function absorbOutputText(
  output: StandardTaskOutput,
  text: string,
  streamName: "stdout" | "stderr",
): void {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    absorbLine(output, line, streamName);
  }
}

function absorbLine(
  output: StandardTaskOutput,
  line: string,
  _streamName: "stdout" | "stderr",
): void {
  const runIdMatch = line.match(/\[openclick\]\s+run id:\s+(\S+)/);
  if (runIdMatch?.[1]) output.child_run_id = runIdMatch[1];

  const taskResultPrefix = "[openclick] task_result ";
  const taskResultIndex = line.indexOf(taskResultPrefix);
  if (taskResultIndex >= 0) {
    const raw = line.slice(taskResultIndex + taskResultPrefix.length).trim();
    const parsed = parseTaskResult(raw);
    if (parsed) output.result = parsed;
  }

  const interventionPrefix = "[openclick] intervention_required ";
  const interventionIndex = line.indexOf(interventionPrefix);
  if (interventionIndex >= 0) {
    const raw = line
      .slice(interventionIndex + interventionPrefix.length)
      .trim();
    output.intervention = parseJsonObject(raw) ?? { raw };
    output.status = "intervention_needed";
  }

  if (/\[openclick\]\s+takeover\b/.test(line)) {
    output.status = "resuming";
  }
}

function parseTaskResult(raw: string): ApiTaskResult | null {
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;
  const kind = parsed.kind === "answer" ? "answer" : "confirmation";
  const title = typeof parsed.title === "string" ? parsed.title : "";
  const body = typeof parsed.body === "string" ? parsed.body : "";
  const createdAt =
    typeof parsed.created_at === "string"
      ? parsed.created_at
      : new Date().toISOString();
  if (!body.trim()) return null;
  return {
    kind,
    title: title.trim() || (kind === "answer" ? "Result" : "Done"),
    body: body.trim(),
    created_at: createdAt,
  };
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function lastMeaningfulLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function persistRecord(record: ApiRunRecord): void {
  const path = resolveApiRunOutputPath(record.output.run_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record.output, null, 2)}\n`);
}

function persistEvent(runId: string, event: ApiRunEvent): void {
  const path = resolveApiRunEventsPath(runId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`);
}

function loadPersistedRecord(runId: string): ApiRunRecord | null {
  const outputPath = resolveApiRunOutputPath(runId);
  if (!existsSync(outputPath)) return null;
  try {
    const output = normalizeOutput(
      JSON.parse(readFileSync(outputPath, "utf8")),
    );
    if (!output) return null;
    const events = readPersistedEvents(runId);
    return {
      output,
      events,
      nextEventId:
        events.reduce((max, event) => Math.max(max, event.id), 0) + 1,
    };
  } catch {
    return null;
  }
}

function readPersistedEvents(runId: string): ApiRunEvent[] {
  const path = resolveApiRunEventsPath(runId);
  if (!existsSync(path)) return [];
  const events: ApiRunEvent[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = normalizeEvent(JSON.parse(line));
      if (event) events.push(event);
    } catch {
      // Skip corrupt event lines; the output snapshot is authoritative.
    }
  }
  return events.slice(-1000);
}

function normalizeOutput(value: unknown): StandardTaskOutput | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj.schema_version !== 1) return null;
  if (typeof obj.run_id !== "string" || !obj.run_id) return null;
  if (typeof obj.task !== "string") return null;
  const status = normalizeStatus(obj.status);
  if (!status) return null;
  return {
    schema_version: 1,
    run_id: obj.run_id,
    child_run_id:
      typeof obj.child_run_id === "string" ? obj.child_run_id : undefined,
    task: obj.task,
    status,
    ok: obj.ok === true,
    live: obj.live !== false,
    allow_foreground: obj.allow_foreground === true,
    criteria: typeof obj.criteria === "string" ? obj.criteria : undefined,
    result: normalizeTaskResultObject(obj.result),
    intervention:
      obj.intervention && typeof obj.intervention === "object"
        ? (obj.intervention as Record<string, unknown>)
        : undefined,
    exit_code: typeof obj.exit_code === "number" ? obj.exit_code : undefined,
    error: typeof obj.error === "string" ? obj.error : undefined,
    stdout: typeof obj.stdout === "string" ? obj.stdout : "",
    stderr: typeof obj.stderr === "string" ? obj.stderr : "",
    started_at:
      typeof obj.started_at === "string"
        ? obj.started_at
        : new Date().toISOString(),
    ended_at: typeof obj.ended_at === "string" ? obj.ended_at : undefined,
  };
}

function normalizeEvent(value: unknown): ApiRunEvent | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "number") return null;
  if (typeof obj.ts !== "string") return null;
  const type = normalizeEventType(obj.type);
  if (!type) return null;
  return {
    id: obj.id,
    ts: obj.ts,
    type,
    data:
      obj.data && typeof obj.data === "object"
        ? (obj.data as Record<string, unknown>)
        : {},
  };
}

function normalizeStatus(value: unknown): ApiRunStatus | null {
  if (
    value === "queued" ||
    value === "running" ||
    value === "intervention_needed" ||
    value === "user_takeover" ||
    value === "resuming" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return null;
}

function normalizeEventType(value: unknown): ApiRunEvent["type"] | null {
  if (
    value === "created" ||
    value === "stdout" ||
    value === "stderr" ||
    value === "status" ||
    value === "result" ||
    value === "intervention" ||
    value === "finished"
  ) {
    return value;
  }
  return null;
}

function normalizeTaskResultObject(value: unknown): ApiTaskResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const body = typeof obj.body === "string" ? obj.body.trim() : "";
  if (!body) return undefined;
  const kind = obj.kind === "answer" ? "answer" : "confirmation";
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  return {
    kind,
    title: title || (kind === "answer" ? "Result" : "Done"),
    body,
    created_at:
      typeof obj.created_at === "string"
        ? obj.created_at
        : new Date().toISOString(),
  };
}

function createApiRunId(): string {
  return `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
