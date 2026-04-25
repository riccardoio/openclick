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
 * the `$pid` / `$window_id` placeholders. Also caches a structured AX index
 * from the most recent get_window_state output for `__selector` /
 * `__title` / `__ax_id` resolution.
 */
export interface ExecutorContext {
  pid?: number;
  windowId?: number;
  /** Structured AX entries from the latest get_window_state. */
  axIndex?: AxIndexEntry[];
}

/**
 * One row from the parsed AX tree. The bag of optional fields lets us match
 * by role / id / title / ancestor path / ordinal — not just title. Codex's
 * complaint about the old map: duplicate labels overwrote each other; blank
 * labels disappeared. Now nothing is lost.
 */
export interface AxIndexEntry {
  /** cua-driver element_index — what we ultimately send back to the driver. */
  index: number;
  /** AX role (e.g. "AXButton", "AXStaticText"). */
  role: string;
  /** id= field on the AX node, when present. */
  id?: string;
  /** Visible title / accessibility label, when present. */
  title?: string;
  /** Roles of ancestor elements, root-first (no titles, just role chain). */
  ancestorPath: string[];
  /**
   * 0-based ordinal among entries that share the SAME (role, title) tuple
   * (case-insensitive). Lets the planner pick "the second AXButton 'OK'".
   */
  ordinal: number;
}

/**
 * Selector emitted by the planner. Resolved at execute time against the
 * current AX index. Each field narrows the match; ordinal disambiguates
 * the leftover candidates.
 */
export interface PlanSelector {
  title?: string;
  ax_id?: string;
  role?: string;
  ordinal?: number;
}

/**
 * Parses cua-driver's `get_window_state` text output into a flat list of
 * {@link AxIndexEntry}. Each `- [N] ROLE (title)? id=ID?` line becomes one
 * entry. Indentation depth determines the ancestor path (the chain of
 * roles for parent lines, root-first).
 *
 * Lines without an index (`- AXGroup`) still establish ancestry but are
 * not addressable themselves.
 */
export function parseAxTreeIndex(stdout: string): AxIndexEntry[] {
  const entries: AxIndexEntry[] = [];
  // Capture: leading whitespace (depth), optional [N], role, optional (title), optional id=...
  // Both addressable and non-addressable lines are matched so we can build ancestry.
  const lineRe =
    /^(\s*)-\s+(?:\[(\d+)\]\s+)?(\S+)(?:\s+\(([^)]+)\))?(?:\s+id=([^\s]+))?/;
  // Ancestry stack: each entry is { indent, role }. Indent is the leading
  // whitespace length; deeper lines get the stack snapshot as their path.
  const stack: Array<{ indent: number; role: string }> = [];
  // (role|title) → count, for ordinal assignment.
  const ordinalCounter = new Map<string, number>();

  for (const rawLine of stdout.split("\n")) {
    const m = lineRe.exec(rawLine);
    if (!m) continue;
    const indent = (m[1] ?? "").length;
    const indexStr = m[2];
    const role = m[3] ?? "";
    const title = m[4]?.trim() || undefined;
    const id = m[5]?.trim() || undefined;

    // Pop the stack until we're at a strictly-greater indent than the last
    // ancestor — that's our parent.
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent)
      stack.pop();
    const ancestorPath = stack.map((s) => s.role);

    if (indexStr !== undefined) {
      const index = Number.parseInt(indexStr, 10);
      if (Number.isFinite(index)) {
        const ordKey = `${role.toLowerCase()}|${(title ?? "").toLowerCase()}`;
        const ordinal = ordinalCounter.get(ordKey) ?? 0;
        ordinalCounter.set(ordKey, ordinal + 1);
        entries.push({ index, role, id, title, ancestorPath, ordinal });
      }
    }

    // Whether or not the line is addressable, push onto the stack so deeper
    // children see this role as part of their ancestor path.
    stack.push({ indent, role });
  }
  return entries;
}

/**
 * Resolve a {@link PlanSelector} against the current AX index. Returns the
 * matching `element_index`, or null when ambiguous / not found.
 *
 * Resolution rules:
 *   - ax_id present → match unique entry by id (case-insensitive).
 *   - title + role  → match all by both, apply ordinal (default 0). When
 *                     multiple match without an ordinal, return null.
 *   - title alone   → match by title; multiple matches without ordinal → null.
 */
export function resolveSelector(
  entries: AxIndexEntry[],
  selector: PlanSelector,
): number | null {
  const ord = selector.ordinal;
  const lower = (s: string | undefined): string | undefined =>
    s === undefined ? undefined : s.toLowerCase();

  if (selector.ax_id !== undefined) {
    const wantId = lower(selector.ax_id);
    const matches = entries.filter((e) => lower(e.id) === wantId);
    if (matches.length === 1) return matches[0]?.index ?? null;
    // Multiple ids matching means the AX tree had duplicates. Disambiguate
    // by ordinal if the planner provided one; else null.
    if (matches.length > 1 && ord !== undefined && ord < matches.length)
      return matches[ord]?.index ?? null;
    return null;
  }

  const wantTitle = lower(selector.title);
  const wantRole = lower(selector.role);
  let matches = entries;
  if (wantTitle !== undefined)
    matches = matches.filter((e) => lower(e.title) === wantTitle);
  if (wantRole !== undefined)
    matches = matches.filter((e) => lower(e.role) === wantRole);

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]?.index ?? null;

  // Multiple candidates. The planner must pin down which one with `ordinal`.
  if (ord !== undefined && ord < matches.length)
    return matches[ord]?.index ?? null;
  return null;
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
 * from the executor context. Also resolves `__selector` / `__title` /
 * `__ax_id` synthetic keys to a real `element_index` via {@link resolveSelector}.
 * Untouched if a placeholder isn't resolvable yet — the cua-driver subprocess
 * surfaces a clear error.
 *
 * `__title` / `__ax_id` are kept as backward-compat shorthands; both become
 * a `PlanSelector` internally.
 */
function substitutePlaceholders(
  args: Record<string, unknown>,
  ctx: ExecutorContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let pendingSelector: PlanSelector | null = null;
  for (const [k, v] of Object.entries(args)) {
    if (k === "__selector" && v && typeof v === "object") {
      pendingSelector = v as PlanSelector;
      continue;
    }
    if (k === "__title" && typeof v === "string") {
      pendingSelector = { ...(pendingSelector ?? {}), title: v };
      continue;
    }
    if (k === "__ax_id" && typeof v === "string") {
      pendingSelector = { ...(pendingSelector ?? {}), ax_id: v };
      continue;
    }
    if (v === "$pid" && ctx.pid !== undefined) out[k] = ctx.pid;
    else if (v === "$window_id" && ctx.windowId !== undefined)
      out[k] = ctx.windowId;
    else out[k] = v;
  }
  if (pendingSelector !== null && ctx.axIndex) {
    const idx = resolveSelector(ctx.axIndex, pendingSelector);
    if (idx !== null) out.element_index = idx;
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
  // bracketed [N] AXRole entries to rebuild the structured AX index.
  if (tool === "get_window_state") {
    const entries = parseAxTreeIndex(stdout);
    if (entries.length > 0) ctx.axIndex = entries;
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
