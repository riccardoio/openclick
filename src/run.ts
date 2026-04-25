import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ExecutorContext,
  type StepRunner,
  executePlan,
  parseAxTreeIndex,
} from "./executor.ts";
import {
  AnthropicPlannerClient,
  type Plan,
  type PlannerClient,
  generatePlan,
} from "./planner.ts";

export interface RunOptions {
  skillRoot: string;
  userPrompt: string;
  live: boolean;
  maxSteps: number;
  confirm?: boolean;
  /**
   * Enable cua-driver's agent cursor overlay for the duration of the run so
   * the user can SEE the cursor move + click. Off by default (faster, less
   * jarring). Restored to its previous state when the run ends.
   */
  cursor?: boolean;
  /**
   * Skip per-step LLM round-trips: ask Sonnet once for a complete plan, then
   * walk it locally. Replans on a step failure (capped at maxReplans).
   */
  fast?: boolean;
  /** Cap on automatic replans after a step failure. Default: 2. */
  maxReplans?: number;
  /** Injectable for tests. In production, leave unset to load the real SDK. */
  queryFn?: QueryFn;
  /** Injectable for tests. Toggles cua-driver's agent cursor overlay. */
  cursorToggleFn?: (enabled: boolean) => Promise<void>;
  /** Injectable for tests / production override of the Sonnet planner client. */
  plannerClient?: PlannerClient;
  /** Injectable for tests. In production, leave unset to shell out to cua-driver. */
  stepRunner?: StepRunner;
}

export type QueryFn = (input: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export async function runSkill(opts: RunOptions): Promise<void> {
  if (opts.fast) {
    await runSkillFast(opts);
    return;
  }
  await runSkillAgent(opts);
}

async function runSkillAgent(opts: RunOptions): Promise<void> {
  const skillMd = readFileSync(join(opts.skillRoot, "SKILL.md"), "utf-8");
  const systemPrompt = buildSystemPrompt(skillMd);

  if (!opts.live) {
    console.log(
      "[showme] DRY RUN — no cua-driver tools will execute. Pass --live to actually run.",
    );
  }
  console.log("[showme] press Ctrl-C to abort.");

  // Abort flag pattern: SIGINT sets the flag and lets the loop notice it.
  // The previous handler called process.exit(130) immediately, which bypassed
  // the cursor-restore + final-status logging in `finally`. Codex called this
  // out: "the silent exit path is your own process kill, not the executor loop."
  let aborted = false;
  const onSigint = (): void => {
    if (aborted) {
      // Second Ctrl-C: user is impatient, exit hard.
      console.log("\n[showme] hard-aborted (second Ctrl-C).");
      process.exit(130);
    }
    aborted = true;
    console.log(
      "\n[showme] aborting after current step finishes... (Ctrl-C again to force)",
    );
  };
  process.on("SIGINT", onSigint);

  // biome-ignore lint/suspicious/noExplicitAny: SDK hook input is an opaque object.
  const previewHook = async (input: any): Promise<Record<string, unknown>> => {
    const tool = input.tool_name ?? "<unknown>";
    const args = input.tool_input ?? {};
    const summary = summarizeToolCall(tool, args);
    console.log(`[showme] about to: ${summary}`);
    if (!opts.live) {
      // Block execution by returning a "denied" decision.
      return { decision: "block", reason: "dry-run mode" };
    }
    if (opts.confirm) {
      const ok = await promptYesNo("execute? [y/N]: ");
      if (!ok) return { decision: "block", reason: "user declined" };
    }
    return {};
  };

  const queryFn = opts.queryFn ?? (await loadRealQuery());
  const toggleCursor = opts.cursorToggleFn ?? defaultCursorToggle;

  // Enable the overlay before the agent starts so the very first cua-driver
  // tool call already animates. Only when --live (otherwise no actions fire).
  if (opts.cursor && opts.live) {
    try {
      await toggleCursor(true);
      console.log("[showme] agent cursor overlay: ON");
    } catch (e) {
      console.warn(`[showme] couldn't enable agent cursor: ${e}`);
    }
  }

  let stepCount = 0;
  try {
    for await (const message of queryFn({
      prompt: opts.userPrompt,
      options: {
        systemPrompt,
        mcpServers: { "cua-driver": { command: "cua-driver", args: ["mcp"] } },
        allowedTools: [
          "mcp__cua-driver__click",
          "mcp__cua-driver__type_text",
          "mcp__cua-driver__get_window_state",
          "mcp__cua-driver__screenshot",
          "mcp__cua-driver__press_key",
          "mcp__cua-driver__hotkey",
          "mcp__cua-driver__list_apps",
          "mcp__cua-driver__list_windows",
          "mcp__cua-driver__launch_app",
          "mcp__cua-driver__scroll",
        ],
        hooks: { PreToolUse: [{ matcher: ".*", hooks: [previewHook] }] },
        maxTurns: opts.maxSteps,
      },
    })) {
      if (aborted) break;
      // biome-ignore lint/suspicious/noExplicitAny: SDK message union not exported.
      const msg = message as any;
      if (msg.type === "tool_use") stepCount++;
      if (msg.type === "result" && "result" in msg) {
        console.log(`[showme] ${msg.result}`);
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    if (opts.cursor && opts.live) {
      try {
        await toggleCursor(false);
      } catch {
        // Best-effort restore; don't crash the run report on cleanup failure.
      }
    }
  }
  console.log(`[showme] done. ${stepCount} tool calls.`);
}

/**
 * --fast path: one Sonnet call → local plan execution → replan-on-error.
 *
 * Trades the per-step Agent SDK round-trip for a single up-front planner
 * call. For a 7-click skill that drops wall-clock from ~25-35s to ~5-10s
 * because the bulk of the budget was LLM latency.
 */
async function runSkillFast(opts: RunOptions): Promise<void> {
  const skillMd = readFileSync(join(opts.skillRoot, "SKILL.md"), "utf-8");
  if (!opts.live) {
    console.log(
      "[showme] DRY RUN — no cua-driver tools will execute. Pass --live to actually run.",
    );
  }
  console.log("[showme] press Ctrl-C to abort.");
  console.log("[showme] mode: --fast (single planner call, local executor)");

  // CRITICAL: the daemon MUST be running before any element-indexed click,
  // because the AX state cache only persists across CLI calls when those calls
  // route through the daemon. Without it, get_window_state populates a cache
  // in subprocess A, then click runs in subprocess B with an empty cache and
  // fails with "No cached AX state for pid <X>". Auto-start if needed.
  if (opts.live) {
    await ensureDaemonRunning();
  }

  // Abort flag pattern (see runSkillAgent for rationale).
  let aborted = false;
  const onSigint = (): void => {
    if (aborted) {
      console.log("\n[showme] hard-aborted (second Ctrl-C).");
      process.exit(130);
    }
    aborted = true;
    console.log(
      "\n[showme] aborting after current step finishes... (Ctrl-C again to force)",
    );
  };
  process.on("SIGINT", onSigint);

  const plannerClient =
    opts.plannerClient ?? (opts.live ? new AnthropicPlannerClient() : null);
  if (!plannerClient) {
    // Allow --fast --dry-run with no API key for tests, but with no client
    // we cannot generate a plan. In practice cli.ts always pairs --fast with
    // a real key when --live; this branch only exists to make the "no
    // network in dry-run" property explicit.
    throw new Error(
      "--fast requires either --live (real Anthropic client) or an injected plannerClient",
    );
  }
  const toggleCursor = opts.cursorToggleFn ?? defaultCursorToggle;
  const maxReplans = opts.maxReplans ?? 2;

  if (opts.cursor && opts.live) {
    try {
      await toggleCursor(true);
      console.log("[showme] agent cursor overlay: ON");
    } catch (e) {
      console.warn(`[showme] couldn't enable agent cursor: ${e}`);
    }
  }

  let totalExecuted = 0;
  try {
    // Pre-discovery: launch the target app + grab its AX tree so the planner
    // can emit grounded selectors AND so the executor's initial context is
    // already populated. Without this, Sonnet has no way to know which
    // AXButton corresponds to "1" (element_index varies per app launch and
    // is only revealed by get_window_state).
    let stateSummary = opts.userPrompt ? `User asked: ${opts.userPrompt}` : "";
    let initialContext: ExecutorContext | undefined;
    if (opts.live) {
      const discovered = await preDiscoverAppState(skillMd);
      if (discovered) {
        stateSummary = `${stateSummary}\n\n${discovered.promptText}`;
        initialContext = {
          pid: discovered.pid,
          windowId: discovered.windowId,
          axIndex: discovered.axIndex,
        };
        console.log(
          `[showme] pre-discovered app state for planner (pid=${discovered.pid}, window=${discovered.windowId}, ax-entries=${discovered.axIndex.size})`,
        );
      }
    }

    let plan: Plan = await generatePlan({
      skillMd,
      currentStateSummary: stateSummary,
      claudeClient: plannerClient,
    });
    console.log(`[showme] plan: ${plan.steps.length} step(s)`);

    // Wrap an explicit catch around the loop so any mid-loop throw surfaces
    // a clear message rather than terminating the process silently after a
    // partial trace (which is impossible to debug from the user side).
    let replansUsed = 0;
    while (!aborted) {
      let result: Awaited<ReturnType<typeof executePlan>>;
      try {
        result = await executePlan(plan, {
          stepRunner: opts.stepRunner ?? verboseStepRunner,
          dryRun: !opts.live,
          confirm: opts.confirm,
          initialContext,
        });
      } catch (e) {
        console.error(`[showme] executor crashed: ${e}`);
        throw e;
      }
      totalExecuted += result.stepsExecuted;
      if (result.error === undefined) break;
      if (replansUsed >= maxReplans) {
        console.error(
          `[showme] step ${result.failedStepIndex} failed after ${replansUsed} replan(s): ${result.error}`,
        );
        break;
      }
      replansUsed++;
      console.log(
        `[showme] step ${result.failedStepIndex} failed: ${result.error}`,
      );
      console.log(`[showme] replanning (${replansUsed}/${maxReplans})...`);
      const failedStep = plan.steps[result.failedStepIndex ?? 0];
      if (!failedStep) break;
      plan = await generatePlan({
        skillMd,
        currentStateSummary: opts.userPrompt
          ? `User asked: ${opts.userPrompt}`
          : "",
        claudeClient: plannerClient,
        replanContext: {
          failedStepIndex: result.failedStepIndex ?? 0,
          failedStep,
          errorMessage: result.error,
        },
      });
      console.log(`[showme] replan: ${plan.steps.length} step(s)`);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    if (opts.cursor && opts.live) {
      try {
        await toggleCursor(false);
      } catch {
        // Best-effort restore.
      }
    }
  }
  console.log(`[showme] done. ${totalExecuted} tool calls.`);
}

/**
 * cua-driver ships slow cinematic cursor defaults (glide=750ms + dwell=400ms)
 * so background agents are easy to glance at. For a focused replay demo the
 * user is *watching*, that animation budget dominates. We tune to a snappier
 * preset on enable. The motion settings persist in cua-driver's config, so
 * we keep these values across runs (no need to restore — they're saner than
 * the defaults for users running showme).
 */
const CURSOR_MOTION_PRESET = {
  glide_duration_ms: 250,
  dwell_after_click_ms: 80,
};

async function defaultCursorToggle(enabled: boolean): Promise<void> {
  if (enabled) {
    // Tune motion BEFORE enabling so the very first click animates with the
    // snappy preset rather than the slow defaults.
    await runCuaDriver([
      "set_agent_cursor_motion",
      JSON.stringify(CURSOR_MOTION_PRESET),
    ]);
  }
  await runCuaDriver(["set_agent_cursor_enabled", JSON.stringify({ enabled })]);
}

async function runCuaDriver(args: string[]): Promise<void> {
  const proc = Bun.spawn(["cua-driver", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(
      `cua-driver ${args[0]} exited ${proc.exitCode}: ${err.trim()}`,
    );
  }
}

/**
 * Verifies the cua-driver daemon is up. If not, launches it via LaunchServices
 * (`open -n -g -a CuaDriver --args serve`) and polls `cua-driver status` until
 * the socket appears. Throws if the daemon doesn't come up within ~6 seconds —
 * that's an environment problem the user has to fix.
 *
 * Why this matters: element-indexed clicks read an AX cache populated by
 * `get_window_state`. The cache lives in the daemon process. If the daemon
 * isn't running, each `cua-driver call` runs in-process, the cache dies with
 * each invocation, and clicks fail with "No cached AX state for pid <X>".
 */
async function ensureDaemonRunning(): Promise<void> {
  if (await isDaemonRunning()) return;
  console.log("[showme] cua-driver daemon not running; auto-starting...");
  // Fire-and-forget. `open -n -g` is non-blocking — daemon starts in the
  // background while open exits immediately.
  Bun.spawn(["open", "-n", "-g", "-a", "CuaDriver", "--args", "serve"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isDaemonRunning()) {
      console.log("[showme] daemon up");
      return;
    }
  }
  throw new Error(
    "cua-driver daemon failed to start within 6s. Try `open -n -g -a CuaDriver --args serve` manually, then re-run.",
  );
}

async function isDaemonRunning(): Promise<boolean> {
  const proc = Bun.spawn(["cua-driver", "status"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return proc.exitCode === 0;
}

/**
 * Wraps the default cua-driver subprocess runner with extra logging so we can
 * see the actual stdout / stderr per step. Currently surfaces:
 *   - exit code
 *   - first 200 chars of stdout (typically a JSON summary)
 *   - any stderr (cua-driver writes warnings + AX failure detail here)
 *
 * Without this, a step that "succeeded" per exit code but didn't actually
 * register a UI press (wrong element_index, click sent to a hidden element,
 * etc.) is invisible — cua-driver returns 0 either way.
 */
const verboseStepRunner: import("./executor.ts").StepRunner = async (step) => {
  const proc = Bun.spawn(
    ["cua-driver", "call", step.tool, JSON.stringify(step.args)],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const trim = (s: string, n = 200): string =>
    s.length <= n ? s.trim() : `${s.slice(0, n).trim()}…`;
  if (proc.exitCode !== 0) {
    console.log(
      `[showme]   ✗ cua-driver exit=${proc.exitCode} stderr=${trim(stderr)}`,
    );
    return {
      ok: false,
      error: `cua-driver ${step.tool} exited ${proc.exitCode}: ${stderr.trim() || stdout.trim()}`,
      stdout,
    };
  }
  if (stderr.trim()) {
    console.log(`[showme]   ! cua-driver stderr (non-fatal): ${trim(stderr)}`);
  }
  console.log(`[showme]   ✓ ${trim(stdout, 160)}`);
  return { ok: true, stdout };
};

async function runCuaDriverCapture(
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["cua-driver", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { ok: proc.exitCode === 0, stdout, stderr };
}

export interface DiscoveryResult {
  pid: number;
  windowId: number;
  /** Lowercased title|id → element_index map of the focused window. */
  axIndex: Map<string, number>;
  /** Pretty-printed AX tree + ids to thread into the planner prompt. */
  promptText: string;
}

/**
 * Reads SKILL.md, finds the first reverse-DNS bundle id (e.g. com.apple.calculator),
 * launches that app via cua-driver, then snapshots the focused window.
 *
 * Returns a {@link DiscoveryResult} containing the live pid + window_id, a
 * pre-built AX index map (so the executor doesn't need an in-plan
 * `get_window_state` to populate context), and a prompt-ready text block for
 * the planner. Returns null if discovery isn't possible (no bundle_id in
 * skill, cua-driver subprocess errors, etc.) — the planner then falls back to
 * placeholders and the executor will populate context via in-plan steps.
 */
async function preDiscoverAppState(
  skillMd: string,
): Promise<DiscoveryResult | null> {
  // Try the cheap path first: literal bundle id mentioned in the SKILL.md.
  let bundleId = extractBundleId(skillMd);
  if (!bundleId) {
    // Fallback: match a running/installed app's NAME against the SKILL.md.
    // The compile step doesn't always include the bundle id (Claude may write
    // "Calculator" without `com.apple.calculator`). list_apps gives us the
    // mapping we need.
    bundleId = await guessBundleIdByAppName(skillMd);
  }
  if (!bundleId) {
    console.warn(
      "[showme] no bundle_id found in SKILL.md and no app name matched a running/installed app; skipping pre-discovery",
    );
    return null;
  }

  // Launch (idempotent — returns existing pid if app already running).
  const launch = await runCuaDriverCapture([
    "call",
    "launch_app",
    JSON.stringify({ bundle_id: bundleId }),
  ]);
  if (!launch.ok) {
    console.warn(
      `[showme] launch_app(${bundleId}) failed: ${launch.stderr.trim() || "(no stderr)"}`,
    );
    return null;
  }
  let launchData: { pid?: number; windows?: Array<{ window_id?: number }> };
  try {
    launchData = JSON.parse(launch.stdout);
  } catch {
    return null;
  }
  const pid = launchData.pid;
  const windowId = launchData.windows?.[0]?.window_id;
  if (typeof pid !== "number" || typeof windowId !== "number") {
    return null;
  }

  // Snapshot the focused window for the AX tree.
  const state = await runCuaDriverCapture([
    "call",
    "get_window_state",
    JSON.stringify({ pid, window_id: windowId }),
  ]);
  if (!state.ok) return null;

  // Trim AX tree to keep the prompt small. Most useful info is in the first
  // ~12k chars (the visible toolbar + main controls).
  const axTreeTrim = state.stdout.slice(0, 12_000);
  const axIndex = parseAxTreeIndex(state.stdout);

  const promptText = [
    "Pre-discovery (already executed; the executor's context already holds pid, window_id, and the AX index — do NOT re-emit launch_app or get_window_state at the start of the plan):",
    `  bundle_id: ${bundleId}`,
    `  pid: ${pid}`,
    `  window_id: ${windowId}`,
    "",
    "AX tree of the focused window. Use the __title / __ax_id / __selector synthetic keys (NOT element_index integers) to address controls — the executor will resolve them against this tree.",
    "",
    axTreeTrim,
  ].join("\n");

  return { pid, windowId, axIndex, promptText };
}

const BUNDLE_ID_RE =
  /\b((?:com|org|io|net|app|us|edu|me|co|info)\.[a-zA-Z0-9._-]{2,})\b/;

function extractBundleId(skillMd: string): string | null {
  const m = skillMd.match(BUNDLE_ID_RE);
  return m?.[1] ?? null;
}

// `cua-driver call list_apps` line format:
//   - AppName (pid 1234) [com.example.app]   ← running
//   - AppName [com.example.app]              ← installed but not running
const APP_LINE_RE =
  /^-\s+(.+?)\s+(?:\(pid\s+\d+\)\s+)?\[([a-zA-Z0-9._-]+)\]\s*$/;

interface AppEntry {
  name: string;
  bundleId: string;
}

function parseListAppsOutput(stdout: string): AppEntry[] {
  const apps: AppEntry[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(APP_LINE_RE);
    if (m?.[1] && m[2]) apps.push({ name: m[1].trim(), bundleId: m[2] });
  }
  return apps;
}

/**
 * Given a SKILL.md and a list of apps cua-driver knows about, pick the bundle
 * id whose app NAME appears EARLIEST in the SKILL.md text. The earliest match
 * wins because compiled SKILL.md files typically name the target app in the
 * title or the first sentence (e.g. "# Calculator: 17 × 23"); other app names
 * mentioned later (Finder, Safari) are usually decoration.
 */
function pickBundleIdByEarliestMention(
  skillMd: string,
  apps: AppEntry[],
): string | null {
  const lower = skillMd.toLowerCase();
  let best: { app: AppEntry; position: number } | null = null;
  for (const app of apps) {
    const idx = lower.indexOf(app.name.toLowerCase());
    if (idx < 0) continue;
    if (best === null || idx < best.position) best = { app, position: idx };
  }
  return best?.app.bundleId ?? null;
}

async function guessBundleIdByAppName(skillMd: string): Promise<string | null> {
  const out = await runCuaDriverCapture(["call", "list_apps"]);
  if (!out.ok) return null;
  const apps = parseListAppsOutput(out.stdout);
  if (apps.length === 0) return null;
  return pickBundleIdByEarliestMention(skillMd, apps);
}

// Exported for tests.
export const _internals = {
  extractBundleId,
  parseListAppsOutput,
  pickBundleIdByEarliestMention,
};

function buildSystemPrompt(skillMd: string): string {
  return `You are an agent executing a recorded skill on the user's macOS via cua-driver.

You have access to cua-driver MCP tools: click, type_text, get_window_state, screenshot, press_key, hotkey, list_apps, list_windows, launch_app, scroll.

Before each tool call, the system will preview your intended action to the user. Be concise and intentional.

Stop when the skill's stop conditions are met OR you cannot proceed (e.g., unrecognized modal, stuck state).

SKILL:
${skillMd}`;
}

function summarizeToolCall(
  tool: string,
  args: Record<string, unknown>,
): string {
  if (tool.endsWith("click"))
    return `click element ${(args.element_index as number) ?? `${args.x},${args.y}`}`;
  if (tool.endsWith("type_text")) return `type ${JSON.stringify(args.text)}`;
  if (tool.endsWith("press_key")) return `press ${args.key}`;
  if (tool.endsWith("hotkey"))
    return `hotkey ${(args.modifiers as string[])?.join("+")}`;
  if (tool.endsWith("launch_app")) return `launch ${args.bundle_id}`;
  if (tool.endsWith("get_window_state"))
    return `snapshot window ${args.window_id}`;
  return `${tool}(${JSON.stringify(args)})`;
}

async function promptYesNo(prompt: string): Promise<boolean> {
  process.stdout.write(prompt);
  const buf = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(d.toString().trim()));
  });
  return buf.toLowerCase() === "y" || buf.toLowerCase() === "yes";
}

async function loadRealQuery(): Promise<QueryFn> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  // biome-ignore lint/suspicious/noExplicitAny: SDK input type isn't exported.
  return (input) => sdk.query(input as any) as AsyncIterable<unknown>;
}
