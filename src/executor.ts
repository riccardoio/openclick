/**
 * Local executor for `showme run --fast` plans.
 *
 * Walks a {@link Plan} step by step, shelling out to `cua-driver <tool> <json>`
 * for each — no LLM round-trip per step. The substitution layer below
 * resolves `$pid` and `$window_id` placeholders from the most recent
 * `launch_app` / `list_windows` result so the planner can produce a plan
 * before those ids exist.
 */
import type { Plan, PlanStep } from "./planner.ts";

export interface StepResult {
  ok: boolean;
  /** Stderr / driver error message when ok=false. */
  error?: string;
  /** stdout from the cua-driver invocation (typically JSON). */
  stdout?: string;
}

export type StepRunner = (step: PlanStep) => Promise<StepResult>;

export interface ExecutePlanOptions {
  /** Injectable for tests. Defaults to a real cua-driver subprocess runner. */
  stepRunner?: StepRunner;
  /** When true, walk the plan but do not execute any step. */
  dryRun?: boolean;
  /** When true, prompt the user before each step. */
  confirm?: boolean;
  /** Log sink (default: console.log). */
  log?: (line: string) => void;
  /**
   * Seed the executor context with values discovered before plan execution.
   * Pre-discovery (see `preDiscoverAppState`) populates pid + window_id + the
   * AX index map BEFORE the planner ever runs, so the first click step can
   * resolve `__title` / `__ax_id` / `__selector` without an in-plan
   * `get_window_state`.
   */
  initialContext?: ExecutorContext;
}

export interface ExecutePlanResult {
  stepsExecuted: number;
  totalSteps: number;
  /** When a step fails, the 0-based index it failed at. */
  failedStepIndex?: number;
  /** When a step fails, the error message. */
  error?: string;
  /** Last successful launch_app/list_windows context — useful for replan. */
  lastContext: ExecutorContext;
}

/**
 * Tracks the most recent pid + window_id observed from launch_app /
 * list_windows / get_window_state output so subsequent steps can use
 * the `$pid` / `$window_id` placeholders. Also caches a {title|id → element_index}
 * map from the most recent get_window_state output for `__title` / `__ax_id`
 * placeholder resolution (lets the planner say "click button '5'" instead
 * of trying to read an index out of the AX tree text — Sonnet gets that wrong).
 */
export interface ExecutorContext {
  pid?: number;
  windowId?: number;
  /** title or id (lowercased) → element_index from the latest get_window_state */
  axIndex?: Map<string, number>;
}

/**
 * Parses cua-driver's `get_window_state` text output. The format is:
 *   - [12] AXButton (5) id=Five
 *   - [4] AXButton (All Clear) id=AllClear
 *   - [22] AXButton (Equals) id=Equals
 * (and lines without parens / id, which we still index by role+number).
 *
 * Returns map keyed by lowercased title AND lowercased id (both populated when
 * present) so a planner saying `__title: "5"` or `__ax_id: "Five"` resolves
 * to the same `element_index`.
 */
export function parseAxTreeIndex(stdout: string): Map<string, number> {
  const map = new Map<string, number>();
  // \s*-\s+\[N\]\s+ROLE\s*(?:\(TITLE\))?\s*(?:id=ID)?
  const lineRe =
    /^\s*-\s+\[(\d+)\]\s+\S+(?:\s+\(([^)]+)\))?(?:\s+id=([^\s]+))?/gm;
  let m: RegExpExecArray | null = lineRe.exec(stdout);
  while (m !== null) {
    const index = Number.parseInt(m[1] ?? "", 10);
    const title = m[2];
    const id = m[3];
    if (Number.isFinite(index)) {
      if (title) map.set(title.toLowerCase(), index);
      if (id) map.set(id.toLowerCase(), index);
    }
    m = lineRe.exec(stdout);
  }
  return map;
}

export async function executePlan(
  plan: Plan,
  opts: ExecutePlanOptions = {},
): Promise<ExecutePlanResult> {
  const log = opts.log ?? ((line) => console.log(line));
  const runner = opts.stepRunner ?? defaultStepRunner;
  // Start with the caller-provided context (typically pre-discovery output).
  // Make a shallow copy so we don't mutate the caller's object.
  const ctx: ExecutorContext = opts.initialContext
    ? {
        pid: opts.initialContext.pid,
        windowId: opts.initialContext.windowId,
        axIndex: opts.initialContext.axIndex,
      }
    : {};

  let executed = 0;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step) continue; // satisfy noUncheckedIndexedAccess
    const resolved: PlanStep = {
      tool: step.tool,
      args: substitutePlaceholders(step.args, ctx),
      purpose: step.purpose,
    };
    log(`[showme] about to: ${step.purpose}`);
    if (opts.dryRun) continue;
    if (opts.confirm) {
      const ok = await promptYesNo("execute? [y/N]: ");
      if (!ok) {
        return {
          stepsExecuted: executed,
          totalSteps: plan.steps.length,
          failedStepIndex: i,
          error: "user declined",
          lastContext: ctx,
        };
      }
    }
    const result = await runner(resolved);
    if (!result.ok) {
      return {
        stepsExecuted: executed,
        totalSteps: plan.steps.length,
        failedStepIndex: i,
        error: result.error ?? "unknown error",
        lastContext: ctx,
      };
    }
    executed++;
    if (result.stdout) absorbContext(ctx, step.tool, result.stdout);
  }
  return {
    stepsExecuted: executed,
    totalSteps: plan.steps.length,
    lastContext: ctx,
  };
}

/**
 * Replace literal "$pid" / "$window_id" string values with concrete numbers
 * from the executor context. Also resolves `__title` / `__ax_id` synthetic
 * keys to a real `element_index` by looking up the cached AX-tree index.
 * Untouched if a placeholder isn't resolvable yet — the cua-driver subprocess
 * surfaces a clear error.
 */
function substitutePlaceholders(
  args: Record<string, unknown>,
  ctx: ExecutorContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if ((k === "__title" || k === "__ax_id") && typeof v === "string") {
      // Synthetic key: resolve to element_index via AX tree lookup.
      const idx = ctx.axIndex?.get(v.toLowerCase());
      if (idx !== undefined) out.element_index = idx;
      // Drop __title / __ax_id from the outgoing args either way — cua-driver
      // doesn't accept them as real fields.
      continue;
    }
    if (v === "$pid" && ctx.pid !== undefined) out[k] = ctx.pid;
    else if (v === "$window_id" && ctx.windowId !== undefined)
      out[k] = ctx.windowId;
    else out[k] = v;
  }
  return out;
}

/**
 * Inspect a successful step's stdout for context-establishing fields.
 *
 * `launch_app` returns `{ pid, windows: [{ window_id, ... }, ...] }` and
 * `list_windows` returns `{ windows: [...] }`. Both update the executor
 * context so later steps resolve `$pid` / `$window_id`.
 */
function absorbContext(
  ctx: ExecutorContext,
  tool: string,
  stdout: string,
): void {
  if (
    tool !== "launch_app" &&
    tool !== "list_windows" &&
    tool !== "get_window_state"
  )
    return;

  // get_window_state output is human-readable text (not JSON) — parse the
  // bracketed [N] AXRole entries to build the title/id → element_index map.
  if (tool === "get_window_state") {
    const idx = parseAxTreeIndex(stdout);
    if (idx.size > 0) ctx.axIndex = idx;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.pid === "number") ctx.pid = obj.pid;
  if (typeof obj.window_id === "number") ctx.windowId = obj.window_id;
  if (Array.isArray(obj.windows) && obj.windows.length > 0) {
    const first = obj.windows[0] as Record<string, unknown> | undefined;
    if (first && typeof first.window_id === "number")
      ctx.windowId = first.window_id;
  }
}

const defaultStepRunner: StepRunner = async (step) => {
  const proc = Bun.spawn(
    ["cua-driver", "call", step.tool, JSON.stringify(step.args)],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (proc.exitCode !== 0) {
    return {
      ok: false,
      error: `cua-driver ${step.tool} exited ${proc.exitCode}: ${stderr.trim() || stdout.trim()}`,
      stdout,
    };
  }
  return { ok: true, stdout };
};

async function promptYesNo(prompt: string): Promise<boolean> {
  process.stdout.write(prompt);
  const buf = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(d.toString().trim()));
  });
  return buf.toLowerCase() === "y" || buf.toLowerCase() === "yes";
}
