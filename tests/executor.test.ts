import { describe, expect, test } from "bun:test";
import { type StepRunner, executePlan } from "../src/executor.ts";
import type { Plan } from "../src/planner.ts";

const SIMPLE_PLAN: Plan = {
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
  stopWhen: "display shows 391",
};

describe("executor", () => {
  test("walks the plan via the injected step runner", async () => {
    const calls: string[] = [];
    const runner: StepRunner = async (step) => {
      calls.push(step.tool);
      return { ok: true, stdout: "{}" };
    };
    const result = await executePlan(SIMPLE_PLAN, { stepRunner: runner });
    expect(calls).toEqual(["launch_app", "click"]);
    expect(result.stepsExecuted).toBe(2);
    expect(result.totalSteps).toBe(2);
  });

  test("dryRun skips the runner entirely", async () => {
    let runs = 0;
    const runner: StepRunner = async () => {
      runs++;
      return { ok: true };
    };
    const result = await executePlan(SIMPLE_PLAN, {
      stepRunner: runner,
      dryRun: true,
    });
    expect(runs).toBe(0);
    expect(result.stepsExecuted).toBe(0);
  });

  test("aborts on the first failed step and returns the error", async () => {
    const runner: StepRunner = async (step) => {
      if (step.tool === "click")
        return { ok: false, error: "element_index 5 not found" };
      return { ok: true };
    };
    const result = await executePlan(SIMPLE_PLAN, { stepRunner: runner });
    expect(result.stepsExecuted).toBe(1);
    expect(result.failedStepIndex).toBe(1);
    expect(result.error).toMatch(/element_index 5/);
  });

  test("substitutes $pid and $window_id from a previous launch_app result", async () => {
    const runner: StepRunner = async (step) => {
      if (step.tool === "launch_app") {
        return {
          ok: true,
          stdout: JSON.stringify({
            pid: 1234,
            windows: [{ window_id: 9876 }],
          }),
        };
      }
      // Click step: capture its resolved args.
      capturedClickArgs = step.args;
      return { ok: true };
    };
    let capturedClickArgs: Record<string, unknown> = {};
    await executePlan(SIMPLE_PLAN, { stepRunner: runner });
    expect(capturedClickArgs.pid).toBe(1234);
    expect(capturedClickArgs.window_id).toBe(9876);
    expect(capturedClickArgs.element_index).toBe(5);
  });

  test("emits a `[showme] about to:` line for each step", async () => {
    const lines: string[] = [];
    const log = (s: string) => lines.push(s);
    const runner: StepRunner = async () => ({ ok: true });
    await executePlan(SIMPLE_PLAN, { stepRunner: runner, log });
    expect(lines.some((l) => l.includes("about to: open Calculator"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("about to: press 1"))).toBe(true);
  });
});
