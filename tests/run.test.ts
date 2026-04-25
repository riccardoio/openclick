import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepRunner } from "../src/executor.ts";
import type { PlannerClient } from "../src/planner.ts";
import { type QueryFn, runSkill, verifyStopWhen } from "../src/run.ts";

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
      skillRoot: dir,
      userPrompt: "do it",
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
      skillRoot: dir,
      userPrompt: "do it",
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
      skillRoot: dir,
      userPrompt: "x",
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
      skillRoot: dir,
      userPrompt: "x",
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
      skillRoot: dir,
      userPrompt: "x",
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
      skillRoot: dir,
      userPrompt: "x",
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
        skillRoot: dir,
        userPrompt: "x",
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
      skillRoot: dir,
      userPrompt: "x",
      live: true,
      maxSteps: 50,
      queryFn: fakeQuery,
    });
    expect(registered).toHaveProperty("cua-driver");
    expect(registered["cua-driver"].command).toBe("cua-driver");
    expect(registered["cua-driver"].args).toEqual(["mcp"]);
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
      skillRoot: dir,
      userPrompt: "x",
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

  test("--fast --dry-run prints the plan but executes nothing", async () => {
    const dir = makeFakeSkill("fast2");
    let runs = 0;

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

    await runSkill({
      skillRoot: dir,
      userPrompt: "x",
      live: false,
      maxSteps: 50,
      fast: true,
      plannerClient: planner,
      stepRunner: runner,
    });
    expect(runs).toBe(0);
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
      skillRoot: dir,
      userPrompt: "x",
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
      skillRoot: dir,
      userPrompt: "x",
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

  test("returns success=true when the model replies YES", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        return "YES — display reads 391 as expected";
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "display shows 391",
      pid: 1,
      windowId: 2,
      snapshot: async () => ({
        ok: true,
        stdout: "- [4] AXStaticText (391) id=display\n",
      }),
      captureScreenshot: noShot,
    });
    expect(result.success).toBe(true);
    expect(result.explanation).toMatch(/391/);
  });

  test("returns success=false when the model replies NO", async () => {
    const planner: PlannerClient = {
      async generatePlanText() {
        return "NO — display still shows 0";
      },
    };
    const result = await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "display shows 391",
      pid: 1,
      windowId: 2,
      snapshot: async () => ({
        ok: true,
        stdout: "- [4] AXStaticText (0) id=display\n",
      }),
      captureScreenshot: noShot,
    });
    expect(result.success).toBe(false);
    expect(result.explanation).toMatch(/still shows 0/);
  });

  test("threads stopWhen and live AX tree into the prompt", async () => {
    let capturedPrompt = "";
    const planner: PlannerClient = {
      async generatePlanText(prompt) {
        capturedPrompt = prompt;
        return "YES — ok";
      },
    };
    await verifyStopWhen({
      plannerClient: planner,
      stopWhen: "display shows 391",
      pid: 1,
      windowId: 2,
      snapshot: async () => ({
        ok: true,
        stdout: "- [4] AXStaticText (391) id=display\n",
      }),
      captureScreenshot: noShot,
    });
    expect(capturedPrompt).toContain("display shows 391");
    expect(capturedPrompt).toContain("AXStaticText");
  });

  test("returns failure with the snapshot error if get_window_state fails", async () => {
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
      snapshot: async () => ({
        ok: false,
        stdout: "",
        error: "no such window",
      }),
      captureScreenshot: noShot,
    });
    expect(result.success).toBe(false);
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
      stopWhen: "display shows 391",
      pid: 1,
      windowId: 2,
      snapshot: async () => ({
        ok: true,
        stdout: "- [4] AXStaticText (391) id=display\n",
      }),
      captureScreenshot: async () => "/tmp/showme-verify-xyz.png",
    });
    expect(receivedImages).toEqual(["/tmp/showme-verify-xyz.png"]);
  });
});

function makeFakeSkill(name: string): string {
  const dir = join("/tmp", `showme-test-${name}-${Date.now()}`);
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
