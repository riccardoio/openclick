/**
 * Local executor for `showme run --fast` plans.
 *
 * Walks a {@link Plan} step by step, shelling out to `cua-driver <tool> <json>`
 * for each — no LLM round-trip per step. The substitution layer below
 * resolves `$pid` and `$window_id` placeholders from the most recent
 * `launch_app` / `list_windows` result so the planner can produce a plan
 * before those ids exist.
 */
import { type Plan, type PlanStep, normalizePlanStep } from "./planner.ts";

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
  /**
   * Before each AX-targeted step (click / double_click / right_click /
   * type_text with a selector), re-run get_window_state and rebuild the AX
   * index. State-changing clicks can rerender, shift indices, or move focus —
   * so a stale cached map points to the wrong button. Default: true.
   * Tests / cases that already prime the cache can disable this.
   */
  refreshBeforeAxClick?: boolean;
  /** Maximum number of plan steps to execute in this invocation. */
  maxSteps?: number;
  /**
   * Default is shared-seat background mode: only primitives that target a
   * pid/window without stealing the human's cursor/focus may execute.
   */
  executionPolicy?: ExecutionPolicy;
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
  /** Pixel size of the optimized screenshot most recently shown to the planner. */
  screenshotWidth?: number;
  screenshotHeight?: number;
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

export type ExecutionPolicy = "background" | "foreground";

export type StepSafetyCategory =
  | "background_safe"
  | "foreground_required"
  | "unsupported";

export interface StepSafety {
  tool: string;
  category: StepSafetyCategory;
  reason: string;
}

const BACKGROUND_SAFE_TOOLS = new Set([
  "check_permissions",
  "click",
  "double_click",
  "drag",
  "get_accessibility_tree",
  "get_agent_cursor_state",
  "get_config",
  "get_cursor_position",
  "get_recording_state",
  "get_screen_size",
  "get_window_state",
  "hotkey",
  "launch_app",
  "list_apps",
  "list_windows",
  "multi_drag",
  "press_key",
  "right_click",
  "screenshot",
  "scroll",
  "set_value",
  "type_text",
  "type_text_chars",
  "zoom",
  "click_hold",
]);

const FOREGROUND_REQUIRED_TOOLS = new Set([
  "move_cursor",
  "paste_svg",
  "recording",
  "replay_trajectory",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_config",
  "set_recording",
]);

export function canonicalToolName(tool: string): string {
  const parts = tool.split("__");
  return parts.at(-1) ?? tool;
}

export function classifyToolSafety(tool: string): StepSafety {
  const normalized = canonicalToolName(tool);
  if (BACKGROUND_SAFE_TOOLS.has(normalized)) {
    return {
      tool: normalized,
      category: "background_safe",
      reason: `${normalized} targets a pid/window or only reads state`,
    };
  }
  if (FOREGROUND_REQUIRED_TOOLS.has(normalized)) {
    return {
      tool: normalized,
      category: "foreground_required",
      reason: `${normalized} may steal focus, move the real cursor, modify global state, or replay foreground input`,
    };
  }
  return {
    tool: normalized,
    category: "unsupported",
    reason: `${normalized} is not in showme's background-safe tool allowlist`,
  };
}

export function classifyStepSafety(step: Pick<PlanStep, "tool">): StepSafety {
  return classifyToolSafety(step.tool);
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
  // Capture: leading whitespace (depth), optional [N], role, optional
  // (title) or "title", optional id=...
  // Both addressable and non-addressable lines are matched so we can build ancestry.
  const lineRe =
    /^(\s*)-\s+(?:\[(\d+)\]\s+)?(\S+)(?:\s+(?:"([^"]+)"|\(([^)]+)\)))?(?:\s+id=([^\s]+))?/;
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
    const title = (m[4] ?? m[5])?.trim() || undefined;
    const id = m[6]?.trim() || undefined;

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
    const numericIndex = Number.parseInt(selector.ax_id, 10);
    if (Number.isFinite(numericIndex)) {
      const byIndex = entries.find((e) => e.index === numericIndex);
      if (byIndex) return byIndex.index;
    }
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
        screenshotWidth: opts.initialContext.screenshotWidth,
        screenshotHeight: opts.initialContext.screenshotHeight,
      }
    : {};

  const refreshBeforeAxClick = opts.refreshBeforeAxClick ?? true;
  const executionPolicy = opts.executionPolicy ?? "background";

  let executed = 0;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step) continue; // satisfy noUncheckedIndexedAccess
    if (opts.maxSteps !== undefined && executed >= opts.maxSteps) {
      return {
        stepsExecuted: executed,
        totalSteps: plan.steps.length,
        failedStepIndex: i,
        error: `max step budget exhausted (${opts.maxSteps})`,
        lastContext: ctx,
      };
    }

    // `assert` is a no-op. Mid-flight asserts invent failure modes we can't
    // predict per-app (the address bar after a Safari search shows a URL,
    // not the literal query, so an assert on the query text spuriously
    // fails). Success is checked once at the end via stopWhen against
    // intent.success_signals — that's the only validation we trust. Legacy
    // plans may still contain assert steps; treat them as silent skips.
    if (step.tool === "assert") {
      log(`[showme] (skip assert: ${step.purpose})`);
      executed++;
      continue;
    }

    // Auto-refresh: state-changing clicks rerender; element_index drifts. If
    // the upcoming step is an AX-targeted click/type and we know pid+window,
    // re-run get_window_state through the same runner before resolving the
    // selector. Skip when context isn't ready (the in-plan steps will populate
    // it normally) or when the caller opts out.
    if (
      !opts.dryRun &&
      refreshBeforeAxClick &&
      isAxTargetedStep(step) &&
      ctx.pid !== undefined &&
      ctx.windowId !== undefined
    ) {
      const refreshStep: PlanStep = {
        tool: "get_window_state",
        args: { pid: ctx.pid, window_id: ctx.windowId },
        purpose: "refresh AX index",
      };
      log("[showme] (refresh AX index)");
      const refreshResult = await runner(refreshStep);
      if (refreshResult.ok && refreshResult.stdout)
        absorbContext(
          ctx,
          "get_window_state",
          refreshResult.stdout,
          refreshStep.args,
        );
      // A failed refresh shouldn't kill the run — fall through and let the
      // real click attempt produce the error message the user expects.
    }

    const normalizedStep = normalizePlanStep(step);
    const resolved: PlanStep = {
      tool: normalizedStep.tool,
      args: repairArgsForContext(
        normalizedStep.tool,
        substitutePlaceholders(normalizedStep.args, ctx),
        ctx,
      ),
      purpose: normalizedStep.purpose,
    };
    log(`[showme] about to: ${step.purpose}`);
    if (opts.dryRun) continue;
    const safety = classifyStepSafety(resolved);
    if (safety.category === "unsupported") {
      return {
        stepsExecuted: executed,
        totalSteps: plan.steps.length,
        failedStepIndex: i,
        error: `unsupported tool blocked: ${safety.reason}`,
        lastContext: ctx,
      };
    }
    if (
      executionPolicy === "background" &&
      safety.category === "foreground_required"
    ) {
      return {
        stepsExecuted: executed,
        totalSteps: plan.steps.length,
        failedStepIndex: i,
        error: `foreground-required tool blocked in shared-seat background mode: ${safety.reason}. Re-run with --allow-foreground only when you are ready to let showme control foreground/global input.`,
        lastContext: ctx,
      };
    }
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
    const result = await runResolvedStep(resolved, runner, ctx, log);
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
    if (result.stdout)
      absorbContext(ctx, step.tool, result.stdout, resolved.args);
  }
  return {
    stepsExecuted: executed,
    totalSteps: plan.steps.length,
    lastContext: ctx,
  };
}

/** Tools that we want to refresh AX state before, when an AX selector is used. */
const AX_TARGETED_TOOLS = new Set([
  "click",
  "double_click",
  "right_click",
  "type_text",
]);

const EDITABLE_ROLES = new Set([
  "axtextfield",
  "axtextarea",
  "axtextedit",
  "axcombobox",
  "axsearchfield",
]);

async function runResolvedStep(
  step: PlanStep,
  runner: StepRunner,
  ctx: ExecutorContext,
  log: (line: string) => void,
): Promise<StepResult> {
  const buttonStep = keyboardStepToButtonClick(step, ctx);
  if (buttonStep) return await runner(buttonStep);

  const text = step.args.text;
  if (
    step.tool !== "type_text" ||
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > 80 ||
    typeof step.args.pid !== "number" ||
    hasEditableRole(ctx) ||
    !shouldTypeTextAsKeySequence(text)
  ) {
    return await runner(step);
  }

  log("[showme] (type_text fallback: sending key sequence)");
  let stdout = "";
  for (const keyStep of textToKeySteps(step.args.pid, text, step.purpose)) {
    const result = await runner(keyStep);
    stdout += result.stdout ?? "";
    if (!result.ok) return { ...result, stdout };
  }
  return { ok: true, stdout };
}

function shouldTypeTextAsKeySequence(text: string): boolean {
  return /^[0-9+\-*/().=\s\r\n]+$/.test(text);
}

function keyboardStepToButtonClick(
  step: PlanStep,
  ctx: ExecutorContext,
): PlanStep | null {
  if (
    hasEditableRole(ctx) ||
    typeof step.args.pid !== "number" ||
    ctx.windowId === undefined ||
    !ctx.axIndex ||
    (step.tool !== "press_key" && step.tool !== "hotkey")
  ) {
    return null;
  }

  const key = keyFromKeyboardStep(step);
  if (!key) return null;
  const candidates = buttonCandidatesForKey(key);
  if (candidates.length === 0) return null;

  const match = ctx.axIndex.find((entry) => {
    if (entry.role.toLowerCase() !== "axbutton") return false;
    const title = entry.title?.toLowerCase();
    const id = entry.id?.toLowerCase();
    return candidates.some(
      (candidate) =>
        title === candidate.toLowerCase() || id === candidate.toLowerCase(),
    );
  });
  if (!match) return null;

  return {
    tool: "click",
    args: {
      pid: step.args.pid,
      window_id: ctx.windowId,
      element_index: match.index,
    },
    purpose: step.purpose,
  };
}

function keyFromKeyboardStep(step: PlanStep): string | null {
  if (step.tool === "press_key")
    return typeof step.args.key === "string" ? step.args.key : null;
  if (step.tool !== "hotkey" || !Array.isArray(step.args.keys)) return null;
  const keys = step.args.keys.filter(
    (key): key is string => typeof key === "string",
  );
  if (keys.length !== 2 || keys[0]?.toLowerCase() !== "shift") return null;
  return shiftedCharForBaseKey(keys[1]);
}

function shiftedCharForBaseKey(baseKey: string | undefined): string | null {
  if (!baseKey) return null;
  const entry = Object.entries({
    "~": "`",
    "!": "1",
    "@": "2",
    "#": "3",
    $: "4",
    "%": "5",
    "^": "6",
    "&": "7",
    "*": "8",
    "(": "9",
    ")": "0",
    _: "-",
    "+": "=",
    "{": "[",
    "}": "]",
    "|": "\\",
    ":": ";",
    '"': "'",
    "<": ",",
    ">": ".",
    "?": "/",
  }).find(([, base]) => base === baseKey);
  return entry?.[0] ?? null;
}

function buttonCandidatesForKey(key: string): string[] {
  if (/^\d$/.test(key)) return [key];
  const lower = key.toLowerCase();
  const candidates: Record<string, string[]> = {
    "*": ["Multiply"],
    "+": ["Add"],
    "-": ["Subtract"],
    "/": ["Divide"],
    return: ["Equals"],
    enter: ["Equals"],
    "=": ["Equals"],
    escape: ["All Clear", "Clear"],
    delete: ["Delete"],
    backspace: ["Delete"],
  };
  return candidates[lower] ?? candidates[key] ?? [];
}

function hasEditableRole(ctx: ExecutorContext): boolean {
  return (
    ctx.axIndex?.some((entry) =>
      EDITABLE_ROLES.has(entry.role.toLowerCase()),
    ) ?? false
  );
}

function textToKeySteps(
  pid: number,
  text: string,
  purpose: string,
): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const char of text) {
    const key = keyNameForChar(char);
    if (!key) {
      steps.push({
        tool: "type_text",
        args: { pid, text: char },
        purpose,
      });
      continue;
    }
    steps.push(
      normalizePlanStep({
        tool: "press_key",
        args: { pid, key },
        purpose,
      }),
    );
  }
  return steps;
}

function keyNameForChar(char: string): string | null {
  if (char === "\n" || char === "\r") return "return";
  if (char === "\t") return "tab";
  if (char === " ") return "space";
  if (/^[A-Za-z0-9]$/.test(char)) return char;
  if (/^[`~!@#$%^&*()_\-+=[\]{}\\|;:'",<.>/?]$/.test(char)) return char;
  return null;
}

/**
 * Does this step target an AX element by selector (rather than absolute
 * coordinates / a simple key press)? True when the tool is one of the
 * AX-targeted ones AND the args reference at least one selector key.
 */
function isAxTargetedStep(step: PlanStep): boolean {
  if (!AX_TARGETED_TOOLS.has(step.tool)) return false;
  return (
    "__selector" in step.args ||
    "__title" in step.args ||
    "__ax_id" in step.args
  );
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
      pendingSelector = normalizeSelector(v as Record<string, unknown>);
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
    // Defensive: planners occasionally emit `pid: 0` / `window_id: 0` when
    // they treat 0 as a placeholder. cua-driver receives 0 verbatim and
    // rejects with "no process" / "no cached AX state for pid 0". When the
    // executor has a real pid/window_id from pre-discovery or a prior step,
    // substitute. Only triggers for the canonical pid/window_id keys to
    // avoid stomping on legitimate 0 values in other arg fields.
    else if (k === "pid" && v === 0 && ctx.pid !== undefined) out[k] = ctx.pid;
    else if (k === "window_id" && v === 0 && ctx.windowId !== undefined)
      out[k] = ctx.windowId;
    else out[k] = v;
  }
  if (pendingSelector !== null && ctx.axIndex) {
    const idx = resolveSelector(ctx.axIndex, pendingSelector);
    if (idx !== null) out.element_index = idx;
  }
  return out;
}

function normalizeSelector(value: Record<string, unknown>): PlanSelector {
  const selector: PlanSelector = {};
  if (typeof value.title === "string") selector.title = value.title;
  if (typeof value.ax_id === "string") selector.ax_id = value.ax_id;
  if (typeof value.role === "string") selector.role = value.role;
  if (typeof value.ordinal === "number" && Number.isInteger(value.ordinal))
    selector.ordinal = value.ordinal;
  return selector;
}

function repairArgsForContext(
  tool: string,
  args: Record<string, unknown>,
  ctx: ExecutorContext,
): Record<string, unknown> {
  const out = { ...args };
  if (
    (tool === "get_window_state" || tool === "list_windows") &&
    out.pid === undefined &&
    ctx.pid !== undefined
  ) {
    out.pid = ctx.pid;
  }
  if (tool === "paste_svg" && out.pid === undefined && ctx.pid !== undefined)
    out.pid = ctx.pid;
  if (
    tool === "paste_svg" &&
    out.window_id === undefined &&
    ctx.windowId !== undefined
  )
    out.window_id = ctx.windowId;
  if (
    (tool === "get_window_state" ||
      tool === "click" ||
      tool === "double_click" ||
      tool === "right_click" ||
      tool === "drag" ||
      tool === "screenshot") &&
    out.window_id === undefined &&
    ctx.windowId !== undefined
  ) {
    out.window_id = ctx.windowId;
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
  args: Record<string, unknown> = {},
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
    ctx.axIndex = entries;
  }

  if (typeof args.pid === "number") ctx.pid = args.pid;
  if (typeof args.window_id === "number") ctx.windowId = args.window_id;

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
    const first = pickUsableWindow(obj.windows);
    if (first && typeof first.window_id === "number")
      ctx.windowId = first.window_id;
  }
}

function pickUsableWindow(
  windows: unknown[],
): Record<string, unknown> | undefined {
  const records = windows.filter(
    (window): window is Record<string, unknown> =>
      !!window && typeof window === "object",
  );
  return (
    records.find((window) => {
      const bounds = window.bounds as Record<string, unknown> | undefined;
      const width = Number(bounds?.width ?? 0);
      const height = Number(bounds?.height ?? 0);
      return width >= 100 && height >= 80;
    }) ?? records[0]
  );
}

export async function runCuaDriverStep(
  step: PlanStep,
  cuaDriver = "cua-driver",
  opts: { executionPolicy?: ExecutionPolicy } = {},
): Promise<StepResult> {
  const safety = classifyStepSafety(step);
  if (safety.category === "unsupported") {
    return { ok: false, error: `unsupported tool blocked: ${safety.reason}` };
  }
  if (
    (opts.executionPolicy ?? "background") === "background" &&
    safety.category === "foreground_required"
  ) {
    return {
      ok: false,
      error: `foreground-required tool blocked in shared-seat background mode: ${safety.reason}. Re-run with --allow-foreground only when you are ready to let showme control foreground/global input.`,
    };
  }
  if (step.tool === "drag") return await runVirtualDrag(step, cuaDriver);
  if (step.tool === "multi_drag")
    return await runVirtualMultiDrag(step, cuaDriver);
  if (step.tool === "click_hold")
    return await runVirtualClickHold(step, cuaDriver);
  // Extension primitive: intentionally not advertised in the default planner.
  // Generic runs should use the target app like a human unless a future
  // app-specific extension explicitly opts into clipboard import.
  if (step.tool === "paste_svg")
    return await runVirtualPasteSvg(step, cuaDriver);
  const proc = Bun.spawn(
    [cuaDriver, "call", step.tool, JSON.stringify(step.args)],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const { exitCode, stdout, stderr, timedOut } = await collectProcess(proc);
  if (timedOut) {
    return { ok: false, error: `cua-driver ${step.tool} timed out`, stdout };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      error: `cua-driver ${step.tool} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
      stdout,
    };
  }
  return { ok: true, stdout };
}

async function runVirtualMultiDrag(
  step: PlanStep,
  cuaDriver: string,
): Promise<StepResult> {
  const gestures = Array.isArray(step.args.gestures) ? step.args.gestures : [];
  if (gestures.length === 0)
    return { ok: false, error: "multi_drag requires gestures[]" };
  let stdout = "";
  for (const gesture of gestures) {
    if (!gesture || typeof gesture !== "object")
      return { ok: false, error: "multi_drag gesture must be an object" };
    const args = {
      ...step.args,
      ...(gesture as Record<string, unknown>),
      gestures: undefined,
    };
    const result = await runVirtualDrag(
      { ...step, tool: "drag", args },
      cuaDriver,
    );
    stdout += `${result.stdout ?? ""}\n`;
    if (!result.ok) return { ...result, stdout };
  }
  return { ok: true, stdout: stdout.trim() };
}

async function runVirtualClickHold(
  step: PlanStep,
  cuaDriver: string,
): Promise<StepResult> {
  const pid = asFiniteNumber(step.args.pid);
  const windowId = asFiniteNumber(step.args.window_id);
  const x = asFiniteNumber(step.args.x);
  const y = asFiniteNumber(step.args.y);
  if (pid === null || windowId === null || x === null || y === null) {
    return { ok: false, error: "click_hold requires pid, window_id, x, y" };
  }
  return await runVirtualDrag(
    {
      ...step,
      tool: "drag",
      args: {
        ...step.args,
        from: { x, y },
        to: { x, y },
        duration_ms: asFiniteNumber(step.args.hold_ms) ?? 450,
      },
    },
    cuaDriver,
  );
}

async function runVirtualPasteSvg(
  step: PlanStep,
  cuaDriver: string,
): Promise<StepResult> {
  const pid = asFiniteNumber(step.args.pid);
  const windowId = asFiniteNumber(step.args.window_id);
  const replaceExisting = step.args.replace_existing === true;
  const svg = typeof step.args.svg === "string" ? step.args.svg.trim() : "";
  if (pid === null || !svg) {
    return {
      ok: false,
      error: "paste_svg requires pid and non-empty svg",
    };
  }
  if (!/^<svg[\s>]/i.test(svg)) {
    return {
      ok: false,
      error: "paste_svg svg must start with an <svg> element",
    };
  }

  const swift = `
import AppKit
import Foundation

let encoded = CommandLine.arguments[1]
guard let data = Data(base64Encoded: encoded),
      let svg = String(data: data, encoding: .utf8) else {
  FileHandle.standardError.write(Data("invalid base64 SVG\\n".utf8))
  exit(2)
}

let tempURL = URL(fileURLWithPath: NSTemporaryDirectory())
  .appendingPathComponent("showme-\(UUID().uuidString).svg")
try? svg.write(to: tempURL, atomically: true, encoding: .utf8)

let pasteboard = NSPasteboard.general
pasteboard.clearContents()
let svgType = NSPasteboard.PasteboardType("public.svg-image")
let mimeSvgType = NSPasteboard.PasteboardType("image/svg+xml")
let adobeSvgType = NSPasteboard.PasteboardType("com.adobe.svg")
let fileUrlType = NSPasteboard.PasteboardType.fileURL
let filenamesType = NSPasteboard.PasteboardType("NSFilenamesPboardType")
var types: [NSPasteboard.PasteboardType] = [svgType, mimeSvgType, adobeSvgType, .string, fileUrlType, filenamesType]
if NSImage(data: data)?.tiffRepresentation != nil {
  types.append(.tiff)
}
pasteboard.declareTypes(types, owner: nil)
pasteboard.setData(Data(svg.utf8), forType: svgType)
pasteboard.setData(Data(svg.utf8), forType: mimeSvgType)
pasteboard.setData(Data(svg.utf8), forType: adobeSvgType)
pasteboard.setString(svg, forType: .string)
pasteboard.setString(tempURL.absoluteString, forType: fileUrlType)
pasteboard.setPropertyList([tempURL.path], forType: filenamesType)
if let tiff = NSImage(data: data)?.tiffRepresentation {
  pasteboard.setData(tiff, forType: .tiff)
}
`;

  const encodedSvg = Buffer.from(svg, "utf8").toString("base64");
  const pasteboardProc = Bun.spawn(["swift", "-e", swift, encodedSvg], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const pasteboardResult = await collectProcess(pasteboardProc);
  if (pasteboardResult.timedOut) {
    return {
      ok: false,
      error: "paste_svg pasteboard setup timed out",
      stdout: pasteboardResult.stdout,
    };
  }
  if (pasteboardResult.exitCode !== 0) {
    return {
      ok: false,
      error: `paste_svg pasteboard setup exited ${pasteboardResult.exitCode}: ${pasteboardResult.stderr.trim() || pasteboardResult.stdout.trim()}`,
      stdout: pasteboardResult.stdout,
    };
  }

  if (windowId !== null) {
    const focusResult = await focusWindowCenter(cuaDriver, pid, windowId);
    if (!focusResult.ok) return focusResult;
  }

  if (replaceExisting) {
    for (const keys of [["meta", "a"], ["delete"]]) {
      const clearResult = await runDriverHotkey(cuaDriver, pid, keys);
      if (!clearResult.ok) return clearResult;
    }
  }

  const hotkeyResult = await runDriverHotkey(cuaDriver, pid, ["meta", "v"]);
  if (!hotkeyResult.ok) return hotkeyResult;

  return {
    ok: true,
    stdout: `✅ Pasted SVG (${svg.length} chars).`,
  };
}

async function runDriverHotkey(
  cuaDriver: string,
  pid: number,
  keys: string[],
): Promise<StepResult> {
  const tool = keys.length === 1 ? "press_key" : "hotkey";
  const args = keys.length === 1 ? { pid, key: keys[0] } : { pid, keys };
  const proc = Bun.spawn([cuaDriver, "call", tool, JSON.stringify(args)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const hotkeyResult = await collectProcess(proc);
  if (hotkeyResult.timedOut) {
    return { ok: false, error: `paste_svg ${tool} timed out` };
  }
  if (hotkeyResult.exitCode !== 0) {
    return {
      ok: false,
      error: `paste_svg ${tool} exited ${hotkeyResult.exitCode}: ${hotkeyResult.stderr.trim() || hotkeyResult.stdout.trim()}`,
      stdout: hotkeyResult.stdout,
    };
  }
  return { ok: true, stdout: hotkeyResult.stdout };
}

async function focusWindowCenter(
  cuaDriver: string,
  pid: number,
  windowId: number,
): Promise<StepResult> {
  const boundsResult = await getWindowBounds(cuaDriver, pid, windowId);
  if (!boundsResult.ok || !("bounds" in boundsResult)) return boundsResult;
  const { bounds } = boundsResult;
  const x = Math.round(bounds.x + bounds.width / 2);
  const y = Math.round(bounds.y + bounds.height / 2);
  const proc = Bun.spawn(
    [
      cuaDriver,
      "call",
      "click",
      JSON.stringify({ pid, window_id: windowId, x, y }),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const result = await collectProcess(proc);
  if (result.timedOut) {
    return { ok: false, error: "paste_svg focus click timed out" };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: `paste_svg focus click exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      stdout: result.stdout,
    };
  }
  return { ok: true, stdout: result.stdout };
}

const defaultStepRunner: StepRunner = async (step) => {
  return await runCuaDriverStep(step);
};

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function runVirtualDrag(
  step: PlanStep,
  cuaDriver: string,
): Promise<StepResult> {
  const args = normalizeDragArgs(step.args);
  if (!args)
    return {
      ok: false,
      error:
        "drag requires pid, window_id, and either from/to points or start_x/start_y/end_x/end_y",
    };

  const boundsResult = await getWindowBounds(
    cuaDriver,
    args.pid,
    args.windowId,
  );
  if (!boundsResult.ok || !("bounds" in boundsResult)) return boundsResult;
  const { bounds } = boundsResult;

  const scaleX = args.screenshotWidth ? bounds.width / args.screenshotWidth : 1;
  const scaleY = args.screenshotHeight
    ? bounds.height / args.screenshotHeight
    : 1;
  const startX = bounds.x + args.from.x * scaleX;
  const startY = bounds.y + args.from.y * scaleY;
  const endX = bounds.x + args.to.x * scaleX;
  const endY = bounds.y + args.to.y * scaleY;

  const swift = `
import CoreGraphics
import Foundation

let sx = Double(CommandLine.arguments[1])!
let sy = Double(CommandLine.arguments[2])!
let ex = Double(CommandLine.arguments[3])!
let ey = Double(CommandLine.arguments[4])!
let durationMs = max(0.0, Double(CommandLine.arguments[5])!)
let steps = max(1, Int(CommandLine.arguments[6])!)
let targetPid = pid_t(Int32(CommandLine.arguments[7])!)
let modifiers = CommandLine.arguments.dropFirst(8).map { $0.lowercased() }

func keyCode(_ modifier: String) -> CGKeyCode? {
  switch modifier {
  case "shift": return 56
  case "control", "ctrl": return 59
  case "option", "alt": return 58
  case "command", "cmd", "meta": return 55
  default: return nil
  }
}

func postKey(_ keyCode: CGKeyCode, down: Bool) {
  let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down)!
  event.postToPid(targetPid)
}

func post(_ type: CGEventType, _ x: Double, _ y: Double) {
  let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)!
  event.postToPid(targetPid)
}

let keyCodes = modifiers.compactMap { keyCode($0) }
for code in keyCodes { postKey(code, down: true) }
post(.leftMouseDown, sx, sy)
for i in 1...steps {
  let t = Double(i) / Double(steps)
  let x = sx + (ex - sx) * t
  let y = sy + (ey - sy) * t
  post(.leftMouseDragged, x, y)
  if durationMs > 0 {
    usleep(useconds_t((durationMs / Double(steps)) * 1000.0))
  }
}
post(.leftMouseUp, ex, ey)
for code in keyCodes.reversed() { postKey(code, down: false) }
`;
  const proc = Bun.spawn(
    [
      "swift",
      "-e",
      swift,
      String(startX),
      String(startY),
      String(endX),
      String(endY),
      String(args.durationMs),
      String(args.steps),
      String(args.pid),
      ...args.modifiers,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const { exitCode, stdout, stderr, timedOut } = await collectProcess(proc);
  if (timedOut) {
    return { ok: false, error: "drag timed out", stdout };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      error: `drag exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
      stdout,
    };
  }
  return {
    ok: true,
    stdout: `✅ Dragged from (${Math.round(startX)}, ${Math.round(startY)}) to (${Math.round(endX)}, ${Math.round(endY)}).`,
  };
}

function normalizeDragArgs(args: Record<string, unknown>): {
  pid: number;
  windowId: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  durationMs: number;
  steps: number;
  screenshotWidth?: number;
  screenshotHeight?: number;
  modifiers: string[];
} | null {
  const pid = asFiniteNumber(args.pid);
  const windowId = asFiniteNumber(args.window_id);
  const from = pointArg(args.from);
  const to = pointArg(args.to);
  const fallbackFrom =
    from ??
    pointFromNumbers(
      asFiniteNumber(args.start_x),
      asFiniteNumber(args.start_y),
    );
  const fallbackTo =
    to ??
    pointFromNumbers(asFiniteNumber(args.end_x), asFiniteNumber(args.end_y));
  if (
    pid === null ||
    windowId === null ||
    fallbackFrom === null ||
    fallbackTo === null
  )
    return null;
  return {
    pid,
    windowId,
    from: fallbackFrom,
    to: fallbackTo,
    durationMs: asFiniteNumber(args.duration_ms) ?? 350,
    steps: Math.max(1, Math.round(asFiniteNumber(args.steps) ?? 20)),
    screenshotWidth: asFiniteNumber(args.screenshot_width) ?? undefined,
    screenshotHeight: asFiniteNumber(args.screenshot_height) ?? undefined,
    modifiers: stringArrayArg(args.modifiers),
  };
}

function stringArrayArg(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function pointArg(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return pointFromNumbers(asFiniteNumber(record.x), asFiniteNumber(record.y));
}

function pointFromNumbers(
  x: number | null,
  y: number | null,
): { x: number; y: number } | null {
  return x === null || y === null ? null : { x, y };
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function getWindowBounds(
  cuaDriver: string,
  pid: number,
  windowId: number,
): Promise<{ ok: true; bounds: WindowBounds } | StepResult> {
  const proc = Bun.spawn(
    [cuaDriver, "call", "list_windows", JSON.stringify({ pid })],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const { exitCode, stdout, stderr, timedOut } = await collectProcess(proc);
  if (timedOut) {
    return { ok: false, error: "cua-driver list_windows timed out", stdout };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      error: `cua-driver list_windows exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
      stdout,
    };
  }
  try {
    const parsed = JSON.parse(stdout) as { windows?: unknown[] };
    const windows = parsed.windows ?? [];
    const match = windows
      .filter(
        (window): window is Record<string, unknown> =>
          !!window && typeof window === "object",
      )
      .find((window) => window.window_id === windowId);
    const bounds = match?.bounds as Record<string, unknown> | undefined;
    const x = asFiniteNumber(bounds?.x);
    const y = asFiniteNumber(bounds?.y);
    const width = asFiniteNumber(bounds?.width);
    const height = asFiniteNumber(bounds?.height);
    if (x === null || y === null || width === null || height === null)
      throw new Error(`window ${windowId} not found or missing bounds`);
    return { ok: true, bounds: { x, y, width, height } };
  } catch (e) {
    return {
      ok: false,
      error: `drag could not resolve window bounds: ${(e as Error).message}`,
      stdout,
    };
  }
}

async function collectProcess(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = Number(Bun.env.SHOWME_STEP_TIMEOUT_MS ?? 20_000),
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const stdoutPromise = new Response(proc.stdout as ReadableStream).text();
  const stderrPromise = new Response(proc.stderr as ReadableStream).text();
  let timedOut = false;
  let timer: Timer | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      resolve(null);
    }, timeoutMs);
  });
  await Promise.race([proc.exited, timeoutPromise]);
  if (timer) clearTimeout(timer);
  if (!timedOut) await proc.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { exitCode: proc.exitCode, stdout, stderr, timedOut };
}

async function promptYesNo(prompt: string): Promise<boolean> {
  process.stdout.write(prompt);
  const buf = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(d.toString().trim()));
  });
  return buf.toLowerCase() === "y" || buf.toLowerCase() === "yes";
}
