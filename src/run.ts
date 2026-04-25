import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type StepRunner, executePlan } from "./executor.ts";
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

  let aborted = false;
  const onSigint = (): void => {
    aborted = true;
    console.log("\n[showme] aborted by user.");
    process.exit(130);
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

  let aborted = false;
  const onSigint = (): void => {
    aborted = true;
    console.log("\n[showme] aborted by user.");
    process.exit(130);
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
    let plan: Plan = await generatePlan({
      skillMd,
      currentStateSummary: opts.userPrompt
        ? `User asked: ${opts.userPrompt}`
        : "",
      claudeClient: plannerClient,
    });
    console.log(`[showme] plan: ${plan.steps.length} step(s)`);

    let replansUsed = 0;
    while (!aborted) {
      const result = await executePlan(plan, {
        stepRunner: opts.stepRunner,
        dryRun: !opts.live,
        confirm: opts.confirm,
      });
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
