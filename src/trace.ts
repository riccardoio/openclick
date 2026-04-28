import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  resolveRunCancelPath,
  resolveRunInterventionPath,
  resolveRunLockPath,
  resolveRunTakeoverResumePath,
  resolveRunTracePath,
} from "./paths.ts";
import type { PlanStep } from "./planner.ts";

export type InterventionReason =
  | "planner_blocked"
  | "needs_clarification"
  | "foreground_required"
  | "repeated_action_failure"
  | "verification_failed"
  | "permission_prompt"
  | "confirmation_dialog"
  | "login_or_2fa"
  | "captcha"
  | "native_modal"
  | "low_confidence"
  | "unexpected_screen_change"
  | "destructive_action_risk"
  | "user_requested_takeover";

export interface RunInterventionSnapshot {
  app_name?: string;
  bundle_id?: string;
  pid?: number;
  window_id?: number;
}

export interface InterventionPayload {
  run_id: string;
  issue: string;
  reason: string;
  reason_type: InterventionReason;
  step?: string;
  user_action: string;
  learning: string;
  before?: RunInterventionSnapshot;
  created_at: string;
}

export interface TakeoverResumeMarker {
  schema_version: 1;
  run_id: string;
  outcome: "success" | "failed" | "cancelled";
  issue: string;
  summary: string;
  reason_type?: InterventionReason;
  feedback?: string;
  trajectory_path?: string;
  bundle_id?: string;
  app_name?: string;
  task?: string;
  before?: RunInterventionSnapshot;
  after?: RunInterventionSnapshot;
  created_at: string;
}

export interface RunTraceEvent {
  ts: string;
  kind: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface RunTrace {
  schema_version: 1;
  run_id: string;
  prompt: string;
  criteria?: string;
  started_at: string;
  ended_at?: string;
  status: "running" | "succeeded" | "failed" | "aborted" | "cancelled";
  costs?: Record<string, number>;
  events: RunTraceEvent[];
}

export class TraceRecorder {
  readonly runId: string;
  readonly path: string;
  private trace: RunTrace;

  constructor(args: { runId: string; prompt: string; criteria?: string }) {
    this.runId = args.runId;
    this.path = resolveRunTracePath(args.runId);
    this.trace = {
      schema_version: 1,
      run_id: args.runId,
      prompt: args.prompt,
      criteria: args.criteria,
      started_at: new Date().toISOString(),
      status: "running",
      events: [],
    };
    this.flush();
  }

  event(kind: string, message?: string, data?: Record<string, unknown>): void {
    this.trace.events.push({
      ts: new Date().toISOString(),
      kind,
      message,
      data,
    });
    if (this.trace.events.length > 500)
      this.trace.events.splice(0, this.trace.events.length - 500);
    this.flush();
  }

  step(step: PlanStep, index: number): void {
    this.event("step", step.purpose, {
      index,
      tool: step.tool,
      args: redactLargeArgs(step.args),
      expected_change: step.expected_change,
    });
  }

  finish(status: RunTrace["status"], costs?: Record<string, number>): void {
    this.trace.status = status;
    this.trace.ended_at = new Date().toISOString();
    this.trace.costs = costs;
    this.flush();
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.trace, null, 2)}\n`);
  }
}

export function acquireRunLock(
  runId: string,
): { ok: true; release: () => void } | { ok: false; message: string } {
  const path = resolveRunLockPath();
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    try {
      const existing = JSON.parse(readFileSync(path, "utf8")) as {
        pid?: number;
        run_id?: string;
      };
      if (existing.pid && process.kill(existing.pid, 0)) {
        return {
          ok: false,
          message: `another openclick run is active (pid=${existing.pid}, run=${existing.run_id ?? "unknown"})`,
        };
      }
    } catch {
      // Stale or corrupt lock; replace it.
    }
  }
  writeFileSync(
    path,
    `${JSON.stringify({ pid: process.pid, run_id: runId, started_at: new Date().toISOString() })}\n`,
  );
  return {
    ok: true,
    release: () => {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // Best effort.
      }
    },
  };
}

export function requestRunCancel(runId: string): void {
  const path = resolveRunCancelPath(runId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, new Date().toISOString());
}

export function isRunCancelRequested(runId: string): boolean {
  return existsSync(resolveRunCancelPath(runId));
}

export function writeRunIntervention(payload: InterventionPayload): void {
  const path = resolveRunInterventionPath(payload.run_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

export function writeRunTakeoverResume(marker: TakeoverResumeMarker): void {
  const path = resolveRunTakeoverResumePath(marker.run_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`);
}

export function readRunTakeoverResume(
  runId: string,
): TakeoverResumeMarker | null {
  const path = resolveRunTakeoverResumePath(runId);
  if (!existsSync(path)) return null;
  try {
    return normalizeTakeoverResume(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function clearRunTakeoverResume(runId: string): void {
  const path = resolveRunTakeoverResumePath(runId);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best effort.
  }
}

function normalizeTakeoverResume(value: unknown): TakeoverResumeMarker | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.run_id !== "string" || obj.run_id.length === 0) return null;
  if (
    obj.outcome !== "success" &&
    obj.outcome !== "failed" &&
    obj.outcome !== "cancelled"
  ) {
    return null;
  }
  if (typeof obj.issue !== "string" || typeof obj.summary !== "string")
    return null;
  return {
    schema_version: 1,
    run_id: obj.run_id,
    outcome: obj.outcome,
    issue: obj.issue,
    summary: obj.summary,
    reason_type: normalizeInterventionReason(obj.reason_type),
    feedback: typeof obj.feedback === "string" ? obj.feedback : undefined,
    trajectory_path:
      typeof obj.trajectory_path === "string" ? obj.trajectory_path : undefined,
    bundle_id: typeof obj.bundle_id === "string" ? obj.bundle_id : undefined,
    app_name: typeof obj.app_name === "string" ? obj.app_name : undefined,
    task: typeof obj.task === "string" ? obj.task : undefined,
    before: normalizeSnapshot(obj.before),
    after: normalizeSnapshot(obj.after),
    created_at:
      typeof obj.created_at === "string"
        ? obj.created_at
        : new Date().toISOString(),
  };
}

function normalizeSnapshot(
  value: unknown,
): RunInterventionSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  return {
    app_name: typeof obj.app_name === "string" ? obj.app_name : undefined,
    bundle_id: typeof obj.bundle_id === "string" ? obj.bundle_id : undefined,
    pid: typeof obj.pid === "number" ? obj.pid : undefined,
    window_id: typeof obj.window_id === "number" ? obj.window_id : undefined,
  };
}

function normalizeInterventionReason(
  value: unknown,
): InterventionReason | undefined {
  if (typeof value !== "string") return undefined;
  if (
    [
      "planner_blocked",
      "needs_clarification",
      "foreground_required",
      "repeated_action_failure",
      "verification_failed",
      "permission_prompt",
      "confirmation_dialog",
      "login_or_2fa",
      "captcha",
      "native_modal",
      "low_confidence",
      "unexpected_screen_change",
      "destructive_action_risk",
      "user_requested_takeover",
    ].includes(value)
  ) {
    return value as InterventionReason;
  }
  return undefined;
}

function redactLargeArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > 300)
      out[key] = `${value.slice(0, 300)}...`;
    else out[key] = value;
  }
  return out;
}
