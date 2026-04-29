/**
 * Local executor for `openclick run --fast` plans.
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

interface DriverActionReceipt {
  ok?: boolean;
  route?: string;
  lane?: string;
  background_safe?: boolean;
  cursor_moved?: boolean;
  foreground_changed?: boolean;
  session?: string;
  reason?: string;
}

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
  /**
   * Validate the pinned pid/window_id before window-targeted actions. In
   * production this defaults on; injected test runners opt in explicitly.
   */
  revalidateWindowLease?: boolean;
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
  /** Daemon-stable cua-driver identity for the selected window, when available. */
  windowUid?: string;
  /** Title of the selected window, used as a lease fingerprint if id changes. */
  windowTitle?: string;
  /** AX role/subrole and usability metadata for the selected window lease. */
  windowRole?: string;
  windowSubrole?: string;
  windowActionable?: boolean;
  windowBounds?: { x?: number; y?: number; width?: number; height?: number };
  windowDisplayId?: number;
  /** Browser bundle/tab identity for the selected task tab, when available. */
  bundleId?: string;
  tabId?: number;
  tabUrl?: string;
  tabTitle?: string;
  browserWindowId?: number;
  browserWindowIndex?: number;
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
  /** Visible descendant labels under this addressable AX node. */
  subtreeText?: string;
  /** Roles of ancestor elements, root-first (no titles, just role chain). */
  ancestorPath: string[];
  /** 0-based line number in the source AX dump; used to find descendants. */
  lineNumber: number;
  /** Leading whitespace count in the source AX dump. */
  indent: number;
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
  "diff_windows",
  "list_browser_tabs",
  "list_apps",
  "list_windows",
  "multi_drag",
  "open_url",
  "press_key",
  "right_click",
  "screenshot",
  "scroll",
  "set_value",
  "type_text",
  "type_text_chars",
  "validate_window",
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
    reason: `${normalized} is not in openclick's background-safe tool allowlist`,
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
  title_contains?: string;
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
  // Ancestry stack: each entry is { indent, role, entry? }. Indent is the
  // leading whitespace length; deeper lines get the stack snapshot as their
  // path, and descendant labels can be attached to addressable parents.
  const stack: Array<{ indent: number; role: string; entry?: AxIndexEntry }> =
    [];
  // (role|title) → count, for ordinal assignment.
  const ordinalCounter = new Map<string, number>();

  for (const [lineNumber, rawLine] of stdout.split("\n").entries()) {
    const m = lineRe.exec(rawLine);
    if (!m) continue;
    const indent = (m[1] ?? "").length;
    const indexStr = m[2];
    const role = m[3] ?? "";
    const title =
      (m[4] ?? m[5] ?? rawLine.match(/\s=\s"([^"]+)"/)?.[1])?.trim() ||
      undefined;
    const id = m[6]?.trim() || undefined;

    // Pop the stack until we're at a strictly-greater indent than the last
    // ancestor — that's our parent.
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent)
      stack.pop();
    const ancestorPath = stack.map((s) => s.role);
    if (title) appendSubtreeText(stack, title);

    let entry: AxIndexEntry | undefined;
    if (indexStr !== undefined) {
      const index = Number.parseInt(indexStr, 10);
      if (Number.isFinite(index)) {
        const ordKey = `${role.toLowerCase()}|${(title ?? "").toLowerCase()}`;
        const ordinal = ordinalCounter.get(ordKey) ?? 0;
        ordinalCounter.set(ordKey, ordinal + 1);
        entry = {
          index,
          role,
          id,
          title,
          ancestorPath,
          lineNumber,
          indent,
          ordinal,
        };
        entries.push(entry);
      }
    }

    // Whether or not the line is addressable, push onto the stack so deeper
    // children see this role as part of their ancestor path.
    stack.push({ indent, role, entry });
  }
  return entries;
}

function appendSubtreeText(
  stack: Array<{ entry?: AxIndexEntry }>,
  text: string,
): void {
  const cleaned = text.trim();
  if (!cleaned) return;
  for (const frame of stack) {
    if (!frame.entry) continue;
    frame.entry.subtreeText = appendUniqueLine(
      frame.entry.subtreeText,
      cleaned,
    );
  }
}

function appendUniqueLine(existing: string | undefined, line: string): string {
  if (!existing) return line;
  const lower = line.toLowerCase();
  if (existing.split("\n").some((value) => value.toLowerCase() === lower)) {
    return existing;
  }
  return `${existing}\n${line}`;
}

/**
 * Resolve a {@link PlanSelector} against the current AX index. Returns the
 * matching `element_index`, or null when ambiguous / not found.
 *
 * Resolution rules:
 *   - ax_id present → match unique entry by id (case-insensitive).
 *   - title/title_contains + role → match all by both, apply ordinal
 *                                  (default 0). When multiple match without
 *                                  an ordinal, return null.
 *   - title/title_contains alone  → match by title; multiple matches without
 *                                  ordinal → null.
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
  const wantTitleContains = lower(selector.title_contains);
  const wantRole = lower(selector.role);
  let matches = entries;
  if (wantTitle !== undefined)
    matches = matches.filter((e) => lower(e.title) === wantTitle);
  if (wantTitleContains !== undefined)
    matches = matches.filter((e) =>
      lower(e.title)?.includes(wantTitleContains),
    );
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
        windowUid: opts.initialContext.windowUid,
        windowTitle: opts.initialContext.windowTitle,
        windowRole: opts.initialContext.windowRole,
        windowSubrole: opts.initialContext.windowSubrole,
        windowActionable: opts.initialContext.windowActionable,
        windowBounds: opts.initialContext.windowBounds
          ? { ...opts.initialContext.windowBounds }
          : undefined,
        windowDisplayId: opts.initialContext.windowDisplayId,
        bundleId: opts.initialContext.bundleId,
        tabId: opts.initialContext.tabId,
        tabUrl: opts.initialContext.tabUrl,
        tabTitle: opts.initialContext.tabTitle,
        browserWindowId: opts.initialContext.browserWindowId,
        browserWindowIndex: opts.initialContext.browserWindowIndex,
        axIndex: opts.initialContext.axIndex,
        screenshotWidth: opts.initialContext.screenshotWidth,
        screenshotHeight: opts.initialContext.screenshotHeight,
      }
    : {};

  const refreshBeforeAxClick = opts.refreshBeforeAxClick ?? true;
  const revalidateWindowLease = opts.revalidateWindowLease ?? !opts.stepRunner;
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
      log(`[openclick] (skip assert: ${step.purpose})`);
      executed++;
      continue;
    }

    const normalizedStep = normalizePlanStep(step);
    let resolved = resolveStepForContext(normalizedStep, ctx);

    const invalidTargetError = invalidWindowTargetError(resolved);
    if (!opts.dryRun && invalidTargetError) {
      return {
        stepsExecuted: executed,
        totalSteps: plan.steps.length,
        failedStepIndex: i,
        error: invalidTargetError,
        lastContext: ctx,
      };
    }

    if (
      !opts.dryRun &&
      revalidateWindowLease &&
      shouldRevalidateWindowLease(resolved, ctx)
    ) {
      const leaseResult = await revalidateCurrentWindowLease(ctx, runner, log);
      if (!leaseResult.ok) {
        return {
          stepsExecuted: executed,
          totalSteps: plan.steps.length,
          failedStepIndex: i,
          error: leaseResult.error ?? "window lease validation failed",
          lastContext: ctx,
        };
      }
      resolved = resolveStepForContext(normalizedStep, ctx);
    }

    const leaseActionabilityError = windowLeaseActionabilityError(
      resolved,
      ctx,
    );
    if (!opts.dryRun && leaseActionabilityError) {
      return {
        stepsExecuted: executed,
        totalSteps: plan.steps.length,
        failedStepIndex: i,
        error: leaseActionabilityError,
        lastContext: ctx,
      };
    }

    // Auto-refresh: state-changing clicks rerender; element_index drifts. If
    // the upcoming step is an AX-targeted click/type and we know pid+window,
    // re-run get_window_state through the same runner before resolving the
    // selector. Skip when context isn't ready (the in-plan steps will populate
    // it normally) or when the caller opts out.
    if (
      !opts.dryRun &&
      refreshBeforeAxClick &&
      isAxTargetedStep(normalizedStep) &&
      ctx.pid !== undefined &&
      ctx.windowId !== undefined
    ) {
      const refreshStep: PlanStep = {
        tool: "get_window_state",
        args: { pid: ctx.pid, window_id: ctx.windowId, capture_mode: "ax" },
        purpose: "refresh AX index",
      };
      log("[openclick] (refresh AX index)");
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
      resolved = resolveStepForContext(normalizedStep, ctx);
    }

    // Email/message rows are too easy to miss with raw coordinates in
    // background mode: a click can post successfully while Gmail remains on the
    // inbox. For these, refresh AX and resolve to a row/link before acting.
    if (
      !opts.dryRun &&
      refreshBeforeAxClick &&
      isMessageRowCoordinateClick(resolved)
    ) {
      const pid = asFiniteNumber(resolved.args.pid) ?? ctx.pid;
      const windowId = asFiniteNumber(resolved.args.window_id) ?? ctx.windowId;
      if (pid !== undefined && windowId !== undefined) {
        const refreshStep: PlanStep = {
          tool: "get_window_state",
          args: { pid, window_id: windowId, capture_mode: "ax" },
          purpose: "refresh AX index for message row",
        };
        log("[openclick] (refresh AX index for message row)");
        const refreshResult = await runner(refreshStep);
        if (refreshResult.ok && refreshResult.stdout) {
          absorbContext(
            ctx,
            "get_window_state",
            refreshResult.stdout,
            refreshStep.args,
          );
        } else {
          ctx.axIndex = [];
        }
        resolved = resolveStepForContext(normalizedStep, ctx);
      }
    }

    log(`[openclick] about to: ${step.purpose}`);
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
        error: `foreground-required tool blocked in shared-seat background mode: ${safety.reason}. Re-run with --allow-foreground only when you are ready to let openclick control foreground/global input.`,
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
    const result = await runResolvedStep(
      resolved,
      runner,
      ctx,
      log,
      executionPolicy,
    );
    if (!result.ok) {
      return {
        stepsExecuted: executed,
        totalSteps: plan.steps.length,
        failedStepIndex: i,
        error: result.error ?? "unknown error",
        lastContext: ctx,
      };
    }
    if (executionPolicy === "background") {
      const receiptFailure = backgroundActionReceiptFailure(result.stdout);
      if (receiptFailure) {
        return {
          stepsExecuted: executed,
          totalSteps: plan.steps.length,
          failedStepIndex: i,
          error: receiptFailure,
          lastContext: ctx,
        };
      }
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

const PID_TARGETED_TOOLS = new Set([
  "get_window_state",
  "list_browser_tabs",
  "list_windows",
  "click",
  "double_click",
  "right_click",
  "drag",
  "multi_drag",
  "click_hold",
  "scroll",
  "set_value",
  "type_text",
  "type_text_chars",
  "press_key",
  "validate_window",
  "hotkey",
  "zoom",
  "paste_svg",
]);

const WINDOW_TARGETED_TOOLS = new Set([
  "get_window_state",
  "click",
  "double_click",
  "right_click",
  "drag",
  "multi_drag",
  "click_hold",
  "set_value",
  "screenshot",
  "validate_window",
  "paste_svg",
]);

const PID_WINDOW_PAIRED_TOOLS = new Set([
  "get_window_state",
  "click",
  "double_click",
  "right_click",
  "drag",
  "multi_drag",
  "click_hold",
  "scroll",
  "set_value",
  "type_text",
  "type_text_chars",
  "press_key",
  "hotkey",
  "validate_window",
  "paste_svg",
]);

const WINDOW_INPUT_TOOLS = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "multi_drag",
  "click_hold",
  "scroll",
  "set_value",
  "type_text",
  "type_text_chars",
  "press_key",
  "hotkey",
]);

const APP_DISCOVERY_ARG_KEYS = ["app_name", "app", "application", "bundle_id"];
const APP_BUNDLE_ALIASES: Record<string, string> = {
  calendar: "com.apple.iCal",
  finder: "com.apple.finder",
  mail: "com.apple.mail",
  notes: "com.apple.Notes",
  preview: "com.apple.Preview",
  reminders: "com.apple.reminders",
  safari: "com.apple.Safari",
  "system settings": "com.apple.SystemSettings",
  textedit: "com.apple.TextEdit",
};

function resolveStepForContext(step: PlanStep, ctx: ExecutorContext): PlanStep {
  return {
    tool: step.tool,
    args: repairArgsForContext(
      step.tool,
      substitutePlaceholders(step.args, ctx, step.purpose),
      ctx,
      step.purpose,
    ),
    purpose: step.purpose,
  };
}

function shouldRevalidateWindowLease(
  step: PlanStep,
  ctx: ExecutorContext,
): boolean {
  if (ctx.pid === undefined || ctx.windowId === undefined) return false;
  const tool = canonicalToolName(step.tool);
  if (tool === "launch_app" || tool === "list_windows" || tool === "open_url") {
    return false;
  }
  const pid = asFiniteNumber(step.args.pid);
  const windowId = asFiniteNumber(step.args.window_id);
  if (pid !== ctx.pid || windowId !== ctx.windowId) return false;
  return (
    WINDOW_TARGETED_TOOLS.has(tool) ||
    (PID_WINDOW_PAIRED_TOOLS.has(tool) && windowId !== null)
  );
}

function invalidWindowTargetError(step: PlanStep): string | undefined {
  const tool = canonicalToolName(step.tool);
  if (!WINDOW_TARGETED_TOOLS.has(tool) && !WINDOW_INPUT_TOOLS.has(tool)) {
    return undefined;
  }
  const pid = asFiniteNumber(step.args.pid);
  const windowId = asFiniteNumber(step.args.window_id);
  if (pid !== null && pid <= 0) {
    return `invalid pid ${pid} for ${tool}; refusing to call cua-driver with placeholder or active-process targeting. Discover a real pid first.`;
  }
  if (windowId !== null && windowId <= 0) {
    return `invalid window_id ${windowId} for ${tool}; refusing to call cua-driver with placeholder or active-window targeting. Discover a real window_id first.`;
  }
  if (WINDOW_TARGETED_TOOLS.has(tool) && windowId === null) {
    return `${tool} requires a concrete window_id in background mode; refusing to fall back to the active window.`;
  }
  return undefined;
}

function windowLeaseActionabilityError(
  step: PlanStep,
  ctx: ExecutorContext,
): string | undefined {
  const tool = canonicalToolName(step.tool);
  if (!WINDOW_INPUT_TOOLS.has(tool)) return undefined;
  const pid = asFiniteNumber(step.args.pid);
  const windowId = asFiniteNumber(step.args.window_id);
  if (
    pid !== ctx.pid ||
    windowId !== ctx.windowId ||
    ctx.windowActionable !== false
  ) {
    return undefined;
  }
  return nonActionableWindowError(ctx, "refusing to send input");
}

async function revalidateCurrentWindowLease(
  ctx: ExecutorContext,
  runner: StepRunner,
  log: (line: string) => void,
): Promise<StepResult> {
  if (ctx.pid === undefined || ctx.windowId === undefined) return { ok: true };
  const originalWindowId = ctx.windowId;
  const validateArgs: Record<string, unknown> = {
    pid: ctx.pid,
    window_id: ctx.windowId,
  };
  if (ctx.windowUid) validateArgs.window_uid = ctx.windowUid;
  if (ctx.windowTitle) validateArgs.expected_title = ctx.windowTitle;

  const validateResult = await runner({
    tool: "validate_window",
    args: validateArgs,
    purpose: "validate current window lease",
  });
  if (validateResult.ok && validateResult.stdout) {
    const payload = parseValidateWindowPayload(validateResult.stdout);
    if (payload) {
      if (payload.status === "present") {
        if (payload.window) {
          rememberWindow(ctx, payload.window);
          if (isActionableWindowRecord(payload.window)) return { ok: true };
        }
        const replacement = findValidateWindowReplacement(payload);
        if (replacement) {
          rememberWindow(ctx, replacement);
          log(
            `[openclick] (window lease: reacquired non-actionable window ${originalWindowId} -> ${ctx.windowId})`,
          );
          return { ok: true };
        }
        return {
          ok: false,
          error: nonActionableWindowError(
            ctx,
            `window lease ${originalWindowId} is present but not actionable`,
          ),
        };
      }
      const replacement = findValidateWindowReplacement(payload);
      if (replacement) {
        rememberWindow(ctx, replacement);
        log(
          `[openclick] (window lease: reacquired window ${originalWindowId} -> ${ctx.windowId})`,
        );
        return { ok: true };
      }
      const title = ctx.windowTitle ? ` titled "${ctx.windowTitle}"` : "";
      return {
        ok: false,
        error: `window lease lost: window_id ${originalWindowId}${title} is no longer present and no unambiguous replacement was found. Refusing to switch to another window silently.`,
      };
    }
  }

  const result = await runner({
    tool: "list_windows",
    args: { pid: ctx.pid },
    purpose: "validate current window lease",
  });
  if (!result.ok || !result.stdout) {
    return {
      ok: false,
      error: `window lease validation unavailable for pid ${ctx.pid} window_id ${originalWindowId}; refusing to send input without a verified target window.`,
    };
  }
  const windows = parseWindowsPayload(result.stdout);
  if (!windows) {
    return {
      ok: false,
      error: `window lease validation returned unparsable windows for pid ${ctx.pid} window_id ${originalWindowId}; refusing to send input without a verified target window.`,
    };
  }
  const exact = findWindowById(windows, originalWindowId);
  if (exact) {
    const previousTitle = ctx.windowTitle;
    rememberWindow(ctx, exact);
    if (isActionableWindowRecord(exact)) return { ok: true };
    const replacement = findWindowLeaseReplacement(windows, {
      ...ctx,
      windowTitle: previousTitle ?? ctx.windowTitle,
    });
    if (replacement) {
      rememberWindow(ctx, replacement);
      log(
        `[openclick] (window lease: reacquired non-actionable window ${originalWindowId} -> ${ctx.windowId})`,
      );
      return { ok: true };
    }
    return {
      ok: false,
      error: nonActionableWindowError(
        ctx,
        `window lease ${originalWindowId} is present but not actionable`,
      ),
    };
  }

  const replacement = findWindowLeaseReplacement(windows, ctx);
  if (replacement) {
    rememberWindow(ctx, replacement);
    log(
      `[openclick] (window lease: reacquired window ${originalWindowId} -> ${ctx.windowId})`,
    );
    return { ok: true };
  }

  const title = ctx.windowTitle ? ` titled "${ctx.windowTitle}"` : "";
  return {
    ok: false,
    error: `window lease lost: window_id ${originalWindowId}${title} is no longer present and no unambiguous replacement was found. Refusing to switch to another window silently.`,
  };
}

async function runResolvedStep(
  step: PlanStep,
  runner: StepRunner,
  ctx: ExecutorContext,
  log: (line: string) => void,
  executionPolicy: ExecutionPolicy,
): Promise<StepResult> {
  const buttonStep = keyboardStepToButtonClick(step, ctx);
  if (buttonStep) return await runner(buttonStep);

  const rowClickStep = rowCoordinateClickToAxClick(step, ctx);
  if (rowClickStep) {
    log("[openclick] (row click fallback: using AX row/link)");
    return await runner(rowClickStep);
  }
  if (isMessageRowCoordinateClick(step) || isUntargetedMessageRowClick(step)) {
    return {
      ok: false,
      error:
        "message row click did not resolve to a concrete AX row/link; refusing blind click",
    };
  }

  const keyFallbackStep = untargetedClickToKeyStep(step, ctx);
  if (keyFallbackStep) {
    log("[openclick] (untargeted click fallback: sending key)");
    return await runner(keyFallbackStep);
  }
  if (isUntargetedClick(step)) {
    return {
      ok: false,
      error: `untargeted ${step.tool} blocked before cua-driver call: provide element_index, coordinates, or a recognizable press/click purpose`,
    };
  }

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

  log("[openclick] (type_text fallback: sending key sequence)");
  let stdout = "";
  const windowId =
    typeof step.args.window_id === "number"
      ? step.args.window_id
      : ctx.windowId;
  for (const keyStep of textToKeySteps(
    step.args.pid,
    text,
    step.purpose,
    windowId,
  )) {
    const result = await runner(keyStep);
    stdout += result.stdout ?? "";
    if (!result.ok) return { ...result, stdout };
    if (executionPolicy === "background") {
      const receiptFailure = backgroundActionReceiptFailure(result.stdout);
      if (receiptFailure) return { ok: false, error: receiptFailure, stdout };
    }
  }
  return { ok: true, stdout };
}

function backgroundActionReceiptFailure(stdout?: string): string | undefined {
  const receipt = parseActionReceipt(stdout);
  if (!receipt) return undefined;
  if (isCursorOnlyLeasedWindowReceipt(receipt)) return undefined;
  const unsafe =
    receipt.ok === false ||
    receipt.background_safe === false ||
    receipt.cursor_moved === true ||
    receipt.foreground_changed === true;
  if (!unsafe) return undefined;

  const reasons = [
    receipt.reason,
    receipt.cursor_moved ? "cursor_moved" : undefined,
    receipt.foreground_changed ? "foreground_changed" : undefined,
    receipt.background_safe === false ? "background_safe=false" : undefined,
  ].filter((value): value is string => !!value);
  const route = receipt.route ?? "cua-driver action";
  const session = receipt.session ? ` (${receipt.session})` : "";
  const reason = reasons.length > 0 ? reasons.join(", ") : "unsafe action";
  return `background-safety violation from ${route}${session}: ${reason}`;
}

function isCursorOnlyLeasedWindowReceipt(
  receipt: DriverActionReceipt,
): boolean {
  return (
    receipt.cursor_moved === true &&
    receipt.foreground_changed !== true &&
    receipt.lane === "leased_window" &&
    receipt.reason?.toLowerCase() === "cursor_moved"
  );
}

function parseActionReceipt(stdout?: string): DriverActionReceipt | null {
  if (!stdout?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!isObjectRecord(parsed)) return null;
  return (
    receiptFromRecord(parsed) ??
    nestedReceipt(parsed, "receipt") ??
    nestedReceipt(parsed, "action_receipt")
  );
}

function nestedReceipt(
  record: Record<string, unknown>,
  key: string,
): DriverActionReceipt | null {
  const value = record[key];
  return isObjectRecord(value) ? receiptFromRecord(value) : null;
}

function receiptFromRecord(
  record: Record<string, unknown>,
): DriverActionReceipt | null {
  if (
    !(
      "background_safe" in record ||
      "cursor_moved" in record ||
      "foreground_changed" in record ||
      "route" in record ||
      "lane" in record
    )
  ) {
    return null;
  }
  return {
    ok: typeof record.ok === "boolean" ? record.ok : undefined,
    route: typeof record.route === "string" ? record.route : undefined,
    lane: typeof record.lane === "string" ? record.lane : undefined,
    background_safe:
      typeof record.background_safe === "boolean"
        ? record.background_safe
        : undefined,
    cursor_moved:
      typeof record.cursor_moved === "boolean"
        ? record.cursor_moved
        : undefined,
    foreground_changed:
      typeof record.foreground_changed === "boolean"
        ? record.foreground_changed
        : undefined,
    session: typeof record.session === "string" ? record.session : undefined,
    reason: typeof record.reason === "string" ? record.reason : undefined,
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

function rowCoordinateClickToAxClick(
  step: PlanStep,
  ctx: ExecutorContext,
): PlanStep | null {
  if (
    !isMessageRowResolvableClick(step) ||
    typeof step.args.pid !== "number" ||
    !ctx.axIndex ||
    ctx.axIndex.length === 0
  ) {
    return null;
  }

  const windowId =
    typeof step.args.window_id === "number"
      ? step.args.window_id
      : ctx.windowId;
  if (windowId === undefined) return null;

  const text = [step.purpose, stringArg(step.args.expected_change)]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (!mentionsMessageRow(text)) return null;

  const rows = ctx.axIndex.filter(
    (entry) =>
      entry.role.toLowerCase() === "axrow" &&
      typeof entry.title === "string" &&
      entry.title.trim().length > 0,
  );
  if (rows.length === 0) return null;

  let candidates = rows;
  if (/\bunread\b/i.test(text)) {
    const unreadRows = rows.filter((entry) =>
      /\bunread\b/i.test(entry.title ?? ""),
    );
    if (unreadRows.length === 0) return null;
    candidates = unreadRows;
  }

  const row = bestRowForText(candidates, text);
  if (!row) return null;
  const target = firstDescendantLink(row, ctx.axIndex) ?? row;

  return {
    tool: "double_click",
    args: {
      pid: step.args.pid,
      window_id: windowId,
      element_index: target.index,
    },
    purpose: `${step.purpose} (resolved to AX row/link)`,
  };
}

function isMessageRowCoordinateClick(step: PlanStep): boolean {
  if (
    step.tool !== "click" ||
    typeof step.args.x !== "number" ||
    typeof step.args.y !== "number" ||
    step.args.element_index !== undefined ||
    step.args.__selector !== undefined ||
    step.args.__title !== undefined ||
    step.args.__ax_id !== undefined
  ) {
    return false;
  }
  const text = [step.purpose, stringArg(step.args.expected_change)]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return mentionsMessageRow(text);
}

function isUntargetedMessageRowClick(step: PlanStep): boolean {
  if (
    (step.tool !== "click" && step.tool !== "double_click") ||
    step.args.x !== undefined ||
    step.args.y !== undefined ||
    step.args.element_index !== undefined ||
    step.args.__selector !== undefined ||
    step.args.__title !== undefined ||
    step.args.__ax_id !== undefined
  ) {
    return false;
  }
  const text = [step.purpose, stringArg(step.args.expected_change)]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return mentionsMessageRow(text);
}

function isMessageRowResolvableClick(step: PlanStep): boolean {
  return (
    isMessageRowCoordinateClick(step) ||
    isUntargetedMessageRowClick(step) ||
    isGenericMessageRowSelectorClick(step)
  );
}

function isGenericMessageRowSelectorClick(step: PlanStep): boolean {
  if (
    (step.tool !== "click" && step.tool !== "double_click") ||
    step.args.x !== undefined ||
    step.args.y !== undefined ||
    step.args.element_index !== undefined
  ) {
    return false;
  }
  const selector = planSelectorFromArgs(step.args);
  if (!selector || !isGenericAxRowSelector(selector)) return false;
  const text = [step.purpose, stringArg(step.args.expected_change)]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return mentionsMessageRow(text);
}

function mentionsMessageRow(text: string): boolean {
  return /\b(unread|email|e-mail|message|inbox|conversation|thread)\b/i.test(
    text,
  );
}

function bestRowForText(
  rows: AxIndexEntry[],
  text: string,
): AxIndexEntry | undefined {
  const tokens = meaningfulRowTokens(text);
  if (tokens.length === 0) return rows[0];

  let best = rows[0];
  let bestScore = -1;
  for (const row of rows) {
    const title = row.title?.toLowerCase() ?? "";
    const score = tokens.reduce(
      (count, token) => count + (title.includes(token) ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : rows[0];
}

function meaningfulRowTokens(text: string): string[] {
  const stopwords = new Set([
    "click",
    "open",
    "read",
    "most",
    "recent",
    "latest",
    "last",
    "top",
    "first",
    "unread",
    "email",
    "mail",
    "message",
    "row",
    "conversation",
    "thread",
    "from",
    "gmail",
    "inbox",
    "the",
    "and",
    "with",
    "resolved",
    "link",
  ]);
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of text.toLowerCase().match(/[a-z0-9][a-z0-9.'-]*/g) ?? []) {
    if (token.length < 3 || stopwords.has(token) || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function firstDescendantLink(
  row: AxIndexEntry,
  entries: AxIndexEntry[],
): AxIndexEntry | undefined {
  const ordered = [...entries].sort((a, b) => a.lineNumber - b.lineNumber);
  for (const entry of ordered) {
    if (entry.lineNumber <= row.lineNumber) continue;
    if (entry.indent <= row.indent) break;
    if (entry.role.toLowerCase() === "axlink") return entry;
  }
  return undefined;
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function planSelectorFromArgs(
  args: Record<string, unknown>,
): PlanSelector | null {
  if (args.__selector && typeof args.__selector === "object") {
    return normalizeSelector(args.__selector as Record<string, unknown>);
  }
  const selector: PlanSelector = {};
  if (typeof args.__title === "string") selector.title = args.__title;
  if (typeof args.__ax_id === "string") selector.ax_id = args.__ax_id;
  if (typeof args.title === "string") selector.title = args.title;
  if (typeof args.title_contains === "string")
    selector.title_contains = args.title_contains;
  if (typeof args.ax_id === "string") selector.ax_id = args.ax_id;
  if (typeof args.role === "string") selector.role = args.role;
  if (typeof args.ordinal === "number" && Number.isInteger(args.ordinal))
    selector.ordinal = args.ordinal;
  return Object.keys(selector).length > 0 ? selector : null;
}

function isGenericAxRowSelector(selector: PlanSelector): boolean {
  return (
    selector.role?.toLowerCase() === "axrow" &&
    selector.title === undefined &&
    selector.title_contains === undefined &&
    selector.ax_id === undefined
  );
}

function axTreeTextFromWindowState(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof parsed.tree_markdown === "string") return parsed.tree_markdown;
    if (typeof parsed.treeMarkdown === "string") return parsed.treeMarkdown;
  } catch {
    // Plain text get_window_state output from older cua-driver builds.
  }
  return stdout;
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

function keyFromPurposeTarget(target: string): string | null {
  const normalized = normalizePurposeTarget(target).toLowerCase();
  if (/^\d$/.test(normalized)) return normalized;
  const aliases: Record<string, string> = {
    multiply: "*",
    multiplication: "*",
    "multiplication operator": "*",
    "multiply operator": "*",
    times: "*",
    "×": "*",
    x: "*",
    add: "+",
    addition: "+",
    "addition operator": "+",
    plus: "+",
    "plus operator": "+",
    subtract: "-",
    subtraction: "-",
    "subtraction operator": "-",
    minus: "-",
    "minus operator": "-",
    divide: "/",
    division: "/",
    "division operator": "/",
    "divide operator": "/",
    equals: "return",
    "equals operator": "return",
    equal: "return",
    return: "return",
    enter: "return",
    clear: "escape",
    "all clear": "escape",
  };
  return aliases[normalized] ?? null;
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
  windowId?: number,
): PlanStep[] {
  const steps: PlanStep[] = [];
  const targetArgs =
    windowId === undefined ? { pid } : { pid, window_id: windowId };
  for (const char of text) {
    const key = keyNameForChar(char);
    if (!key) {
      steps.push({
        tool: "type_text",
        args: { ...targetArgs, text: char },
        purpose,
      });
      continue;
    }
    steps.push(
      normalizePlanStep({
        tool: "press_key",
        args: { ...targetArgs, key },
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
  if (hasConcreteActionTarget(step.args)) return false;
  if (commandHotkeyFromPurpose(step.purpose)) return false;
  return (
    planSelectorFromArgs(step.args) !== null ||
    inferredButtonSelectorFromPurpose(step.purpose) !== null ||
    purposeLabelCandidatesFromPurpose(step.purpose).length > 0
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
  purpose = "",
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
    if (k === "title" && typeof v === "string") {
      pendingSelector = { ...(pendingSelector ?? {}), title: v };
      continue;
    }
    if (k === "title_contains" && typeof v === "string") {
      pendingSelector = { ...(pendingSelector ?? {}), title_contains: v };
      continue;
    }
    if (k === "ax_id" && typeof v === "string") {
      pendingSelector = { ...(pendingSelector ?? {}), ax_id: v };
      continue;
    }
    if (k === "role" && typeof v === "string") {
      pendingSelector = { ...(pendingSelector ?? {}), role: v };
      continue;
    }
    if (k === "ordinal" && typeof v === "number" && Number.isInteger(v)) {
      pendingSelector = { ...(pendingSelector ?? {}), ordinal: v };
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
  if (
    pendingSelector !== null &&
    isGenericAxRowSelector(pendingSelector) &&
    mentionsMessageRow(
      [purpose, stringArg(args.expected_change)]
        .filter((value): value is string => typeof value === "string")
        .join(" "),
    )
  ) {
    // A bare AXRow + ordinal selector is fragile in Gmail-style lists: rows can
    // include category/header/layout rows, and models often mix 1-based and
    // 0-based ordinals. Keep it symbolic so the message-row resolver can rank
    // actual unread rows by visible sender/subject text.
    out.__selector = pendingSelector;
  } else if (pendingSelector !== null && ctx.axIndex) {
    const idx = resolveSelector(ctx.axIndex, pendingSelector);
    if (idx !== null) out.element_index = idx;
  }
  return out;
}

function normalizeSelector(value: Record<string, unknown>): PlanSelector {
  const selector: PlanSelector = {};
  if (typeof value.title === "string") selector.title = value.title;
  if (typeof value.title_contains === "string")
    selector.title_contains = value.title_contains;
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
  purpose = "",
): Record<string, unknown> {
  const normalizedTool = canonicalToolName(tool);
  const out = { ...args };

  if (normalizedTool === "launch_app") {
    const {
      app_name: appNameArg,
      app: appArg,
      application: applicationArg,
      ...launchArgs
    } = out;
    const appName =
      stringField(launchArgs.name) ??
      stringField(appNameArg) ??
      stringField(appArg) ??
      stringField(applicationArg);
    const aliasBundleId = appName ? appBundleAlias(appName) : undefined;
    if (aliasBundleId) {
      const { name: _ignoredName, ...argsWithoutName } = launchArgs;
      return { ...argsWithoutName, bundle_id: aliasBundleId };
    }
    if (launchArgs.bundle_id === undefined && appName) {
      launchArgs.name = appName;
    }
    return launchArgs;
  }

  if (normalizedTool === "open_url") {
    if (out.pid === undefined && ctx.pid !== undefined) out.pid = ctx.pid;
    if (out.window_id === undefined && ctx.windowId !== undefined) {
      out.window_id = ctx.windowId;
    }
    if (out.window_uid === undefined && ctx.windowUid) {
      out.window_uid = ctx.windowUid;
    }
    if (out.bundle_id === undefined && ctx.bundleId) {
      out.bundle_id = ctx.bundleId;
    }
    if (
      out.browser_window_id === undefined &&
      ctx.browserWindowId !== undefined
    ) {
      out.browser_window_id = ctx.browserWindowId;
    }
    if (out.tab_id === undefined && ctx.tabId !== undefined) {
      out.tab_id = ctx.tabId;
    }
    return out;
  }

  if (
    (PID_TARGETED_TOOLS.has(normalizedTool) ||
      WINDOW_TARGETED_TOOLS.has(normalizedTool)) &&
    ctx.pid !== undefined &&
    usesConcreteTarget(out, ctx)
  ) {
    for (const key of APP_DISCOVERY_ARG_KEYS) delete out[key];
  }

  if (
    PID_TARGETED_TOOLS.has(normalizedTool) &&
    out.pid === undefined &&
    ctx.pid !== undefined
  ) {
    out.pid = ctx.pid;
  }
  if (
    shouldFillWindowIdForTool(normalizedTool, out) &&
    out.window_id === undefined &&
    ctx.windowId !== undefined
  ) {
    out.window_id = ctx.windowId;
  }
  if (
    PID_WINDOW_PAIRED_TOOLS.has(normalizedTool) &&
    typeof out.pid === "number" &&
    typeof out.window_id === "number" &&
    ctx.pid !== undefined &&
    ctx.windowId !== undefined &&
    out.pid === ctx.pid &&
    out.window_id !== ctx.windowId
  ) {
    out.window_id = ctx.windowId;
  }
  if (
    PID_WINDOW_PAIRED_TOOLS.has(normalizedTool) &&
    typeof out.pid === "number" &&
    typeof out.window_id === "number" &&
    ctx.pid !== undefined &&
    ctx.windowId !== undefined &&
    out.window_id === ctx.windowId &&
    out.pid !== ctx.pid
  ) {
    out.pid = ctx.pid;
  }
  if (
    AX_TARGETED_TOOLS.has(normalizedTool) &&
    !hasConcreteActionTarget(out) &&
    ctx.axIndex
  ) {
    const selector = inferredButtonSelectorFromPurpose(purpose);
    if (selector) {
      const idx = resolveSelector(ctx.axIndex, selector);
      if (idx !== null) out.element_index = idx;
    }
    if (out.element_index === undefined) {
      const idx = resolveActionTargetFromPurpose(ctx.axIndex, purpose);
      if (idx !== null) out.element_index = idx;
    }
  }
  return out;
}

function hasConcreteActionTarget(args: Record<string, unknown>): boolean {
  return (
    args.element_index !== undefined ||
    (typeof args.x === "number" && typeof args.y === "number")
  );
}

function inferredButtonSelectorFromPurpose(
  purpose: string,
): PlanSelector | null {
  const raw = purposeTarget(purpose);
  if (!raw) return null;
  const cleaned = normalizePurposeTarget(raw);
  if (!cleaned || cleaned.length > 24) return null;
  const keyAlias = keyFromPurposeTarget(cleaned);
  const candidates = buttonCandidatesForKey(keyAlias ?? cleaned);
  const title = candidates[0] ?? cleaned;
  return { title, role: "AXButton" };
}

function resolveActionTargetFromPurpose(
  entries: AxIndexEntry[],
  purpose: string,
): number | null {
  for (const label of purposeLabelCandidatesFromPurpose(purpose)) {
    const idx = resolveActionTargetByLabel(entries, label, purpose);
    if (idx !== null) return idx;
  }
  return null;
}

function resolveActionTargetByLabel(
  entries: AxIndexEntry[],
  label: string,
  purpose: string,
): number | null {
  const wanted = label.trim().toLowerCase();
  if (!wanted) return null;
  const scored = entries
    .map((entry) => {
      const title = entry.title?.trim().toLowerCase();
      const titleMatch = title === wanted;
      const subtreeMatch = subtreeTextHasExactLine(entry.subtreeText, wanted);
      if (!titleMatch && !subtreeMatch) return null;
      let score = titleMatch ? 1_000 : 0;
      if (subtreeMatch) score += 700;
      score += roleActionScore(entry.role);
      if (
        /\b(sidebar|outline)\b/i.test(purpose) &&
        entry.ancestorPath.some((role) => role.toLowerCase() === "axoutline")
      ) {
        score += 200;
      }
      score += Math.min(entry.indent, 60);
      return { entry, score };
    })
    .filter(
      (value): value is { entry: AxIndexEntry; score: number } =>
        value !== null,
    )
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return null;
  if (scored[1]?.score === best.score) return null;
  return best.entry.index;
}

function subtreeTextHasExactLine(
  subtreeText: string | undefined,
  wanted: string,
): boolean {
  return (
    subtreeText
      ?.split("\n")
      .some((line) => line.trim().toLowerCase() === wanted) ?? false
  );
}

function roleActionScore(role: string): number {
  const normalized = role.toLowerCase();
  const scores: Record<string, number> = {
    axbutton: 90,
    axlink: 90,
    axcell: 80,
    axmenuitem: 75,
    axcheckbox: 75,
    axradiobutton: 75,
    axrow: 65,
    axtextfield: 45,
    axstatictext: 10,
  };
  return scores[normalized] ?? 25;
}

function purposeLabelCandidatesFromPurpose(purpose: string): string[] {
  const raw = purposeTarget(purpose);
  return raw ? purposeLabelCandidates(raw) : [];
}

function purposeLabelCandidates(raw: string): string[] {
  const normalized = normalizePurposeTarget(raw);
  const candidates = new Set<string>();
  addPurposeCandidate(candidates, normalized);
  addPurposeCandidate(
    candidates,
    normalized.replace(
      /\s+(?:in|inside|within|on|from|under|via|using)\s+(?:the\s+)?.+$/i,
      "",
    ),
  );
  for (const value of [...candidates]) {
    addPurposeCandidate(
      candidates,
      value.replace(
        /\s+(?:folder|item|row|link|field|option|tab|control|operator)$/i,
        "",
      ),
    );
  }
  return [...candidates];
}

function addPurposeCandidate(candidates: Set<string>, value: string): void {
  const cleaned = value.trim();
  if (!cleaned) return;
  const tokenCount = cleaned.split(/\s+/).length;
  if (cleaned.length > 40 || tokenCount > 5) return;
  candidates.add(cleaned);
}

function untargetedClickToKeyStep(
  step: PlanStep,
  ctx: ExecutorContext,
): PlanStep | null {
  if (
    step.tool !== "click" &&
    step.tool !== "double_click" &&
    step.tool !== "right_click"
  ) {
    return null;
  }
  if (hasConcreteActionTarget(step.args)) return null;
  const commandHotkey = commandHotkeyFromPurpose(step.purpose);
  if (commandHotkey) {
    const pid = asFiniteNumber(step.args.pid) ?? ctx.pid;
    if (pid === undefined) return null;
    const windowId = asFiniteNumber(step.args.window_id) ?? ctx.windowId;
    const args =
      windowId === undefined
        ? { pid, keys: commandHotkey }
        : { pid, window_id: windowId, keys: commandHotkey };
    return { tool: "hotkey", args, purpose: step.purpose };
  }
  const raw = purposeTarget(step.purpose);
  if (!raw) return null;
  const key = keyFromPurposeTarget(raw);
  if (!key) return null;
  const pid = asFiniteNumber(step.args.pid) ?? ctx.pid;
  if (pid === undefined) return null;
  const windowId = asFiniteNumber(step.args.window_id) ?? ctx.windowId;
  const args =
    windowId === undefined ? { pid, key } : { pid, window_id: windowId, key };
  return normalizePlanStep({ tool: "press_key", args, purpose: step.purpose });
}

function commandHotkeyFromPurpose(purpose: string): string[] | null {
  return (
    commandHotkeyFromPurposeTarget(purpose) ??
    (purposeTarget(purpose)
      ? commandHotkeyFromPurposeTarget(purposeTarget(purpose) ?? "")
      : null)
  );
}

function commandHotkeyFromPurposeTarget(target: string): string[] | null {
  const normalized = normalizePurposeTarget(target).toLowerCase();
  const aliases: Record<string, string[]> = {
    copy: ["cmd", "c"],
    "copy selection": ["cmd", "c"],
    "copy selected text": ["cmd", "c"],
    "copy selected item": ["cmd", "c"],
    paste: ["cmd", "v"],
    "paste text": ["cmd", "v"],
    "paste copied text": ["cmd", "v"],
    cut: ["cmd", "x"],
    "cut selection": ["cmd", "x"],
    "select all": ["cmd", "a"],
    "select all text": ["cmd", "a"],
    "select everything": ["cmd", "a"],
    find: ["cmd", "f"],
    search: ["cmd", "f"],
    "find text": ["cmd", "f"],
    "search text": ["cmd", "f"],
    undo: ["cmd", "z"],
    redo: ["cmd", "shift", "z"],
    save: ["cmd", "s"],
  };
  return aliases[normalized] ?? null;
}

function isUntargetedClick(step: PlanStep): boolean {
  return (
    (step.tool === "click" ||
      step.tool === "double_click" ||
      step.tool === "right_click") &&
    !hasConcreteActionTarget(step.args)
  );
}

function purposeTarget(purpose: string): string | null {
  const match = purpose.match(
    /^\s*(?:press|click|tap|select|activate)\s+(.+?)\s*$/i,
  );
  return match?.[1]?.trim() || null;
}

function normalizePurposeTarget(target: string): string {
  return target
    .replace(/^the\s+/i, "")
    .replace(/^(digit|number)\s+/i, "")
    .replace(/\s+to\s+.+$/i, "")
    .replace(/\s*\(.+?\)\s*$/i, "")
    .replace(/\s+(button|key)$/i, "")
    .trim();
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function appBundleAlias(name: string): string | undefined {
  return APP_BUNDLE_ALIASES[name.trim().toLowerCase()];
}

function shouldFillWindowIdForTool(
  tool: string,
  args: Record<string, unknown>,
): boolean {
  if (WINDOW_TARGETED_TOOLS.has(tool)) return true;
  if (
    tool === "hotkey" ||
    tool === "press_key" ||
    tool === "type_text" ||
    tool === "type_text_chars"
  ) {
    return true;
  }
  return (
    (tool === "scroll" || tool === "type_text") &&
    args.element_index !== undefined
  );
}

function usesConcreteTarget(
  args: Record<string, unknown>,
  ctx: ExecutorContext,
): boolean {
  return (
    args.pid !== undefined ||
    args.window_id !== undefined ||
    ctx.pid !== undefined ||
    ctx.windowId !== undefined
  );
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
    tool !== "open_url" &&
    tool !== "list_windows" &&
    tool !== "get_window_state"
  )
    return;

  // get_window_state may be human-readable text or structured JSON containing
  // tree_markdown. Parse the bracketed [N] AXRole entries from either shape to
  // rebuild the structured AX index.
  if (tool === "get_window_state") {
    const entries = parseAxTreeIndex(axTreeTextFromWindowState(stdout));
    ctx.axIndex = entries;
  }

  const anchoredPid = ctx.pid;
  const anchoredWindowId = ctx.windowId;

  if (tool !== "list_windows") {
    if (typeof args.pid === "number") ctx.pid = args.pid;
    if (typeof args.window_id === "number") ctx.windowId = args.window_id;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.pid === "number" && tool !== "list_windows") ctx.pid = obj.pid;
  if (typeof obj.bundle_id === "string" && obj.bundle_id.trim()) {
    ctx.bundleId = obj.bundle_id.trim();
  }
  if (typeof obj.tab_id === "number") ctx.tabId = obj.tab_id;
  if (typeof obj.tab_url === "string" && obj.tab_url.trim()) {
    ctx.tabUrl = obj.tab_url.trim();
  }
  if (typeof obj.tab_title === "string" && obj.tab_title.trim()) {
    ctx.tabTitle = obj.tab_title.trim();
  }
  if (typeof obj.browser_window_id === "number") {
    ctx.browserWindowId = obj.browser_window_id;
  }
  if (typeof obj.browser_window_index === "number") {
    ctx.browserWindowIndex = obj.browser_window_index;
  }
  const explicitWindowId =
    typeof obj.window_id === "number" ? obj.window_id : undefined;
  if (explicitWindowId !== undefined && tool !== "list_windows") {
    ctx.windowId = explicitWindowId;
  }
  if (typeof obj.window_uid === "string" && obj.window_uid.trim()) {
    ctx.windowUid = obj.window_uid.trim();
  }
  if (typeof obj.window_title === "string" && obj.window_title.trim()) {
    ctx.windowTitle = obj.window_title.trim();
  }
  if (Array.isArray(obj.windows) && obj.windows.length > 0) {
    const preferredWindowId = explicitWindowId ?? anchoredWindowId;
    const preferredLaunchUrlWindow =
      tool === "launch_app"
        ? pickWindowForLaunchUrls(obj.windows, args.urls)
        : undefined;
    const first =
      preferredLaunchUrlWindow ??
      (preferredWindowId !== undefined
        ? findWindowById(obj.windows, preferredWindowId)
        : pickUsableWindow(obj.windows));
    if (tool === "list_windows" && preferredWindowId !== undefined && !first) {
      const replacement = findWindowLeaseReplacement(obj.windows, ctx);
      if (replacement) {
        rememberWindow(ctx, replacement);
        return;
      }
      // Do not switch away from an anchored window just because a planner
      // inspected a different pid. This prevents impossible pid/window pairs
      // such as pid=2820 + window_id owned by pid=1838, and keeps browser tabs
      // or document windows pinned to the task target.
      ctx.pid = anchoredPid;
      ctx.windowId = anchoredWindowId;
      return;
    }
    if (
      first &&
      (preferredWindowId === undefined || first.window_id === preferredWindowId)
    ) {
      rememberWindow(ctx, first);
    }
  }
}

function pickWindowForLaunchUrls(
  windows: unknown[],
  urls: unknown,
): Record<string, unknown> | undefined {
  if (!Array.isArray(urls)) return undefined;
  const wantedTitles = urls
    .map(windowTitleFromLaunchUrl)
    .filter((title): title is string => !!title);
  if (wantedTitles.length === 0) return undefined;
  const records = windowRecords(windows);
  const matches = records.filter((window) => {
    const title =
      typeof window.title === "string" ? window.title.trim().toLowerCase() : "";
    return wantedTitles.some((wanted) => title === wanted);
  });
  if (matches.length === 0) return undefined;
  return pickUsableWindow(matches);
}

function windowTitleFromLaunchUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw || /^https?:\/\//i.test(raw)) return undefined;
  let path = raw;
  if (/^file:\/\//i.test(raw)) {
    try {
      path = decodeURIComponent(new URL(raw).pathname);
    } catch {
      path = raw.replace(/^file:\/\//i, "");
    }
  }
  const withoutTrailingSlash = path.replace(/\/+$/g, "");
  const title = withoutTrailingSlash.split("/").filter(Boolean).at(-1);
  return title?.trim().toLowerCase() || undefined;
}

function rememberWindow(
  ctx: ExecutorContext,
  window: Record<string, unknown>,
): void {
  if (typeof window.pid === "number") ctx.pid = window.pid;
  if (typeof window.window_id === "number") ctx.windowId = window.window_id;
  if (typeof window.window_uid === "string" && window.window_uid.trim()) {
    ctx.windowUid = window.window_uid.trim();
  }
  if (typeof window.title === "string") {
    ctx.windowTitle = window.title.trim() || undefined;
  }
  if (typeof window.role === "string") {
    ctx.windowRole = window.role.trim() || undefined;
  }
  if (typeof window.subrole === "string") {
    ctx.windowSubrole = window.subrole.trim() || undefined;
  }
  if (typeof window.display_id === "number") {
    ctx.windowDisplayId = window.display_id;
  }
  if (isObjectRecord(window.bounds)) {
    ctx.windowBounds = {
      x: asFiniteNumber(window.bounds.x) ?? undefined,
      y: asFiniteNumber(window.bounds.y) ?? undefined,
      width: asFiniteNumber(window.bounds.width) ?? undefined,
      height: asFiniteNumber(window.bounds.height) ?? undefined,
    };
  }
  ctx.windowActionable = windowActionability(window);
}

interface ValidateWindowPayload {
  status?: string;
  reason?: string;
  window?: Record<string, unknown>;
  possibleReplacements?: Record<string, unknown>[];
}

function parseValidateWindowPayload(
  stdout: string,
): ValidateWindowPayload | null {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const payload: ValidateWindowPayload = {};
    if (typeof parsed.status === "string") payload.status = parsed.status;
    if (typeof parsed.reason === "string") payload.reason = parsed.reason;
    if (parsed.window && typeof parsed.window === "object") {
      payload.window = parsed.window as Record<string, unknown>;
    }
    if (Array.isArray(parsed.possible_replacements)) {
      payload.possibleReplacements = windowRecords(
        parsed.possible_replacements,
      );
    }
    return payload.status ? payload : null;
  } catch {
    return null;
  }
}

function findValidateWindowReplacement(
  payload: ValidateWindowPayload,
): Record<string, unknown> | undefined {
  const candidates = payload.possibleReplacements ?? [];
  const replacementPool = candidates.filter(isActionableWindowRecord);
  return replacementPool.length === 1 ? replacementPool[0] : undefined;
}

function findWindowLeaseReplacement(
  windows: unknown[],
  ctx: ExecutorContext,
): Record<string, unknown> | undefined {
  const title = ctx.windowTitle?.trim().toLowerCase();
  if (!title) return undefined;
  const matches = windowRecords(windows)
    .filter(isActionableWindowRecord)
    .filter((window) => {
      const candidateTitle =
        typeof window.title === "string"
          ? window.title.trim().toLowerCase()
          : "";
      return candidateTitle === title;
    });
  return matches.length === 1 ? matches[0] : undefined;
}

function parseWindowsPayload(stdout: string): Record<string, unknown>[] | null {
  try {
    const parsed = JSON.parse(stdout) as { windows?: unknown[] };
    return Array.isArray(parsed.windows) ? windowRecords(parsed.windows) : null;
  } catch {
    return null;
  }
}

function findWindowById(
  windows: unknown[],
  windowId: number,
): Record<string, unknown> | undefined {
  return windows.find(
    (window): window is Record<string, unknown> =>
      !!window &&
      typeof window === "object" &&
      (window as Record<string, unknown>).window_id === windowId,
  );
}

function pickUsableWindow(
  windows: unknown[],
  preferredWindowId?: number,
): Record<string, unknown> | undefined {
  const records = windows.filter(
    (window): window is Record<string, unknown> =>
      !!window && typeof window === "object",
  );
  if (preferredWindowId !== undefined) {
    const preferred = records.find(
      (window) =>
        window.window_id === preferredWindowId &&
        isActionableWindowRecord(window),
    );
    if (preferred) return preferred;
  }
  const actionable = records.filter(isActionableWindowRecord);
  const usable = records.filter(isUsableWindowRecord);
  const candidates =
    actionable.length > 0 ? actionable : usable.length > 0 ? usable : records;
  return candidates.sort(
    (a, b) => windowRecordScore(b) - windowRecordScore(a),
  )[0];
}

function isActionableWindowRecord(window: Record<string, unknown>): boolean {
  return windowActionability(window) === true;
}

function windowActionability(
  window: Record<string, unknown>,
): boolean | undefined {
  const bounds = window.bounds as Record<string, unknown> | undefined;
  const width = asFiniteNumber(bounds?.width);
  const height = asFiniteNumber(bounds?.height);
  if (width === null || height === null) return undefined;
  if (width < 100 || height < 80) return false;
  const role = typeof window.role === "string" ? window.role.toLowerCase() : "";
  const subrole =
    typeof window.subrole === "string" ? window.subrole.toLowerCase() : "";
  if (role && role !== "axwindow") return false;
  if (subrole?.includes("menubar")) return false;
  if (window.is_on_screen === false && window.on_current_space === false) {
    return false;
  }
  return true;
}

function isUsableWindowRecord(window: Record<string, unknown>): boolean {
  const bounds = window.bounds as Record<string, unknown> | undefined;
  const width = Number(bounds?.width ?? 0);
  const height = Number(bounds?.height ?? 0);
  return width >= 100 && height >= 80;
}

function nonActionableWindowError(
  ctx: ExecutorContext,
  prefix: string,
): string {
  const title = ctx.windowTitle ? ` title="${ctx.windowTitle}"` : "";
  const role = ctx.windowRole ? ` role=${ctx.windowRole}` : "";
  const subrole = ctx.windowSubrole ? ` subrole=${ctx.windowSubrole}` : "";
  const bounds = ctx.windowBounds
    ? ` bounds=${ctx.windowBounds.width ?? "?"}x${ctx.windowBounds.height ?? "?"}@${ctx.windowBounds.x ?? "?"},${ctx.windowBounds.y ?? "?"}`
    : "";
  const display =
    ctx.windowDisplayId !== undefined
      ? ` display_id=${ctx.windowDisplayId}`
      : "";
  return `${prefix}: pid=${ctx.pid ?? "?"} window_id=${ctx.windowId ?? "?"}${title}${role}${subrole}${bounds}${display}. The selected surface is likely a menu/helper/hidden window, not the real app window. Refusing to send input to avoid clicks in the wrong place.`;
}

function windowRecordScore(window: Record<string, unknown>): number {
  const bounds = window.bounds as Record<string, unknown> | undefined;
  const width = Number(bounds?.width ?? 0);
  const height = Number(bounds?.height ?? 0);
  const usable = width >= 100 && height >= 80 ? 1_000_000 : -1_000_000;
  const area = Math.min(width * height, 1_000_000);
  const titleBonus =
    typeof window.title === "string" && window.title.trim() ? 100_000 : 0;
  const actionabilityBonus = isActionableWindowRecord(window) ? 8_000_000 : 0;
  const rolePenalty =
    typeof window.role === "string" && window.role !== "AXWindow"
      ? -4_000_000
      : 0;
  const visibleBonus = window.is_on_screen === false ? -2_000_000 : 2_000_000;
  const spaceBonus = window.on_current_space === false ? -2_000_000 : 2_000_000;
  const focusedBonus =
    window.is_focused === true ||
    window.focused === true ||
    window.is_key === true ||
    window.is_main === true
      ? 5_000_000
      : 0;
  const zBonus = Number(window.z_index ?? 0) * 100_000;
  return (
    usable +
    actionabilityBonus +
    rolePenalty +
    focusedBonus +
    visibleBonus +
    spaceBonus +
    zBonus +
    titleBonus +
    area
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
      error: `foreground-required tool blocked in shared-seat background mode: ${safety.reason}. Re-run with --allow-foreground only when you are ready to let openclick control foreground/global input.`,
    };
  }
  if (step.tool === "drag") return await runVirtualDrag(step, cuaDriver);
  if (step.tool === "multi_drag")
    return await runVirtualMultiDrag(step, cuaDriver);
  if (step.tool === "click_hold")
    return await runVirtualClickHold(step, cuaDriver);
  if (step.tool === "open_url") return await runOpenUrl(step, cuaDriver);
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

async function runOpenUrl(
  step: PlanStep,
  cuaDriver: string,
): Promise<StepResult> {
  const url = typeof step.args.url === "string" ? step.args.url.trim() : "";
  if (!/^https?:\/\/\S+/i.test(url)) {
    return { ok: false, error: "open_url requires an http(s) url" };
  }
  const bundleId =
    typeof step.args.bundle_id === "string" && step.args.bundle_id.trim()
      ? step.args.bundle_id.trim()
      : undefined;
  const leasedPid = asFiniteNumber(step.args.pid) ?? undefined;
  const leasedWindowId = asFiniteNumber(step.args.window_id) ?? undefined;
  const leasedWindowUid =
    typeof step.args.window_uid === "string" && step.args.window_uid.trim()
      ? step.args.window_uid.trim()
      : undefined;
  const leasedBrowserWindowId =
    asFiniteNumber(step.args.browser_window_id) ?? undefined;
  const leasedTabId = asFiniteNumber(step.args.tab_id) ?? undefined;

  let launchInfo: Record<string, unknown> = {};
  if (bundleId) {
    const launch = Bun.spawn(
      [
        cuaDriver,
        "call",
        "launch_app",
        JSON.stringify({ bundle_id: bundleId }),
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const launchResult = await collectProcess(launch);
    if (launchResult.timedOut) {
      return { ok: false, error: "open_url launch_app timed out" };
    }
    if (launchResult.exitCode !== 0) {
      return {
        ok: false,
        error: `open_url launch_app exited ${launchResult.exitCode}: ${launchResult.stderr.trim() || launchResult.stdout.trim()}`,
      };
    }
    try {
      launchInfo = JSON.parse(launchResult.stdout) as Record<string, unknown>;
    } catch {
      launchInfo = {};
    }
  }

  const pid = typeof launchInfo.pid === "number" ? launchInfo.pid : undefined;
  const targetPid = leasedPid ?? pid;
  const preOpenWindows =
    targetPid !== undefined
      ? await listWindowsForPid(cuaDriver, targetPid)
      : undefined;
  const preOpenTabs =
    targetPid !== undefined
      ? await listBrowserTabsForPid(cuaDriver, targetPid)
      : undefined;
  const hasBrowserLease =
    leasedWindowId !== undefined ||
    leasedBrowserWindowId !== undefined ||
    leasedTabId !== undefined;
  const leasedTab =
    hasBrowserLease && targetPid !== undefined && Array.isArray(preOpenTabs)
      ? findLeasedBrowserTab(preOpenTabs, {
          pid: targetPid,
          windowId: leasedWindowId,
          browserWindowId: leasedBrowserWindowId,
          tabId: leasedTabId,
        })
      : undefined;
  const targetBrowserWindowId =
    asFiniteNumber(leasedTab?.browser_window_id) ?? leasedBrowserWindowId;
  const navigatedInLeasedTab =
    bundleId !== undefined &&
    targetBrowserWindowId !== undefined &&
    supportsBrowserWindowNavigation(bundleId)
      ? await navigateExistingBrowserWindow(
          bundleId,
          targetBrowserWindowId,
          url,
        )
      : undefined;

  if (navigatedInLeasedTab?.ok === false) {
    return navigatedInLeasedTab;
  }
  if (!navigatedInLeasedTab?.ok) {
    const openArgs = ["/usr/bin/open"];
    if (bundleId) openArgs.push("-b", bundleId);
    openArgs.push(url);
    const proc = Bun.spawn(openArgs, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const { exitCode, stdout, stderr, timedOut } = await collectProcess(proc);
    if (timedOut) return { ok: false, error: "open_url timed out", stdout };
    if (exitCode !== 0) {
      return {
        ok: false,
        error: `open_url exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
        stdout,
      };
    }
  }
  let postOpenWindows: unknown[] | undefined;
  let postOpenTabs: unknown[] | undefined;
  let selectedTab: Record<string, unknown> | undefined;
  let selectedWindow: Record<string, unknown> | undefined;
  if (targetPid !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    postOpenWindows = await listWindowsForPid(cuaDriver, targetPid);
    postOpenTabs = await listBrowserTabsForPid(cuaDriver, targetPid);
    selectedTab = navigatedInLeasedTab?.ok
      ? findLeasedBrowserTab(postOpenTabs ?? [], {
          pid: targetPid,
          windowId: leasedWindowId,
          browserWindowId: targetBrowserWindowId,
          tabId: leasedTabId,
          url,
        })
      : Array.isArray(postOpenTabs)
        ? pickOpenedUrlTab(preOpenTabs ?? [], postOpenTabs, url)
        : undefined;
    const selectedTabWindowId = asFiniteNumber(selectedTab?.owning_window_id);
    if (selectedTabWindowId !== null && Array.isArray(postOpenWindows)) {
      selectedWindow = findWindowById(postOpenWindows, selectedTabWindowId);
    }
    if (
      selectedWindow === undefined &&
      leasedWindowId !== undefined &&
      Array.isArray(postOpenWindows)
    ) {
      selectedWindow = findWindowById(postOpenWindows, leasedWindowId);
    }
    selectedWindow = Array.isArray(postOpenWindows)
      ? (selectedWindow ??
        (navigatedInLeasedTab?.ok
          ? undefined
          : pickOpenedUrlWindow(preOpenWindows ?? [], postOpenWindows, url)))
      : undefined;
  }
  const selectedWindowId =
    asFiniteNumber(selectedWindow?.window_id) ??
    (navigatedInLeasedTab?.ok ? leasedWindowId : undefined) ??
    undefined;
  const selectedWindowUid =
    typeof selectedWindow?.window_uid === "string"
      ? selectedWindow.window_uid
      : navigatedInLeasedTab?.ok
        ? leasedWindowUid
        : undefined;
  return {
    ok: true,
    stdout: JSON.stringify({
      ...launchInfo,
      pid: targetPid,
      window_id: selectedWindowId,
      window_uid: selectedWindowUid,
      window_title:
        typeof selectedWindow?.title === "string"
          ? selectedWindow.title
          : undefined,
      tab_id:
        typeof selectedTab?.tab_id === "number"
          ? selectedTab.tab_id
          : undefined,
      tab_url:
        typeof selectedTab?.url === "string" ? selectedTab.url : undefined,
      tab_title:
        typeof selectedTab?.title === "string" ? selectedTab.title : undefined,
      browser_window_id:
        typeof selectedTab?.browser_window_id === "number"
          ? selectedTab.browser_window_id
          : targetBrowserWindowId !== undefined
            ? targetBrowserWindowId
            : undefined,
      browser_window_index:
        typeof selectedTab?.browser_window_index === "number"
          ? selectedTab.browser_window_index
          : undefined,
      windows: postOpenWindows,
      tabs: postOpenTabs,
      bundle_id: bundleId,
      url,
    }),
  };
}

async function listWindowsForPid(
  cuaDriver: string,
  pid: number,
): Promise<unknown[] | undefined> {
  const windows = Bun.spawn(
    [cuaDriver, "call", "list_windows", JSON.stringify({ pid })],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const result = await collectProcess(windows);
  if (result.timedOut || result.exitCode !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { windows?: unknown[] };
    return parsed.windows;
  } catch {
    return undefined;
  }
}

async function listBrowserTabsForPid(
  cuaDriver: string,
  pid: number,
): Promise<unknown[] | undefined> {
  const tabs = Bun.spawn(
    [cuaDriver, "call", "list_browser_tabs", JSON.stringify({ pid })],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const result = await collectProcess(tabs);
  if (result.timedOut || result.exitCode !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { tabs?: unknown[] };
    return parsed.tabs;
  } catch {
    return undefined;
  }
}

interface BrowserTabLease {
  pid?: number;
  windowId?: number;
  browserWindowId?: number;
  tabId?: number;
  url?: string;
}

function findLeasedBrowserTab(
  tabs: unknown[],
  lease: BrowserTabLease,
): Record<string, unknown> | undefined {
  const records = tabRecords(tabs);
  let candidates = records;
  if (lease.pid !== undefined) {
    candidates = candidates.filter(
      (tab) => asFiniteNumber(tab.pid) === lease.pid,
    );
  }
  if (lease.tabId !== undefined) {
    const matches = candidates.filter(
      (tab) => asFiniteNumber(tab.tab_id) === lease.tabId,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) candidates = matches;
  }
  if (lease.browserWindowId !== undefined) {
    const matches = candidates.filter(
      (tab) => asFiniteNumber(tab.browser_window_id) === lease.browserWindowId,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) candidates = matches;
  }
  if (lease.windowId !== undefined) {
    const matches = candidates.filter(
      (tab) => asFiniteNumber(tab.owning_window_id) === lease.windowId,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) candidates = matches;
  }
  if (lease.url !== undefined) {
    const matches = candidates.filter(
      (tab) =>
        requestedUrlMatchScore(lease.url ?? "", stringArg(tab.url) ?? "") > 0,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) candidates = matches;
  }
  return (
    candidates.find((tab) => tab.is_active === true) ??
    (candidates.length === 1 ? candidates[0] : undefined)
  );
}

function supportsBrowserWindowNavigation(bundleId: string): boolean {
  return (
    bundleId === "com.google.Chrome" ||
    bundleId === "com.brave.Browser" ||
    bundleId === "com.microsoft.edgemac"
  );
}

async function navigateExistingBrowserWindow(
  bundleId: string,
  browserWindowId: number,
  url: string,
): Promise<StepResult> {
  const script = `
tell application id "${escapeAppleScriptString(bundleId)}"
  repeat with w in windows
    if ((id of w) as text) is "${String(browserWindowId)}" then
      set URL of active tab of w to "${escapeAppleScriptString(url)}"
      return "ok"
    end if
  end repeat
  return "missing"
end tell
`;
  const proc = Bun.spawn(["/usr/bin/osascript", "-e", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = await collectProcess(proc);
  if (result.timedOut) {
    return { ok: false, error: "open_url leased browser navigation timed out" };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: `open_url leased browser navigation exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      stdout: result.stdout,
    };
  }
  if (result.stdout.trim() !== "ok") {
    return {
      ok: false,
      error: `open_url leased browser window ${browserWindowId} was not found; refusing to navigate a different browser window silently`,
      stdout: result.stdout,
    };
  }
  return { ok: true, stdout: result.stdout };
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function pickOpenedUrlTab(
  beforeTabs: unknown[],
  afterTabs: unknown[],
  url: string,
): Record<string, unknown> | undefined {
  const after = tabRecords(afterTabs);
  if (after.length === 0) return undefined;

  const beforeByKey = new Map<string, Record<string, unknown>>();
  for (const tab of tabRecords(beforeTabs)) {
    const key = browserTabKey(tab);
    if (key) beforeByKey.set(key, tab);
  }

  const tokens = urlWindowTokens(url);
  let best: Record<string, unknown> | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestHasStrongSignal = false;
  for (const tab of after) {
    const key = browserTabKey(tab);
    const before = key ? beforeByKey.get(key) : undefined;
    const { score, strong } = openUrlTabScore(tab, before, url, tokens);
    if (score > bestScore) {
      best = tab;
      bestScore = score;
      bestHasStrongSignal = strong;
    }
  }

  return bestHasStrongSignal ? best : undefined;
}

function tabRecords(tabs: unknown[]): Record<string, unknown>[] {
  return tabs.filter(
    (tab): tab is Record<string, unknown> => !!tab && typeof tab === "object",
  );
}

function browserTabKey(tab: Record<string, unknown>): string | undefined {
  const pid = asFiniteNumber(tab.pid);
  const tabId = asFiniteNumber(tab.tab_id);
  if (pid !== null && tabId !== null) return `pid:${pid}:tab:${tabId}`;
  const bundleId = typeof tab.bundle_id === "string" ? tab.bundle_id : "";
  const browserWindowId = asFiniteNumber(tab.browser_window_id);
  const tabIndex = asFiniteNumber(tab.tab_index);
  if (pid !== null && browserWindowId !== null && tabIndex !== null) {
    return `pid:${pid}:window:${browserWindowId}:tab-index:${tabIndex}`;
  }
  if (bundleId && browserWindowId !== null && tabIndex !== null) {
    return `${bundleId}:window:${browserWindowId}:tab-index:${tabIndex}`;
  }
  return undefined;
}

function openUrlTabScore(
  tab: Record<string, unknown>,
  before: Record<string, unknown> | undefined,
  requestedUrl: string,
  tokens: string[],
): { score: number; strong: boolean } {
  const tabUrl = typeof tab.url === "string" ? tab.url : "";
  const beforeUrl = typeof before?.url === "string" ? before.url : "";
  const title = typeof tab.title === "string" ? tab.title.toLowerCase() : "";
  const isNew = !before;
  const urlChanged = !!before && tabUrl !== beforeUrl;
  const becameActive =
    tab.is_active === true && before !== undefined && before.is_active !== true;
  const urlMatchScore = requestedUrlMatchScore(requestedUrl, tabUrl);
  const tokenHits = tokens.filter(
    (token) => title.includes(token) || tabUrl.toLowerCase().includes(token),
  ).length;
  let score = 0;
  if (isNew) score += 20_000_000;
  if (urlChanged) score += 14_000_000;
  if (becameActive) score += 10_000_000;
  score += urlMatchScore;
  score += tokenHits * 1_500_000;
  if (tab.is_active === true) score += 3_000_000;
  if (asFiniteNumber(tab.owning_window_id) !== null) score += 2_000_000;
  const matchesRequestedIntent = urlMatchScore > 0 || tokenHits > 0;

  return {
    score,
    strong:
      ((isNew || urlChanged || becameActive) && matchesRequestedIntent) ||
      urlMatchScore >= 12_000_000,
  };
}

function requestedUrlMatchScore(
  requestedUrl: string,
  observedUrl: string,
): number {
  try {
    const requested = new URL(requestedUrl);
    const observed = new URL(observedUrl);
    if (requested.href === observed.href) return 18_000_000;
    if (
      requested.hostname === observed.hostname &&
      normalizePath(requested.pathname) === normalizePath(observed.pathname)
    ) {
      return 14_000_000;
    }
    if (requested.hostname === observed.hostname) return 8_000_000;
    return 0;
  } catch {
    return 0;
  }
}

function normalizePath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/g, "");
  return normalized || "/";
}

export function pickOpenedUrlWindow(
  beforeWindows: unknown[],
  afterWindows: unknown[],
  url: string,
): Record<string, unknown> | undefined {
  const afterRecords = windowRecords(afterWindows);
  const after = afterRecords.filter(isUsableWindowRecord);
  const candidates = after.length > 0 ? after : afterRecords;
  if (candidates.length === 0) return undefined;
  const beforeById = new Map<number, Record<string, unknown>>();
  for (const window of windowRecords(beforeWindows)) {
    const id = asFiniteNumber(window.window_id);
    if (id !== null) beforeById.set(id, window);
  }
  const tokens = urlWindowTokens(url);
  let bestStrong: Record<string, unknown> | undefined;
  let bestStrongScore = Number.NEGATIVE_INFINITY;
  let bestWeak = candidates[0];
  let bestWeakScore = Number.NEGATIVE_INFINITY;
  for (const window of candidates) {
    const id = asFiniteNumber(window.window_id);
    const before = id === null ? undefined : beforeById.get(id);
    const delta = openUrlWindowDeltaScore(window, before, tokens, url);
    const windowScore = windowRecordScore(window);
    const tieBreak =
      Math.max(Math.min(windowScore, 10_000_000), -10_000_000) / 10_000;
    const deltaScore = delta.score + tieBreak;
    if (delta.strong && deltaScore > bestStrongScore) {
      bestStrong = window;
      bestStrongScore = deltaScore;
    }
    if (windowScore > bestWeakScore) {
      bestWeak = window;
      bestWeakScore = windowScore;
    }
  }
  return bestStrong ?? bestWeak;
}

function windowRecords(windows: unknown[]): Record<string, unknown>[] {
  return windows.filter(
    (window): window is Record<string, unknown> =>
      !!window && typeof window === "object",
  );
}

function openUrlWindowDeltaScore(
  window: Record<string, unknown>,
  before: Record<string, unknown> | undefined,
  tokens: string[],
  requestedUrl: string,
): { score: number; strong: boolean } {
  const title = typeof window.title === "string" ? window.title : "";
  let score = 0;
  const isNew = !before;
  if (isNew) score += 100_000_000;
  const beforeTitle = typeof before?.title === "string" ? before.title : "";
  const titleChanged = !!before && title.trim() !== "" && title !== beforeTitle;
  if (titleChanged) score += 80_000_000;
  const observedUrl =
    typeof window.document_url === "string"
      ? window.document_url
      : typeof window.url === "string"
        ? window.url
        : "";
  const urlMatchScore = observedUrl
    ? requestedUrlMatchScore(requestedUrl, observedUrl)
    : 0;
  score += urlMatchScore;
  const titleLower = title.toLowerCase();
  const tokenHits = tokens.filter((token) => titleLower.includes(token)).length;
  score += tokenHits * 10_000_000;
  const z = asFiniteNumber(window.z_index);
  const oldZ = asFiniteNumber(before?.z_index);
  if (z !== null && oldZ !== null && z > oldZ) {
    score += Math.min(z - oldZ, 1_000) * 1_000;
  }
  return {
    score,
    strong: isNew || titleChanged || urlMatchScore >= 8_000_000,
  };
}

function urlWindowTokens(url: string): string[] {
  try {
    const parsed = new URL(url);
    const raw = [
      ...parsed.hostname.split("."),
      ...parsed.pathname.split(/[/?#._-]+/),
    ];
    const tokens = raw
      .map((part) => part.toLowerCase())
      .filter((part) => part.length >= 3 && part !== "www" && part !== "com");
    if (parsed.hostname.endsWith("mail.google.com")) tokens.push("gmail");
    return [...new Set(tokens)];
  } catch {
    return [];
  }
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
  .appendingPathComponent("openclick-\(UUID().uuidString).svg")
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
      const clearResult = await runDriverHotkey(
        cuaDriver,
        pid,
        keys,
        windowId ?? undefined,
      );
      if (!clearResult.ok) return clearResult;
    }
  }

  const hotkeyResult = await runDriverHotkey(
    cuaDriver,
    pid,
    ["meta", "v"],
    windowId ?? undefined,
  );
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
  windowId?: number,
): Promise<StepResult> {
  const tool = keys.length === 1 ? "press_key" : "hotkey";
  const targetArgs =
    windowId === undefined ? { pid } : { pid, window_id: windowId };
  const args =
    keys.length === 1
      ? { ...targetArgs, key: keys[0] }
      : { ...targetArgs, keys };
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
  timeoutMs = Number(Bun.env.OPENCLICK_STEP_TIMEOUT_MS ?? 20_000),
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
