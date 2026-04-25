import { describe, expect, test } from "bun:test";
import {
  type StepRunner,
  executePlan,
  parseAxTreeIndex,
} from "../src/executor.ts";
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

  test("__title resolves to element_index from prior get_window_state", async () => {
    let capturedClickArgs: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "get_window_state",
          args: { pid: 1234, window_id: 9876 },
          purpose: "prime AX cache",
        },
        {
          tool: "click",
          args: { pid: 1234, window_id: 9876, __title: "5" },
          purpose: "press 5",
        },
        {
          tool: "click",
          args: { pid: 1234, window_id: 9876, __ax_id: "Equals" },
          purpose: "press =",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      if (step.tool === "get_window_state") {
        return {
          ok: true,
          stdout: `✅ Calculator — 6 elements
- AXApplication "Calculator"
  - [0] AXWindow "Calculator"
    - [4] AXButton (All Clear) id=AllClear
    - [12] AXButton (5) id=Five
    - [20] AXButton (0) id=Zero
    - [22] AXButton (Equals) id=Equals
`,
        };
      }
      capturedClickArgs = step.args;
      return { ok: true };
    };

    await executePlan(plan, { stepRunner: runner });
    // Note: the LAST captured click is "press =", so element_index should be 22.
    expect(capturedClickArgs.element_index).toBe(22);
    expect(capturedClickArgs.__title).toBeUndefined();
    expect(capturedClickArgs.__ax_id).toBeUndefined();
    expect(capturedClickArgs.pid).toBe(1234);
    expect(capturedClickArgs.window_id).toBe(9876);
  });

  test("__title resolves correctly when planner mistakes title for index", async () => {
    // This is the regression test for the user's calc bug: the planner
    // emitted element_index: 20 thinking that was "5", but [20] is "0".
    // With __title: "5" the executor reads the AX tree and resolves to [12].
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "get_window_state",
          args: { pid: 1, window_id: 1 },
          purpose: "prime",
        },
        {
          tool: "click",
          args: { pid: 1, window_id: 1, __title: "5" },
          purpose: "press 5",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      if (step.tool === "get_window_state") {
        return {
          ok: true,
          stdout: "- [12] AXButton (5) id=Five\n- [20] AXButton (0) id=Zero\n",
        };
      }
      captured = step.args;
      return { ok: true };
    };
    await executePlan(plan, { stepRunner: runner });
    expect(captured.element_index).toBe(12); // not 20 — that's "0", not "5"
  });
});

describe("executor initialContext (pre-discovery)", () => {
  test("seeds pid/windowId/axIndex so the first click resolves without a get_window_state step", async () => {
    let capturedClickArgs: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "click",
          args: { pid: "$pid", window_id: "$window_id", __title: "5" },
          purpose: "press 5",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      capturedClickArgs = step.args;
      return { ok: true };
    };
    const result = await executePlan(plan, {
      stepRunner: runner,
      initialContext: {
        pid: 4242,
        windowId: 9001,
        axIndex: new Map<string, number>([
          ["5", 12],
          ["five", 12],
        ]),
      },
    });
    expect(result.stepsExecuted).toBe(1);
    expect(capturedClickArgs.pid).toBe(4242);
    expect(capturedClickArgs.window_id).toBe(9001);
    expect(capturedClickArgs.element_index).toBe(12);
  });

  test("does not mutate the caller's initialContext object", async () => {
    const original = {
      pid: 1,
      windowId: 2,
      axIndex: new Map<string, number>([["x", 3]]),
    };
    const plan: Plan = { steps: [], stopWhen: "done" };
    const runner: StepRunner = async () => ({ ok: true });
    await executePlan(plan, { stepRunner: runner, initialContext: original });
    expect(original.pid).toBe(1);
    expect(original.windowId).toBe(2);
    expect(original.axIndex.get("x")).toBe(3);
  });
});

describe("parseAxTreeIndex", () => {
  test("parses real Calculator AX tree output", () => {
    const stdout = `✅ Calculator — 42 elements, turn 6 + screenshot

- AXApplication "Calculator"
  - [0] AXWindow "Calculator" id=main actions=[AXRaise]
    - AXGroup
      - AXSplitGroup id=main
            - [4] AXButton (All Clear) id=AllClear
            - [12] AXButton (5) id=Five
            - [20] AXButton (0) id=Zero
            - [22] AXButton (Equals) id=Equals
`;
    const idx = parseAxTreeIndex(stdout);
    // Title-based lookup
    expect(idx.get("5")).toBe(12);
    expect(idx.get("0")).toBe(20);
    expect(idx.get("equals")).toBe(22);
    // ID-based lookup
    expect(idx.get("five")).toBe(12);
    expect(idx.get("zero")).toBe(20);
    expect(idx.get("allclear")).toBe(4);
  });

  test("indexes lowercased to be tolerant of case mismatches", () => {
    const stdout = "- [10] AXButton (Multiply) id=Multiply\n";
    const idx = parseAxTreeIndex(stdout);
    expect(idx.get("multiply")).toBe(10); // lowercase title
    expect(idx.get("Multiply")).toBeUndefined(); // case-sensitive lookup fails
  });

  test("handles entries with no title and no id", () => {
    const stdout = "- [26] AXButton\n- [27] AXButton DISABLED\n";
    const idx = parseAxTreeIndex(stdout);
    expect(idx.size).toBe(0);
  });

  test("returns empty map on empty input", () => {
    expect(parseAxTreeIndex("").size).toBe(0);
    expect(parseAxTreeIndex("not a tree").size).toBe(0);
  });
});
