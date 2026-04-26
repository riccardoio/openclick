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
  resolveRunLockPath,
  resolveRunTracePath,
} from "./paths.ts";
import type { PlanStep } from "./planner.ts";

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
          message: `another showme run is active (pid=${existing.pid}, run=${existing.run_id ?? "unknown"})`,
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
