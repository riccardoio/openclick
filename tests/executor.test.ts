import { describe, expect, test } from "bun:test";
import {
  type StepRunner,
  executePlan,
  parseAxTreeIndex,
  resolveSelector,
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
        axIndex: parseAxTreeIndex("- [12] AXButton (5) id=Five\n"),
      },
    });
    expect(result.stepsExecuted).toBe(1);
    expect(capturedClickArgs.pid).toBe(4242);
    expect(capturedClickArgs.window_id).toBe(9001);
    expect(capturedClickArgs.element_index).toBe(12);
  });

  test("repairs hallucinated pid:0 / window_id:0 from context (planner failure mode)", async () => {
    // Real-world failure: Sonnet emitted `pid: 0, window_id: 0` instead of the
    // discovered integers. cua-driver receives 0 verbatim and rejects with
    // "no cached AX state for pid 0". Defensive substitution catches it when
    // pre-discovery has populated context.
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "click",
          args: { pid: 0, window_id: 0, element_index: 12 },
          purpose: "click target despite hallucinated zeros",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      captured = step.args;
      return { ok: true };
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: { pid: 14002, windowId: 3745 },
      refreshBeforeAxClick: false,
    });
    expect(captured.pid).toBe(14002);
    expect(captured.window_id).toBe(3745);
  });

  test("does not mutate the caller's initialContext object", async () => {
    const original = {
      pid: 1,
      windowId: 2,
      axIndex: parseAxTreeIndex("- [3] AXButton (X) id=x\n"),
    };
    const before = original.axIndex.length;
    const plan: Plan = { steps: [], stopWhen: "done" };
    const runner: StepRunner = async () => ({ ok: true });
    await executePlan(plan, { stepRunner: runner, initialContext: original });
    expect(original.pid).toBe(1);
    expect(original.windowId).toBe(2);
    expect(original.axIndex.length).toBe(before);
  });
});

describe("parseAxTreeIndex", () => {
  test("parses real Calculator AX tree output into structured entries", () => {
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
    const entries = parseAxTreeIndex(stdout);
    const byIndex = new Map(entries.map((e) => [e.index, e]));
    expect(byIndex.get(12)?.title).toBe("5");
    expect(byIndex.get(12)?.id).toBe("Five");
    expect(byIndex.get(12)?.role).toBe("AXButton");
    expect(byIndex.get(20)?.title).toBe("0");
    expect(byIndex.get(22)?.id).toBe("Equals");
    expect(byIndex.get(4)?.title).toBe("All Clear");
    // Ancestor path is built from the indentation chain of role-only ancestors.
    expect(byIndex.get(12)?.ancestorPath.length).toBeGreaterThan(0);
  });

  test("entries with no title and no id are still kept (with ancestry + ordinal)", () => {
    const stdout = "- [26] AXButton\n- [27] AXButton\n";
    const entries = parseAxTreeIndex(stdout);
    expect(entries.length).toBe(2);
    expect(entries[0]?.ordinal).toBe(0);
    expect(entries[1]?.ordinal).toBe(1);
  });

  test("returns empty array on empty input", () => {
    expect(parseAxTreeIndex("").length).toBe(0);
    expect(parseAxTreeIndex("not a tree").length).toBe(0);
  });

  test("ordinal increments for entries with the same (role, title)", () => {
    const stdout = `
- [1] AXButton (OK) id=ok1
- [2] AXButton (OK) id=ok2
- [3] AXButton (OK) id=ok3
`;
    const entries = parseAxTreeIndex(stdout);
    expect(entries.map((e) => e.ordinal)).toEqual([0, 1, 2]);
  });
});

describe("resolveSelector", () => {
  const stdout = `
- [1] AXButton (OK) id=ok1
- [2] AXButton (OK) id=ok2
- [3] AXButton (Cancel) id=cancel
- [4] AXStaticText (391) id=display
`;
  const entries = parseAxTreeIndex(stdout);

  test("ax_id resolves uniquely (case-insensitive)", () => {
    expect(resolveSelector(entries, { ax_id: "ok1" })).toBe(1);
    expect(resolveSelector(entries, { ax_id: "OK2" })).toBe(2);
    expect(resolveSelector(entries, { ax_id: "Display" })).toBe(4);
  });

  test("title alone is ambiguous when multiple entries match → null", () => {
    expect(resolveSelector(entries, { title: "OK" })).toBeNull();
  });

  test("title + ordinal disambiguates", () => {
    expect(resolveSelector(entries, { title: "OK", ordinal: 0 })).toBe(1);
    expect(resolveSelector(entries, { title: "OK", ordinal: 1 })).toBe(2);
  });

  test("title + role narrows match", () => {
    // Cancel only has one button; the static-text has none.
    expect(
      resolveSelector(entries, { title: "Cancel", role: "AXButton" }),
    ).toBe(3);
    expect(
      resolveSelector(entries, { title: "391", role: "AXStaticText" }),
    ).toBe(4);
  });

  test("returns null when nothing matches", () => {
    expect(resolveSelector(entries, { ax_id: "doesnotexist" })).toBeNull();
    expect(resolveSelector(entries, { title: "doesnotexist" })).toBeNull();
  });
});

describe("assert step (legacy no-op)", () => {
  // Mid-flight asserts invent failure modes we can't predict per-app
  // (e.g. Safari's address bar after submit shows a URL, not the literal
  // query, so an assert on the query text spuriously fails). Success is
  // checked once at the end via stopWhen against intent.success_signals.
  // Legacy plans may still contain assert steps — they're silently skipped.

  test("does not invoke the runner and does not fail the run", async () => {
    const tools: string[] = [];
    const plan: Plan = {
      steps: [
        {
          tool: "assert",
          args: { kind: "ax_text", expected: "anything" },
          purpose: "legacy assert",
        },
      ],
      stopWhen: "x",
    };
    const runner: StepRunner = async (step) => {
      tools.push(step.tool);
      return { ok: true };
    };
    const result = await executePlan(plan, {
      stepRunner: runner,
      initialContext: { pid: 1, windowId: 2 },
    });
    expect(result.error).toBeUndefined();
    // Skipped asserts STILL increment stepsExecuted so callers slicing
    // plan.steps.slice(0, stepsExecuted) get an aligned prefix that matches
    // what was actually consumed (including legacy assert steps that were
    // present but no-op'd). Without this, executor returns
    // stepsExecuted=N-K but the K skipped asserts shift the alignment.
    expect(result.stepsExecuted).toBe(1);
    expect(tools).toEqual([]);
  });
});

describe("refreshBeforeAxClick", () => {
  test("re-runs get_window_state before each AX-targeted click and reflects new index", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    let snapshot = "- [12] AXButton (5) id=Five\n";
    const plan: Plan = {
      steps: [
        {
          tool: "click",
          args: { pid: 1, window_id: 2, __title: "5" },
          purpose: "press 5",
        },
        {
          tool: "click",
          args: { pid: 1, window_id: 2, __title: "5" },
          purpose: "press 5 again (post-rerender)",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      calls.push({ tool: step.tool, args: step.args });
      if (step.tool === "get_window_state") {
        return { ok: true, stdout: snapshot };
      }
      // After the first click, the rerender shifts "5" to a new index.
      snapshot = "- [42] AXButton (5) id=Five\n";
      return { ok: true };
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: {
        pid: 1,
        windowId: 2,
        axIndex: parseAxTreeIndex(snapshot),
      },
    });
    // Sequence: refresh, click(12), refresh, click(42).
    expect(calls.map((c) => c.tool)).toEqual([
      "get_window_state",
      "click",
      "get_window_state",
      "click",
    ]);
    expect(calls[1]?.args.element_index).toBe(12);
    expect(calls[3]?.args.element_index).toBe(42);
  });

  test("refreshBeforeAxClick=false disables the auto-refresh", async () => {
    const tools: string[] = [];
    const plan: Plan = {
      steps: [
        {
          tool: "click",
          args: { pid: 1, window_id: 2, __title: "5" },
          purpose: "press 5",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      tools.push(step.tool);
      if (step.tool === "get_window_state")
        return { ok: true, stdout: "- [12] AXButton (5) id=Five\n" };
      return { ok: true };
    };
    await executePlan(plan, {
      stepRunner: runner,
      refreshBeforeAxClick: false,
      initialContext: {
        pid: 1,
        windowId: 2,
        axIndex: parseAxTreeIndex("- [12] AXButton (5) id=Five\n"),
      },
    });
    // No refresh, just the click.
    expect(tools).toEqual(["click"]);
  });

  test("skips refresh when pid/windowId aren't yet known", async () => {
    const tools: string[] = [];
    const plan: Plan = {
      steps: [
        {
          tool: "launch_app",
          args: { bundle_id: "com.x" },
          purpose: "launch",
        },
        {
          tool: "click",
          args: { pid: "$pid", window_id: "$window_id", __title: "5" },
          purpose: "press 5",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      tools.push(step.tool);
      if (step.tool === "launch_app")
        return {
          ok: true,
          stdout: JSON.stringify({ pid: 1, windows: [{ window_id: 2 }] }),
        };
      if (step.tool === "get_window_state")
        return { ok: true, stdout: "- [12] AXButton (5) id=Five\n" };
      return { ok: true };
    };
    // No initialContext: launch_app populates pid/window mid-plan, then the
    // refresh kicks in before the click.
    await executePlan(plan, { stepRunner: runner });
    expect(tools).toEqual(["launch_app", "get_window_state", "click"]);
  });

  test("does NOT refresh for steps that target by element_index (no selector keys)", async () => {
    const tools: string[] = [];
    const plan: Plan = {
      steps: [
        {
          tool: "click",
          args: { pid: 1, window_id: 2, element_index: 5 },
          purpose: "click index 5 directly",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      tools.push(step.tool);
      return { ok: true };
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: {
        pid: 1,
        windowId: 2,
        axIndex: parseAxTreeIndex("- [5] AXButton (X) id=x\n"),
      },
    });
    expect(tools).toEqual(["click"]);
  });
});

describe("__selector synthetic key", () => {
  test("__selector with ax_id resolves to element_index", async () => {
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "click",
          args: {
            pid: "$pid",
            window_id: "$window_id",
            __selector: { ax_id: "Five" },
          },
          purpose: "press 5",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      captured = step.args;
      return { ok: true };
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: {
        pid: 1,
        windowId: 2,
        axIndex: parseAxTreeIndex("- [12] AXButton (5) id=Five\n"),
      },
    });
    expect(captured.element_index).toBe(12);
    expect(captured.__selector).toBeUndefined();
  });

  test("__selector with title + role + ordinal picks the right OK", async () => {
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "click",
          args: {
            pid: 1,
            window_id: 1,
            __selector: { title: "OK", role: "AXButton", ordinal: 1 },
          },
          purpose: "second OK",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      captured = step.args;
      return { ok: true };
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: {
        pid: 1,
        windowId: 1,
        axIndex: parseAxTreeIndex(
          "- [1] AXButton (OK) id=ok1\n- [2] AXButton (OK) id=ok2\n",
        ),
      },
    });
    expect(captured.element_index).toBe(2);
  });
});
