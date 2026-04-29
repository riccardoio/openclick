import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StepRunner } from "../src/executor.ts";
import type { PlannerClient } from "../src/planner.ts";
import {
  type QueryFn,
  buildBrowserNavigationPlan,
  buildFinderNavigationPlan,
  runSkill,
  verifyStopWhen,
} from "../src/run.ts";

let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = originalExitCode ?? 0;
});

describe("run", () => {
  test("--dry-run blocks tool execution via PreToolUse hook", async () => {
    const dir = makeFakeSkill("test1");
    const recorded: { hookCalled: boolean; decision: string | undefined } = {
      hookCalled: false,
      decision: undefined,
    };

    const fakeQuery: QueryFn = async function* (input) {
      // Simulate the SDK invoking the user-supplied PreToolUse hook for one tool call.
      // biome-ignore lint/suspicious/noExplicitAny: test fake inspects opaque options
      const hooks = (input.options as any).hooks?.PreToolUse;
      const hook = hooks?.[0]?.hooks?.[0];
      if (hook) {
        recorded.hookCalled = true;
        const result = await hook({
          tool_name: "mcp__cua-driver__click",
          tool_input: { element_index: 1 },
        });
        recorded.decision = result?.decision;
      }
      yield { type: "result", result: "done" };
    };

    await runSkill({
      taskPrompt: "do it",
      live: false,
      maxSteps: 50,
      queryFn: fakeQuery,
    });
    expect(recorded.hookCalled).toBe(true);
    expect(recorded.decision).toBe("block");
  });

  test("--live does not block (hook returns empty)", async () => {
    const dir = makeFakeSkill("test2");
    let blockedCount = 0;

    const fakeQuery: QueryFn = async function* (input) {
      // biome-ignore lint/suspicious/noExplicitAny: test fake inspects opaque options
      const hooks = (input.options as any).hooks?.PreToolUse;
      const hook = hooks?.[0]?.hooks?.[0];
      if (hook) {
        const result = await hook({
          tool_name: "mcp__cua-driver__click",
          tool_input: {},
        });
        if (result?.decision === "block") blockedCount++;
      }
      yield { type: "result", result: "done" };
    };

    await runSkill({
      taskPrompt: "do it",
      live: true,
      maxSteps: 50,
      queryFn: fakeQuery,
    });
    expect(blockedCount).toBe(0);
  });

  test("max-steps is propagated as maxTurns to the SDK", async () => {
    const dir = makeFakeSkill("test3");
    let receivedMaxTurns = -1;

    const fakeQuery: QueryFn = async function* (input) {
      // biome-ignore lint/suspicious/noExplicitAny: test fake inspects opaque options
      receivedMaxTurns = (input.options as any).maxTurns;
      yield { type: "result", result: "done" };
    };

    await runSkill({
      taskPrompt: "x",
      live: true,
      maxSteps: 7,
      queryFn: fakeQuery,
    });
    expect(receivedMaxTurns).toBe(7);
  });

  test("--cursor + --live toggles cua-driver agent cursor on, then off", async () => {
    const dir = makeFakeSkill("cursor1");
    const toggleCalls: boolean[] = [];

    const fakeQuery: QueryFn = async function* () {
      yield { type: "result", result: "done" };
    };

    await runSkill({
      taskPrompt: "x",
      live: true,
      cursor: true,
      maxSteps: 50,
      queryFn: fakeQuery,
      cursorToggleFn: async (enabled) => {
        toggleCalls.push(enabled);
      },
    });

    expect(toggleCalls).toEqual([true, false]);
  });

  test("--cursor without --live does NOT toggle the overlay (no actions to show)", async () => {
    const dir = makeFakeSkill("cursor2");
    const toggleCalls: boolean[] = [];

    const fakeQuery: QueryFn = async function* () {
      yield { type: "result", result: "done" };
    };

    await runSkill({
      taskPrompt: "x",
      live: false,
      cursor: true,
      maxSteps: 50,
      queryFn: fakeQuery,
      cursorToggleFn: async (enabled) => {
        toggleCalls.push(enabled);
      },
    });

    expect(toggleCalls).toEqual([]);
  });

  test("cursor disabled by default", async () => {
    const dir = makeFakeSkill("cursor3");
    const toggleCalls: boolean[] = [];

    const fakeQuery: QueryFn = async function* () {
      yield { type: "result", result: "done" };
    };

    await runSkill({
      taskPrompt: "x",
      live: true,
      maxSteps: 50,
      queryFn: fakeQuery,
      cursorToggleFn: async (enabled) => {
        toggleCalls.push(enabled);
      },
    });

    expect(toggleCalls).toEqual([]);
  });

  test("cursor restored to off even if the agent throws", async () => {
    const dir = makeFakeSkill("cursor4");
    const toggleCalls: boolean[] = [];

    const fakeQuery: QueryFn = async function* () {
      throw new Error("agent went sideways");
      // biome-ignore lint/correctness/noUnreachable: yield required for async generator type
      yield { type: "result", result: "never" };
    };

    await expect(
      runSkill({
        taskPrompt: "x",
        live: true,
        cursor: true,
        maxSteps: 50,
        queryFn: fakeQuery,
        cursorToggleFn: async (enabled) => {
          toggleCalls.push(enabled);
        },
      }),
    ).rejects.toThrow(/agent went sideways/);
    // Both ON and OFF should have fired even on error.
    expect(toggleCalls).toEqual([true, false]);
  });

  test("cua-driver MCP server is registered in SDK options", async () => {
    const dir = makeFakeSkill("test4");
    // biome-ignore lint/suspicious/noExplicitAny: test fake captures opaque options
    let registered: any = null;

    const fakeQuery: QueryFn = async function* (input) {
      // biome-ignore lint/suspicious/noExplicitAny: test fake inspects opaque options
      registered = (input.options as any).mcpServers;
      yield { type: "result", result: "done" };
    };

    await runSkill({
      taskPrompt: "x",
      live: true,
      maxSteps: 50,
      queryFn: fakeQuery,
    });
    expect(registered).toHaveProperty("cua-driver");
    expect(registered["cua-driver"].command).toMatch(/cua-driver$/);
    expect(registered["cua-driver"].args).toEqual(["mcp"]);
  });

  test("single Ctrl-C exits 130 after cleanup instead of reporting success", async () => {
    const dir = makeFakeSkill("abort1");
    const toggleCalls: boolean[] = [];

    const fakeQuery: QueryFn = async function* () {
      yield { type: "tool_use" };
      process.emit("SIGINT");
      yield { type: "result", result: "ignored-after-abort" };
    };

    await runSkill({
      taskPrompt: "x",
      live: true,
      cursor: true,
      maxSteps: 50,
      queryFn: fakeQuery,
      cursorToggleFn: async (enabled) => {
        toggleCalls.push(enabled);
      },
    });

    expect(process.exitCode).toBe(130);
    expect(toggleCalls).toEqual([true, false]);
  });
});

describe("run --fast", () => {
  test("plans once then executes locally without using the Agent SDK queryFn", async () => {
    const dir = makeFakeSkill("fast1");
    let plannerCalls = 0;
    let queryCalls = 0;
    const stepsRun: string[] = [];

    const fakePlanner: PlannerClient = {
      async generatePlanText() {
        plannerCalls++;
        return JSON.stringify({
          steps: [
            {
              tool: "launch_app",
              args: { bundle_id: "com.apple.calculator" },
              purpose: "open Calculator",
            },
            {
              tool: "click",
              args: { pid: "$pid", window_id: "$window_id", element_index: 5 },
              purpose: "press 1",
            },
          ],
          stopWhen: "done",
        });
      },
    };
    const fakeRunner: StepRunner = async (step) => {
      stepsRun.push(step.tool);
      if (step.tool === "launch_app") {
        return {
          ok: true,
          stdout: JSON.stringify({ pid: 42, windows: [{ window_id: 99 }] }),
        };
      }
      return { ok: true };
    };
    const fakeQuery: QueryFn = async function* () {
      queryCalls++;
      yield { type: "result", result: "should-not-fire" };
    };

    await runSkill({
      taskPrompt: "x",
      live: true,
      maxSteps: 50,
      fast: true,
      queryFn: fakeQuery,
      plannerClient: fakePlanner,
      stepRunner: fakeRunner,
    });

    expect(plannerCalls).toBe(1);
    expect(queryCalls).toBe(0);
    expect(stepsRun).toEqual(["launch_app", "click"]);
  });

  test("--fast inserts a Calculator clear step before arithmetic input", async () => {
    const dir = makeFakeSkill("fast-calc-clear");
    const purposesRun: string[] = [];

    const planner: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({
          steps: [
            {
              tool: "launch_app",
              args: { bundle_id: "com.apple.calculator" },
              purpose: "open Calculator",
            },
            {
              tool: "click",
              args: { pid: "$pid", window_id: "$window_id", element_index: 5 },
              purpose: "Press 3",
            },
          ],
          stopWhen: "Calculator shows 6",
        });
      },
    };
    const runner: StepRunner = async (step) => {
      purposesRun.push(step.purpose);
      if (step.tool === "launch_app") {
        return {
          ok: true,
          stdout: JSON.stringify({ pid: 42, windows: [{ window_id: 99 }] }),
        };
      }
      return { ok: true };
    };

    await runSkill({
      taskPrompt: "open Calculator and calculate 3 plus 3",
      live: true,
      maxSteps: 50,
      fast: true,
      plannerClient: planner,
      stepRunner: runner,
    });

    expect(purposesRun).toEqual([
      "open Calculator",
      "Clear stale Calculator input before entering the requested calculation",
      "Press 3",
    ]);
  });

  test("--fast --dry-run prints the plan but executes nothing", async () => {
    const dir = makeFakeSkill("fast2");
    let runs = 0;
    const logs: string[] = [];
    const originalLog = console.log;

    const planner: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({
          steps: [
            {
              tool: "click",
              args: { pid: 1 },
              purpose: "click button",
            },
          ],
          stopWhen: "done",
        });
      },
    };
    const runner: StepRunner = async () => {
      runs++;
      return { ok: true };
    };

    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await runSkill({
        taskPrompt: "x",
        live: false,
        maxSteps: 50,
        fast: true,
        plannerClient: planner,
        stepRunner: runner,
      });
    } finally {
      console.log = originalLog;
    }
    expect(runs).toBe(0);
    expect(logs.some((line) => line.includes("dry-run complete"))).toBe(true);
    expect(logs.some((line) => line.startsWith("[openclick] done."))).toBe(
      false,
    );
  });

  test("--fast emits a structured task_result on success", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const planner: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({
          steps: [
            {
              tool: "click",
              args: { pid: 1, window_id: 1, element_index: 1 },
              purpose: "click the requested button",
            },
          ],
          stopWhen: "done",
        });
      },
    };

    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await runSkill({
        taskPrompt: "click the requested button",
        live: true,
        maxSteps: 50,
        fast: true,
        plannerClient: planner,
        stepRunner: async () => ({ ok: true }),
      });
    } finally {
      console.log = originalLog;
    }

    const line = logs.find((entry) =>
      entry.startsWith("[openclick] task_result "),
    );
    expect(line).toBeDefined();
    const payload = JSON.parse(
      line?.replace("[openclick] task_result ", "") ?? "{}",
    ) as { kind?: string; title?: string; body?: string };
    expect(payload.kind).toBe("confirmation");
    expect(payload.title).toBe("Done");
    expect(payload.body).toBe("I have done what you asked.");
  });

  test("--fast replans on a step failure (capped at maxReplans)", async () => {
    const dir = makeFakeSkill("fast3");
    let plannerCalls = 0;
    let runnerCalls = 0;

    const planner: PlannerClient = {
      async generatePlanText() {
        plannerCalls++;
        return JSON.stringify({
          steps: [
            {
              tool: "click",
              args: { pid: 1, window_id: 1, element_index: 99 },
              purpose: "click bad target",
            },
          ],
          stopWhen: "done",
        });
      },
    };
    const runner: StepRunner = async () => {
      runnerCalls++;
      return { ok: false, error: "element_index 99 not found" };
    };

    await runSkill({
      taskPrompt: "x",
      live: true,
      maxSteps: 50,
      fast: true,
      maxReplans: 2,
      plannerClient: planner,
      stepRunner: runner,
    });
    // Initial plan + 2 replans = 3 planner calls; 3 runner attempts.
    expect(plannerCalls).toBe(3);
    expect(runnerCalls).toBe(3);
  });

  test("--fast returns a non-zero exit code when execution still fails", async () => {
    const dir = makeFakeSkill("fast-fail-exit");
    const planner: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({
          steps: [
            {
              tool: "click",
              args: { pid: 1, window_id: 1, element_index: 99 },
              purpose: "click missing target",
            },
          ],
          stopWhen: "done",
        });
      },
    };
    const runner: StepRunner = async () => ({
      ok: false,
      error: "element_index 99 not found",
    });

    await runSkill({
      taskPrompt: "x",
      live: true,
      maxSteps: 50,
      fast: true,
      maxReplans: 0,
      plannerClient: planner,
      stepRunner: runner,
    });

    expect(process.exitCode).toBe(1);
  });

  test("--fast resumes remaining work after a successful takeover", async () => {
    const dir = makeFakeSkill("fast-takeover-resume");
    const prompts: string[] = [];
    const toolsRun: string[] = [];
    let plannerCalls = 0;

    const planner: PlannerClient = {
      async generatePlanText(prompt) {
        prompts.push(prompt);
        plannerCalls++;
        if (plannerCalls === 1) {
          return JSON.stringify({
            steps: [
              {
                tool: "click",
                args: { pid: 1, window_id: 2, element_index: 99 },
                purpose: "click confirmation dialog",
              },
            ],
            stopWhen: "the latest unread email is open",
          });
        }
        return JSON.stringify({
          steps: [
            {
              tool: "click",
              args: { pid: 1, window_id: 2, element_index: 4 },
              purpose: "open the latest unread email",
            },
          ],
          stopWhen: "the latest unread email is open",
        });
      },
    };
    const runner: StepRunner = async (step) => {
      toolsRun.push(step.purpose);
      if (step.purpose === "click confirmation dialog") {
        return { ok: false, error: "confirmation dialog blocked automation" };
      }
      return { ok: true };
    };

    await runSkill({
      taskPrompt: "Open Gmail and open the latest unread email",
      live: true,
      maxSteps: 10,
      fast: true,
      maxReplans: 0,
      learn: false,
      plannerClient: planner,
      stepRunner: runner,
      takeoverResumeFn: async (runId) => ({
        schema_version: 1,
        run_id: runId,
        outcome: "success",
        issue: "Confirmation click required",
        summary: "Clicked the confirmation and returned to the Gmail inbox.",
        reason_type: "confirmation_dialog",
        bundle_id: "com.google.Chrome",
        app_name: "Google Chrome",
        task: "Open Gmail and open the latest unread email",
        created_at: new Date().toISOString(),
      }),
    });

    expect(process.exitCode).toBe(0);
    expect(toolsRun).toEqual([
      "click confirmation dialog",
      "open the latest unread email",
    ]);
    expect(prompts.at(-1)).toContain("Latest user takeover:");
    expect(prompts.at(-1)).toContain(
      "Continue with only the remaining work needed",
    );
    expect(prompts.at(-1)).toContain("latest unread email");
  });

  test("--fast honors maxSteps as a total step budget", async () => {
    const dir = makeFakeSkill("fast-max-steps");
    const toolsRun: string[] = [];
    const planner: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({
          steps: [
            {
              tool: "click",
              args: { pid: 1, window_id: 1, element_index: 1 },
              purpose: "one",
            },
            {
              tool: "click",
              args: { pid: 1, window_id: 1, element_index: 2 },
              purpose: "two",
            },
            {
              tool: "click",
              args: { pid: 1, window_id: 1, element_index: 3 },
              purpose: "three",
            },
          ],
          stopWhen: "done",
        });
      },
    };
    const runner: StepRunner = async (step) => {
      toolsRun.push(step.purpose);
      return { ok: true };
    };

    await runSkill({
      taskPrompt: "x",
      live: true,
      maxSteps: 2,
      fast: true,
      maxReplans: 0,
      plannerClient: planner,
      stepRunner: runner,
    });

    expect(process.exitCode).toBe(1);
    expect(toolsRun).toEqual(["one", "two"]);
  });

  test("--fast uses open_url for direct Chrome Gmail navigation", async () => {
    let plannerCalled = false;
    const toolsRun: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const planner: PlannerClient = {
      async generatePlanText() {
        plannerCalled = true;
        return JSON.stringify({ steps: [], stopWhen: "done" });
      },
    };
    const runner: StepRunner = async (step) => {
      toolsRun.push({ tool: step.tool, args: step.args });
      return {
        ok: true,
        stdout: JSON.stringify({
          pid: 123,
          windows: [{ window_id: 456, bounds: { width: 800, height: 600 } }],
        }),
      };
    };

    await runSkill({
      taskPrompt: "Open Google Chrome and go to Gmail",
      live: true,
      maxSteps: 5,
      fast: true,
      plannerClient: planner,
      stepRunner: runner,
    });

    expect(plannerCalled).toBe(false);
    expect(toolsRun).toEqual([
      {
        tool: "open_url",
        args: {
          bundle_id: "com.google.Chrome",
          url: "https://mail.google.com/",
        },
      },
    ]);
  });

  test("browser navigation shortcut keeps compound Gmail tasks unfinished", () => {
    const simple = buildBrowserNavigationPlan(
      "Open Google Chrome and go to Gmail",
    );
    expect(simple?.stopWhen).toContain("Google Chrome is showing");

    const safari = buildBrowserNavigationPlan(
      "Open Safari and go to https://example.com",
    );
    expect(safari?.steps[0]).toEqual({
      tool: "open_url",
      args: {
        bundle_id: "com.apple.Safari",
        url: "https://example.com",
      },
      purpose: "Open https://example.com in Safari",
      expected_change: "Safari loads https://example.com",
    });

    const compound = buildBrowserNavigationPlan(
      "Open Google Chrome, go to Gmail, and open the last unread email",
    );
    expect(compound?.steps[0]?.tool).toBe("open_url");
    expect(compound?.stopWhen).toContain("The full user task is complete");
    expect(compound?.stopWhen).toContain("last unread email");
    expect(compound?.stopWhen).toContain("only the first step");
  });

  test("--fast uses Finder launch urls for simple folder navigation", async () => {
    let plannerCalled = false;
    const toolsRun: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const planner: PlannerClient = {
      async generatePlanText() {
        plannerCalled = true;
        return JSON.stringify({ steps: [], stopWhen: "done" });
      },
    };
    const runner: StepRunner = async (step) => {
      toolsRun.push({ tool: step.tool, args: step.args });
      return {
        ok: true,
        stdout: JSON.stringify({
          pid: 123,
          windows: [
            {
              window_id: 456,
              title: "Downloads",
              bounds: { width: 800, height: 600 },
            },
          ],
        }),
      };
    };

    await runSkill({
      taskPrompt:
        "open Finder and show the Downloads folder; do not delete or move anything",
      live: true,
      maxSteps: 5,
      fast: true,
      plannerClient: planner,
      stepRunner: runner,
    });

    expect(plannerCalled).toBe(false);
    expect(toolsRun).toEqual([
      {
        tool: "launch_app",
        args: {
          bundle_id: "com.apple.finder",
          urls: [`${homedir()}/Downloads`],
        },
      },
    ]);
  });

  test("Finder navigation shortcut avoids complex file operations", () => {
    const simple = buildFinderNavigationPlan("Open Finder and show Downloads");
    expect(simple?.steps[0]).toEqual({
      tool: "launch_app",
      args: {
        bundle_id: "com.apple.finder",
        urls: [`${homedir()}/Downloads`],
      },
      purpose: "Open Downloads in Finder",
      expected_change: "Finder opens the Downloads folder",
    });

    expect(
      buildFinderNavigationPlan(
        "Open Finder, show Downloads, and copy the newest PDF",
      ),
    ).toBeNull();
  });

  test("--fast threads the user task into the planner prompt", async () => {
    let lastPrompt = "";
    const planner: PlannerClient = {
      async generatePlanText(prompt) {
        lastPrompt = prompt;
        return JSON.stringify({ steps: [], stopWhen: "done" });
      },
    };
    const runner: StepRunner = async () => ({ ok: true });

    await runSkill({
      taskPrompt: "do the special thing in Fake",
      live: false,
      maxSteps: 50,
      fast: true,
      plannerClient: planner,
      stepRunner: runner,
    });

    expect(lastPrompt).toContain("User task:");
    expect(lastPrompt).toContain("do the special thing in Fake");
    expect(lastPrompt).not.toContain("SKILL.md:");
  });

  test("--fast threads explicit criteria into the planner prompt", async () => {
    let lastPrompt = "";
    const planner: PlannerClient = {
      async generatePlanText(prompt) {
        lastPrompt = prompt;
        return JSON.stringify({ steps: [], stopWhen: "done" });
      },
    };

    await runSkill({
      taskPrompt: "draw a clock",
      criteria: "clock must show 10:10 and look clean",
      live: false,
      maxSteps: 50,
      fast: true,
      plannerClient: planner,
      stepRunner: async () => ({ ok: true }),
    });

    expect(lastPrompt).toContain("User success criteria:");
    expect(lastPrompt).toContain("clock must show 10:10 and look clean");
  });

  test("--fast --cursor toggles the overlay on/off around the run", async () => {
    const dir = makeFakeSkill("fast4");
    const toggles: boolean[] = [];

    const planner: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({ steps: [], stopWhen: "done" });
      },
    };
    const runner: StepRunner = async () => ({ ok: true });

    await runSkill({
      taskPrompt: "x",
      live: true,
      cursor: true,
      maxSteps: 50,
      fast: true,
      plannerClient: planner,
      stepRunner: runner,
      cursorToggleFn: async (enabled) => {
        toggles.push(enabled);
      },
    });
    expect(toggles).toEqual([true, false]);
  });
});

describe("verifyStopWhen", () => {
  // No-op screenshot capture for unit tests so we don't shell out to cua-driver.
  const noShot = async (): Promise<undefined> => undefined;

  test("returns verdict=yes when the model replies YES", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        return "YES — display reads 391 as expected";
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "calculation is complete",
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({
        ok: true,
        stdout: "- [4] AXStaticText (391) id=display\n",
      }),
      captureScreenshot: noShot,
    });
    expect(result.verdict).toBe("yes");
    expect(result.explanation).toMatch(/391/);
  });

  test("returns deterministic yes from AX without calling the model", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        throw new Error("should not call model");
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "display shows 391",
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({
        ok: true,
        stdout: "- [4] AXStaticText (391) id=display\n",
      }),
      captureScreenshot: noShot,
    });
    expect(result.verdict).toBe("yes");
    expect(result.explanation).toContain("391");
  });

  test("does not deterministically accept browser search keywords from AX", async () => {
    let modelCalled = false;
    const planner: PlannerClient = {
      async generatePlanText() {
        modelCalled = true;
        return "UNKNOWN — address bar text alone does not prove results are visible";
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "Google search results for OpenAI are visible",
      intent: {
        goal: "open Safari and search Google for OpenAI",
        successSignals: ["Google search results for OpenAI are visible"],
      },
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({
        ok: true,
        stdout:
          '- [1] AXTextField = "https://www.google.com/search?q=OpenAI"\n',
      }),
      captureScreenshot: noShot,
    });
    expect(modelCalled).toBe(true);
    expect(result.verdict).toBe("unknown");
  });

  test("downgrades Gmail inbox-list YES when task requires opening an unread email", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({
          verdict: "yes",
          criteria_met: true,
          missing: [],
          quality_issues: [],
          explanation:
            "The screenshot shows Gmail inbox open with unread emails visible and ready to be clicked.",
        });
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "the last unread email is open and readable",
      intent: {
        goal: "open chrome and go to gmail and read the last unread email",
        successSignals: ["the last unread email content is visible"],
      },
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({
        ok: true,
        stdout:
          '- [1] AXStaticText "Inbox"\n- [2] AXStaticText "Unread message from Stripe"\n',
      }),
      captureScreenshot: noShot,
    });
    expect(result.verdict).toBe("unknown");
    expect(result.explanation).toContain("not opened yet");
  });

  test("accepts Gmail inbox YES for simple Gmail navigation", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({
          verdict: "yes",
          criteria_met: true,
          missing: [],
          quality_issues: [],
          explanation:
            "Gmail inbox is open in Chrome with emails visible in the list.",
        });
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen:
        "Google Chrome is showing https://mail.google.com/ or the sign-in page for that site.",
      intent: {
        goal: "open Google Chrome and go to Gmail",
        successSignals: [
          "Google Chrome is showing https://mail.google.com/ or the sign-in page for that site.",
        ],
      },
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({
        ok: true,
        stdout: '- [1] AXStaticText "Inbox"\n',
      }),
      captureScreenshot: noShot,
    });
    expect(result.verdict).toBe("yes");
  });

  test("accepts Gmail email-content YES when the requested unread email is opened", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({
          verdict: "yes",
          criteria_met: true,
          missing: [],
          quality_issues: [],
          explanation:
            "The latest unread email is opened in conversation view with the sender, subject, and message body visible.",
        });
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "the last unread email is open and readable",
      intent: {
        goal: "open chrome and go to gmail and read the last unread email",
        successSignals: ["the last unread email content is visible"],
      },
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({
        ok: true,
        stdout: '- [1] AXStaticText "Subject"\n- [2] AXStaticText "Body"\n',
      }),
      captureScreenshot: noShot,
    });
    expect(result.verdict).toBe("yes");
  });

  test("downgrades visual-artifact YES replies that do not mention the artifact", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        return "YES — Figma is open with a design file visible on the canvas.";
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "clock drawing is visible on the canvas",
      intent: {
        goal: "open Figma, create a new design file, and draw a simple analog clock",
        successSignals: ["clock drawing is visible on the canvas"],
      },
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({ ok: true, stdout: "- [0] AXWindow Figma\n" }),
      captureScreenshot: noShot,
    });
    expect(result.verdict).toBe("unknown");
    expect(result.explanation).toContain("clock");
  });

  test("downgrades visual-artifact YES replies that mention only the object", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        return "YES — a clock drawing with a circular outline and hands is visible on the canvas.";
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "clock drawing is visible on the canvas",
      intent: {
        goal: "open Figma, create a new design file, and draw a simple analog clock",
        successSignals: ["clock drawing is visible on the canvas"],
      },
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({ ok: true, stdout: "- [0] AXWindow Figma\n" }),
      captureScreenshot: noShot,
    });
    expect(result.verdict).toBe("unknown");
  });

  test("accepts visual-artifact YES replies that confirm requested attributes", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        return "YES — a decent analog clock is visible with a circular outline, two hands, and hour marks on the canvas.";
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "clock drawing is visible on the canvas",
      intent: {
        goal: "draw a decent analog clock with a circular outline, two hands, and hour marks",
        successSignals: ["clock drawing is visible on the canvas"],
      },
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({ ok: true, stdout: "- [0] AXWindow Figma\n" }),
      captureScreenshot: noShot,
    });
    expect(result.verdict).toBe("yes");
  });

  test("accepts structured verifier JSON when explicit criteria are met", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({
          verdict: "yes",
          criteria_met: true,
          missing: [],
          quality_issues: [],
          explanation:
            "The clean analog clock is showing 10:10 and has hands and hour marks.",
        });
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "clock drawing is visible on the canvas",
      criteria:
        "clock must be clean, show 10:10, have two hands, and visible hour marks",
      intent: {
        goal: "draw a clean analog clock showing 10:10",
        successSignals: ["clock drawing is visible on the canvas"],
      },
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({ ok: true, stdout: "- [0] AXWindow Figma\n" }),
      captureScreenshot: noShot,
    });
    expect(result.verdict).toBe("yes");
    expect(result.explanation).toContain("10:10");
  });

  test("rejects structured verifier JSON when explicit criteria are missing", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({
          verdict: "yes",
          criteria_met: false,
          missing: ["12 visible hour marks"],
          quality_issues: ["rough outline"],
          explanation:
            "A rough clock is visible, but it misses requested marks.",
        });
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "clock drawing is visible on the canvas",
      criteria: "clock must have 12 visible hour marks",
      intent: {
        goal: "draw a clean analog clock",
        successSignals: ["clock drawing is visible on the canvas"],
      },
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({ ok: true, stdout: "- [0] AXWindow Figma\n" }),
      captureScreenshot: noShot,
    });
    expect(result.verdict).toBe("unknown");
    expect(result.explanation).toContain("12 visible hour marks");
  });

  test("downgrades visual-artifact YES replies that describe poor quality", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        return "YES — a rough analog clock is visible with a circular outline and two hands, but the hour marks are misaligned.";
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "clock drawing is visible on the canvas",
      intent: {
        goal: "draw a decent analog clock with a circular outline, two hands, and hour marks",
        successSignals: ["clock drawing is visible on the canvas"],
      },
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({ ok: true, stdout: "- [0] AXWindow Figma\n" }),
      captureScreenshot: noShot,
    });
    expect(result.verdict).toBe("unknown");
  });

  test("returns verdict=no when the model replies NO", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        return "NO — display still shows 0";
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "calculation is complete",
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({
        ok: true,
        stdout: "- [4] AXStaticText (0) id=display\n",
      }),
      captureScreenshot: noShot,
    });
    expect(result.verdict).toBe("no");
    expect(result.explanation).toMatch(/still shows 0/);
  });

  test("returns verdict=unknown when the model replies UNKNOWN (sparse evidence)", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        return "UNKNOWN — Safari web view content isn't in the AX tree and the screenshot only shows menu bar";
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "Google results page is showing",
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({ ok: true, stdout: "- [0] AXMenuBar\n" }),
      captureScreenshot: noShot,
    });
    expect(result.verdict).toBe("unknown");
    expect(result.explanation).toMatch(/sparse|menu bar|web view/i);
  });

  test("threads stopWhen, intent, and step purposes into the prompt", async () => {
    let capturedPrompt = "";
    const planner: PlannerClient = {
      async generatePlanText(prompt) {
        capturedPrompt = prompt;
        return "YES — ok";
      },
    };
    await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "calculation is complete",
      pid: 1,
      windowId: 2,
      settleMs: 0,
      intent: {
        goal: "Compute 17 × 23",
        successSignals: ["calculator result is visible"],
      },
      executedStepPurposes: ["press 1", "press 7", "press equals"],
      snapshot: async () => ({
        ok: true,
        stdout: "- [4] AXStaticText (391) id=display\n",
      }),
      captureScreenshot: noShot,
    });
    expect(capturedPrompt).toContain("calculation is complete");
    expect(capturedPrompt).toContain("AXStaticText");
    expect(capturedPrompt).toContain("Compute 17 × 23");
    expect(capturedPrompt).toContain("calculator result is visible");
    expect(capturedPrompt).toContain("press equals");
    expect(capturedPrompt).toMatch(/UNKNOWN/);
  });

  test("returns unknown when get_window_state fails (cannot prove failure)", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        throw new Error("should not be called");
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "x",
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({
        ok: false,
        stdout: "",
        error: "no such window",
      }),
      captureScreenshot: noShot,
    });
    expect(result.verdict).toBe("unknown");
    expect(result.explanation).toMatch(/no such window/);
  });

  test("forwards captured screenshot path to the planner client", async () => {
    let receivedImages: string[] | undefined;
    const planner: PlannerClient = {
      async generatePlanText(_prompt, imagePaths) {
        receivedImages = imagePaths;
        return "YES — ok";
      },
    };
    await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "calculation is complete",
      pid: 1,
      windowId: 2,
      settleMs: 0,
      snapshot: async () => ({
        ok: true,
        stdout: "- [4] AXStaticText (391) id=display\n",
      }),
      captureScreenshot: async () => "/tmp/openclick-verify-xyz.png",
    });
    expect(receivedImages).toEqual(["/tmp/openclick-verify-xyz.png"]);
  });
});

function makeFakeSkill(name: string): string {
  const dir = join("/tmp", `openclick-test-${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${name}
description: test
---
# Test
## Steps
1. do something
`,
  );
  return dir;
}
