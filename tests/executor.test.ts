import { describe, expect, test } from "bun:test";
import {
  type StepRunner,
  classifyToolSafety,
  executePlan,
  parseAxTreeIndex,
  pickOpenedUrlTab,
  pickOpenedUrlWindow,
  resolveSelector,
  runCuaDriverStep,
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
  test("classifies foreground-only primitives out of shared-seat mode", () => {
    expect(classifyToolSafety("click").category).toBe("background_safe");
    expect(classifyToolSafety("open_url").category).toBe("background_safe");
    expect(classifyToolSafety("list_browser_tabs").category).toBe(
      "background_safe",
    );
    expect(classifyToolSafety("mcp__cua-driver__move_cursor").category).toBe(
      "foreground_required",
    );
    expect(classifyToolSafety("paste_svg").category).toBe(
      "foreground_required",
    );
  });

  test("blocks foreground-only primitives by default", async () => {
    const result = await runCuaDriverStep({
      tool: "move_cursor",
      args: { x: 10, y: 10 },
      purpose: "move the real cursor",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("foreground-required tool blocked");
  });

  test("executePlan enforces shared-seat policy before injected runners", async () => {
    let called = false;
    const result = await executePlan(
      {
        steps: [
          {
            tool: "move_cursor",
            args: { x: 10, y: 10 },
            purpose: "move the real cursor",
          },
        ],
        stopWhen: "cursor moved",
      },
      {
        stepRunner: async () => {
          called = true;
          return { ok: true };
        },
      },
    );

    expect(called).toBe(false);
    expect(result.error).toContain("foreground-required tool blocked");
  });

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

  test("maxSteps stops execution once the budget is exhausted", async () => {
    const calls: string[] = [];
    const runner: StepRunner = async (step) => {
      calls.push(step.tool);
      return { ok: true, stdout: "{}" };
    };
    const result = await executePlan(SIMPLE_PLAN, {
      stepRunner: runner,
      maxSteps: 1,
    });
    expect(calls).toEqual(["launch_app"]);
    expect(result.stepsExecuted).toBe(1);
    expect(result.failedStepIndex).toBe(1);
    expect(result.error).toMatch(/max step budget exhausted/i);
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

  test("normalizes shifted-symbol press_key steps before running cua-driver", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const runner: StepRunner = async (step) => {
      calls.push({ tool: step.tool, args: step.args });
      return { ok: true };
    };
    const plan: Plan = {
      steps: [
        {
          tool: "press_key",
          args: { pid: 1, key: "*" },
          purpose: "press multiply",
        },
      ],
      stopWhen: "done",
    };
    await executePlan(plan, { stepRunner: runner });
    expect(calls).toEqual([
      { tool: "hotkey", args: { pid: 1, keys: ["shift", "8"] } },
    ]);
  });

  test("falls back to key sequence for type_text when no editable role is visible", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const runner: StepRunner = async (step) => {
      calls.push({ tool: step.tool, args: step.args });
      return { ok: true };
    };
    const plan: Plan = {
      steps: [
        {
          tool: "type_text",
          args: { pid: 1, text: "18*24\n" },
          purpose: "enter expression",
        },
      ],
      stopWhen: "done",
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: {
        pid: 1,
        windowId: 2,
        axIndex: parseAxTreeIndex("- [1] AXButton (1) id=One\n"),
      },
    });
    expect(calls).toEqual([
      { tool: "press_key", args: { pid: 1, window_id: 2, key: "1" } },
      { tool: "press_key", args: { pid: 1, window_id: 2, key: "8" } },
      {
        tool: "hotkey",
        args: { pid: 1, window_id: 2, keys: ["shift", "8"] },
      },
      { tool: "press_key", args: { pid: 1, window_id: 2, key: "2" } },
      { tool: "press_key", args: { pid: 1, window_id: 2, key: "4" } },
      { tool: "press_key", args: { pid: 1, window_id: 2, key: "return" } },
    ]);
  });

  test("keeps type_text when an editable role is visible", async () => {
    const calls: string[] = [];
    const runner: StepRunner = async (step) => {
      calls.push(step.tool);
      return { ok: true };
    };
    const plan: Plan = {
      steps: [
        {
          tool: "type_text",
          args: { pid: 1, text: "hello" },
          purpose: "enter query",
        },
      ],
      stopWhen: "done",
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: {
        pid: 1,
        windowId: 2,
        axIndex: parseAxTreeIndex("- [1] AXTextField (Search) id=search\n"),
      },
    });
    expect(calls).toEqual(["type_text"]);
  });

  test("keeps non-numeric type_text even when AX is sparse", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const runner: StepRunner = async (step) => {
      calls.push({ tool: step.tool, args: step.args });
      return { ok: true };
    };
    const plan: Plan = {
      steps: [
        {
          tool: "type_text",
          args: { pid: 1, text: "https://www.google.com/search?q=OpenAI\n" },
          purpose: "enter URL",
        },
      ],
      stopWhen: "done",
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: { pid: 1, windowId: 2, axIndex: [] },
    });
    expect(calls).toEqual([
      {
        tool: "type_text",
        args: {
          pid: 1,
          window_id: 2,
          text: "https://www.google.com/search?q=OpenAI\n",
        },
      },
    ]);
  });

  test("converts keyboard steps to AX button clicks when matching buttons are visible", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const runner: StepRunner = async (step) => {
      calls.push({ tool: step.tool, args: step.args });
      return { ok: true };
    };
    const plan: Plan = {
      steps: [
        {
          tool: "press_key",
          args: { pid: 1, key: "2" },
          purpose: "press 2",
        },
        {
          tool: "hotkey",
          args: { pid: 1, keys: ["shift", "8"] },
          purpose: "press multiply",
        },
        {
          tool: "press_key",
          args: { pid: 1, key: "return" },
          purpose: "press equals",
        },
      ],
      stopWhen: "done",
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: {
        pid: 1,
        windowId: 2,
        axIndex: parseAxTreeIndex(
          [
            "- [15] AXButton (2) id=Two",
            "- [9] AXButton (Multiply) id=Multiply",
            "- [21] AXButton (Equals) id=Equals",
          ].join("\n"),
        ),
      },
    });
    expect(calls).toEqual([
      { tool: "click", args: { pid: 1, window_id: 2, element_index: 15 } },
      { tool: "click", args: { pid: 1, window_id: 2, element_index: 9 } },
      { tool: "click", args: { pid: 1, window_id: 2, element_index: 21 } },
    ]);
  });

  test("converts unread email row coordinate clicks to descendant AX links", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const runner: StepRunner = async (step) => {
      calls.push({ tool: step.tool, args: step.args });
      if (step.tool === "get_window_state") {
        return {
          ok: true,
          stdout: [
            '- [305] AXRow "unread, The Information , OpenAI’s AWS Push Comes As Customers Embrace Rivals , 14:36"',
            "  - [306] AXCell",
            "  - [320] AXCell",
            "    - [321] AXLink",
            '      - [323] AXStaticText "OpenAI’s AWS Push Comes As Customers Embrace Rivals"',
            '- [332] AXRow "starred, unread, Holly , me , Holly 3 , Follow up <> Accel , 14:32"',
            "  - [352] AXLink",
          ].join("\n"),
        };
      }
      return { ok: true };
    };
    const plan: Plan = {
      steps: [
        {
          tool: "click",
          args: { pid: 2793, window_id: 0, x: 700, y: 168 },
          purpose: "Click the most recent unread email row",
        },
      ],
      stopWhen: "email is open",
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: {
        pid: 1838,
        windowId: 10434,
        axIndex: parseAxTreeIndex(
          [
            '- [305] AXRow "unread, The Information , OpenAI’s AWS Push Comes As Customers Embrace Rivals , 14:36"',
            "  - [306] AXCell",
            "  - [320] AXCell",
            "    - [321] AXLink",
            '      - [323] AXStaticText "OpenAI’s AWS Push Comes As Customers Embrace Rivals"',
            '- [332] AXRow "starred, unread, Holly , me , Holly 3 , Follow up <> Accel , 14:32"',
            "  - [352] AXLink",
          ].join("\n"),
        ),
      },
    });
    expect(calls).toEqual([
      {
        tool: "get_window_state",
        args: { pid: 1838, window_id: 10434 },
      },
      {
        tool: "double_click",
        args: { pid: 1838, window_id: 10434, element_index: 321 },
      },
    ]);
  });

  test("refreshes AX before opening message rows from coordinates", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const runner: StepRunner = async (step) => {
      calls.push({ tool: step.tool, args: step.args });
      if (step.tool === "get_window_state") {
        return {
          ok: true,
          stdout: [
            '- [305] AXRow "unread, Ideabrowser , Idea of the Day: Vendor breach bureau , 16:40"',
            "  - [320] AXCell",
            "    - [321] AXLink",
            '      - [323] AXStaticText "Idea of the Day: Vendor breach bureau"',
          ].join("\n"),
        };
      }
      return { ok: true };
    };
    const plan: Plan = {
      steps: [
        {
          tool: "click",
          args: { pid: "$pid", window_id: "$window_id", x: 720, y: 180 },
          purpose: "Open the most recent unread email from Ideabrowser",
        },
      ],
      stopWhen: "email is open",
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: { pid: 1838, windowId: 10434 },
    });
    expect(calls).toEqual([
      {
        tool: "get_window_state",
        args: { pid: 1838, window_id: 10434 },
      },
      {
        tool: "double_click",
        args: { pid: 1838, window_id: 10434, element_index: 321 },
      },
    ]);
  });

  test("refuses blind coordinate clicks for unresolved message rows", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const runner: StepRunner = async (step) => {
      calls.push({ tool: step.tool, args: step.args });
      if (step.tool === "get_window_state") {
        return { ok: true, stdout: "- [1] AXButton (Compose)" };
      }
      return { ok: true };
    };
    const plan: Plan = {
      steps: [
        {
          tool: "click",
          args: { pid: "$pid", window_id: "$window_id", x: 720, y: 180 },
          purpose: "Click the most recent unread email row",
        },
      ],
      stopWhen: "email is open",
    };
    const result = await executePlan(plan, {
      stepRunner: runner,
      initialContext: { pid: 1838, windowId: 10434 },
    });
    expect(result.failedStepIndex).toBe(0);
    expect(result.error).toContain("message row coordinate click");
    expect(calls).toEqual([
      {
        tool: "get_window_state",
        args: { pid: 1838, window_id: 10434 },
      },
    ]);
  });

  test("does not reuse stale AX rows when message row refresh fails", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const runner: StepRunner = async (step) => {
      calls.push({ tool: step.tool, args: step.args });
      if (step.tool === "get_window_state") {
        return { ok: false, error: "window no longer available" };
      }
      return { ok: true };
    };
    const plan: Plan = {
      steps: [
        {
          tool: "click",
          args: { pid: "$pid", window_id: "$window_id", x: 720, y: 180 },
          purpose: "Click the most recent unread email row",
        },
      ],
      stopWhen: "email is open",
    };
    const result = await executePlan(plan, {
      stepRunner: runner,
      initialContext: {
        pid: 1838,
        windowId: 10434,
        axIndex: parseAxTreeIndex(
          [
            '- [305] AXRow "unread, Stale Sender , Stale Subject , 14:36"',
            "  - [321] AXLink",
          ].join("\n"),
        ),
      },
    });
    expect(result.failedStepIndex).toBe(0);
    expect(result.error).toContain("message row coordinate click");
    expect(calls).toEqual([
      {
        tool: "get_window_state",
        args: { pid: 1838, window_id: 10434 },
      },
    ]);
  });

  test("keeps non-message coordinate clicks unchanged", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const runner: StepRunner = async (step) => {
      calls.push({ tool: step.tool, args: step.args });
      return { ok: true };
    };
    const plan: Plan = {
      steps: [
        {
          tool: "click",
          args: { pid: 1, window_id: 2, x: 120, y: 160 },
          purpose: "draw on canvas",
        },
      ],
      stopWhen: "done",
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: {
        pid: 1,
        windowId: 2,
        axIndex: parseAxTreeIndex('- [305] AXRow "unread, Example"\n'),
      },
    });
    expect(calls).toEqual([
      { tool: "click", args: { pid: 1, window_id: 2, x: 120, y: 160 } },
    ]);
  });

  test("repairs drag window_id from context before running", async () => {
    let captured: Record<string, unknown> = {};
    const runner: StepRunner = async (step) => {
      captured = step.args;
      return { ok: true };
    };
    const plan: Plan = {
      steps: [
        {
          tool: "drag",
          args: {
            pid: "$pid",
            from: { x: 10, y: 20 },
            to: { x: 100, y: 120 },
          },
          purpose: "drag on canvas",
        },
      ],
      stopWhen: "done",
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: { pid: 1, windowId: 2 },
    });
    expect(captured).toEqual({
      pid: 1,
      window_id: 2,
      from: { x: 10, y: 20 },
      to: { x: 100, y: 120 },
    });
  });

  test("preserves screenshot dimensions for scaled drag steps", async () => {
    let captured: Record<string, unknown> = {};
    const runner: StepRunner = async (step) => {
      captured = step.args;
      return { ok: true };
    };
    const plan: Plan = {
      steps: [
        {
          tool: "drag",
          args: {
            pid: "$pid",
            window_id: "$window_id",
            from: { x: 10, y: 20 },
            to: { x: 100, y: 120 },
            screenshot_width: 640,
            screenshot_height: 480,
          },
          purpose: "draw a line on canvas",
        },
      ],
      stopWhen: "done",
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: { pid: 1, windowId: 2 },
    });
    expect(captured.screenshot_width).toBe(640);
    expect(captured.screenshot_height).toBe(480);
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

  test("emits a `[open42] about to:` line for each step", async () => {
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

  test("repairs a mismatched pid when the window_id matches context", async () => {
    // Real-world failure: the planner confused an AX element count for a pid
    // while keeping the correct window_id. The window identity is stronger:
    // if it matches the current context, use the owning pid from context.
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "click",
          args: { pid: 2789, window_id: 16412, x: 780, y: 168 },
          purpose: "click target despite a bogus pid",
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
      initialContext: { pid: 1838, windowId: 16412 },
      refreshBeforeAxClick: false,
    });
    expect(captured.pid).toBe(1838);
    expect(captured.window_id).toBe(16412);
  });

  test("fills leased window_id for keyboard-scoped tools", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const plan: Plan = {
      steps: [
        {
          tool: "press_key",
          args: { pid: "$pid", key: "return" },
          purpose: "submit",
        },
        {
          tool: "hotkey",
          args: { pid: "$pid", keys: ["command", "l"] },
          purpose: "focus address field",
        },
        {
          tool: "type_text_chars",
          args: { pid: "$pid", text: "hello" },
          purpose: "type safely",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      calls.push({ tool: step.tool, args: step.args });
      return { ok: true };
    };

    await executePlan(plan, {
      stepRunner: runner,
      initialContext: { pid: 44, windowId: 10 },
      refreshBeforeAxClick: false,
    });

    expect(calls).toEqual([
      { tool: "press_key", args: { pid: 44, window_id: 10, key: "return" } },
      {
        tool: "hotkey",
        args: { pid: 44, window_id: 10, keys: ["command", "l"] },
      },
      {
        tool: "type_text_chars",
        args: { pid: 44, window_id: 10, text: "hello" },
      },
    ]);
  });

  test("fills browser lease args for repeated open_url navigation", async () => {
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "open_url",
          args: {
            url: "https://mail.google.com/mail/u/0/#search/is:unread",
          },
          purpose: "navigate within the task Gmail tab",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      captured = step.args;
      return {
        ok: true,
        stdout: JSON.stringify({
          pid: step.args.pid,
          window_id: step.args.window_id,
          window_uid: step.args.window_uid,
          bundle_id: step.args.bundle_id,
          browser_window_id: step.args.browser_window_id,
          tab_id: step.args.tab_id,
        }),
      };
    };

    await executePlan(plan, {
      stepRunner: runner,
      initialContext: {
        pid: 1838,
        windowId: 16412,
        windowUid: "cgwindow:16412:pid:1838:gen:1",
        bundleId: "com.google.Chrome",
        browserWindowId: 1377889767,
        tabId: 1377889990,
      },
      refreshBeforeAxClick: false,
    });

    expect(captured).toEqual({
      url: "https://mail.google.com/mail/u/0/#search/is:unread",
      pid: 1838,
      window_id: 16412,
      window_uid: "cgwindow:16412:pid:1838:gen:1",
      bundle_id: "com.google.Chrome",
      browser_window_id: 1377889767,
      tab_id: 1377889990,
    });
  });

  test("scrubs app-name discovery args when context has a concrete target", async () => {
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "get_window_state",
          args: { app_name: "Google Chrome" },
          purpose: "snapshot the known target",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      captured = step.args;
      return { ok: true, stdout: "- [1] AXButton (OK)\n" };
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: { pid: 1838, windowId: 16412 },
    });
    expect(captured).toEqual({ pid: 1838, window_id: 16412 });
  });

  test("absorbs pid and windowId from the selected list_windows record", async () => {
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "list_windows",
          args: {},
          purpose: "discover windows",
        },
        {
          tool: "click",
          args: { pid: "$pid", window_id: "$window_id", element_index: 12 },
          purpose: "click in discovered window",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      if (step.tool === "list_windows") {
        return {
          ok: true,
          stdout: JSON.stringify({
            windows: [
              {
                pid: 111,
                window_id: 222,
                bounds: { width: 1, height: 1 },
              },
              {
                pid: 1838,
                window_id: 16412,
                bounds: { width: 1920, height: 975 },
              },
            ],
          }),
        };
      }
      captured = step.args;
      return { ok: true };
    };
    await executePlan(plan, {
      stepRunner: runner,
      refreshBeforeAxClick: false,
    });
    expect(captured.pid).toBe(1838);
    expect(captured.window_id).toBe(16412);
  });

  test("keeps explicit open_url window instead of stale app windows", async () => {
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "open_url",
          args: {
            bundle_id: "com.google.Chrome",
            url: "https://mail.google.com/",
          },
          purpose: "open Gmail in Chrome",
        },
        {
          tool: "click",
          args: { pid: "$pid", window_id: "$window_id", element_index: 12 },
          purpose: "continue in opened tab",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      if (step.tool === "open_url") {
        return {
          ok: true,
          stdout: JSON.stringify({
            pid: 1838,
            window_id: 456,
            windows: [
              {
                pid: 1838,
                window_id: 111,
                title: "Inbox - Gmail",
                bounds: { width: 1440, height: 900 },
              },
            ],
          }),
        };
      }
      captured = step.args;
      return { ok: true };
    };
    await executePlan(plan, {
      stepRunner: runner,
      refreshBeforeAxClick: false,
    });
    expect(captured.pid).toBe(1838);
    expect(captured.window_id).toBe(456);
  });

  test("open_url anchors to frontmost returned window over a larger stale window", async () => {
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "open_url",
          args: {
            bundle_id: "com.google.Chrome",
            url: "https://mail.google.com/",
          },
          purpose: "open Gmail in Chrome",
        },
        {
          tool: "click",
          args: { pid: "$pid", window_id: "$window_id", element_index: 12 },
          purpose: "continue in opened tab",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      if (step.tool === "open_url") {
        return {
          ok: true,
          stdout: JSON.stringify({
            pid: 1838,
            windows: [
              {
                pid: 1838,
                window_id: 111,
                title: "A different large Chrome window",
                bounds: { width: 3000, height: 1200 },
                on_current_space: true,
                is_on_screen: true,
                z_index: 1,
              },
              {
                pid: 1838,
                window_id: 456,
                title: "Inbox - Gmail",
                bounds: { width: 1000, height: 760 },
                on_current_space: true,
                is_on_screen: true,
                z_index: 100,
              },
            ],
          }),
        };
      }
      captured = step.args;
      return { ok: true };
    };

    await executePlan(plan, {
      stepRunner: runner,
      refreshBeforeAxClick: false,
    });

    expect(captured.pid).toBe(1838);
    expect(captured.window_id).toBe(456);
  });

  test("open_url selection prefers the window whose tab changed after navigation", () => {
    const selected = pickOpenedUrlWindow(
      [
        {
          pid: 1838,
          window_id: 111,
          title: "Inbox - Gmail",
          bounds: { width: 1920, height: 1000 },
          is_on_screen: true,
          on_current_space: true,
          z_index: 20,
        },
        {
          pid: 1838,
          window_id: 456,
          title: "New Tab",
          bounds: { width: 1100, height: 800 },
          is_on_screen: true,
          on_current_space: true,
          z_index: 10,
        },
      ],
      [
        {
          pid: 1838,
          window_id: 111,
          title: "Inbox - Gmail",
          bounds: { width: 1920, height: 1000 },
          is_on_screen: true,
          on_current_space: true,
          z_index: 20,
        },
        {
          pid: 1838,
          window_id: 456,
          title: "Inbox - Gmail",
          bounds: { width: 1100, height: 800 },
          is_on_screen: true,
          on_current_space: true,
          z_index: 100,
        },
      ],
      "https://mail.google.com/",
    );

    expect(selected?.window_id).toBe(456);
  });

  test("open_url selection prefers a newly created matching window", () => {
    const selected = pickOpenedUrlWindow(
      [
        {
          pid: 1838,
          window_id: 111,
          title: "Inbox - Gmail",
          bounds: { width: 1920, height: 1000 },
          is_on_screen: true,
          on_current_space: true,
          z_index: 20,
        },
      ],
      [
        {
          pid: 1838,
          window_id: 111,
          title: "Inbox - Gmail",
          bounds: { width: 1920, height: 1000 },
          is_on_screen: true,
          on_current_space: true,
          z_index: 20,
        },
        {
          pid: 1838,
          window_id: 789,
          title: "Inbox - Gmail",
          bounds: { width: 900, height: 700 },
          is_on_screen: true,
          on_current_space: true,
          z_index: 100,
        },
      ],
      "https://mail.google.com/",
    );

    expect(selected?.window_id).toBe(789);
  });

  test("open_url selection keeps a newly created window despite focus drift", () => {
    const selected = pickOpenedUrlWindow(
      [
        {
          pid: 1838,
          window_id: 111,
          title: "Inbox - Gmail",
          bounds: { width: 1920, height: 1000 },
          is_focused: true,
          is_key: true,
          is_on_screen: true,
          on_current_space: true,
          z_index: 900,
        },
      ],
      [
        {
          pid: 1838,
          window_id: 111,
          title: "Inbox - Gmail",
          bounds: { width: 1920, height: 1000 },
          is_focused: true,
          is_key: true,
          is_on_screen: true,
          on_current_space: true,
          z_index: 1000,
        },
        {
          pid: 1838,
          window_id: 789,
          title: "Inbox - Gmail",
          bounds: { width: 900, height: 700 },
          is_focused: false,
          is_key: false,
          is_on_screen: true,
          on_current_space: true,
          z_index: 1,
        },
      ],
      "https://mail.google.com/",
    );

    expect(selected?.window_id).toBe(789);
  });

  test("open_url tab selection uses tab deltas and owning window ids", () => {
    const selected = pickOpenedUrlTab(
      [
        {
          pid: 1838,
          tab_id: 1,
          title: "Inbox - Gmail",
          url: "https://mail.google.com/mail/u/1/#inbox",
          is_active: true,
          owning_window_id: 111,
        },
        {
          pid: 1838,
          tab_id: 2,
          title: "New Tab",
          url: "chrome://newtab/",
          is_active: true,
          owning_window_id: 456,
        },
      ],
      [
        {
          pid: 1838,
          tab_id: 1,
          title: "Inbox - Gmail",
          url: "https://mail.google.com/mail/u/1/#inbox",
          is_active: true,
          owning_window_id: 111,
        },
        {
          pid: 1838,
          tab_id: 2,
          title: "Inbox - Gmail",
          url: "https://mail.google.com/mail/u/1/#inbox",
          is_active: true,
          owning_window_id: 456,
        },
      ],
      "https://mail.google.com/",
    );

    expect(selected?.tab_id).toBe(2);
    expect(selected?.owning_window_id).toBe(456);
  });

  test("open_url tab selection returns undefined without a strong signal", () => {
    const selected = pickOpenedUrlTab(
      [],
      [
        {
          pid: 1838,
          tab_id: 1,
          title: "A different app",
          url: "https://example.com/",
          is_active: true,
          owning_window_id: 111,
        },
      ],
      "https://mail.google.com/",
    );

    expect(selected).toBeUndefined();
  });

  test("preserves the anchored window when later list_windows sees many usable windows", async () => {
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "list_windows",
          args: { pid: "$pid" },
          purpose: "inspect windows",
        },
        {
          tool: "click",
          args: { pid: "$pid", window_id: "$window_id", element_index: 12 },
          purpose: "continue in anchored window",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      if (step.tool === "list_windows") {
        return {
          ok: true,
          stdout: JSON.stringify({
            windows: [
              {
                pid: 1838,
                window_id: 111,
                title: "Inbox - Gmail",
                bounds: { width: 1920, height: 1000 },
                on_current_space: true,
                is_on_screen: true,
                z_index: 100,
              },
              {
                pid: 1838,
                window_id: 456,
                title: "Gmail",
                bounds: { width: 1000, height: 800 },
                on_current_space: true,
                is_on_screen: true,
                z_index: 1,
              },
            ],
          }),
        };
      }
      captured = step.args;
      return { ok: true };
    };
    await executePlan(plan, {
      stepRunner: runner,
      initialContext: { pid: 1838, windowId: 456 },
      refreshBeforeAxClick: false,
    });
    expect(captured.pid).toBe(1838);
    expect(captured.window_id).toBe(456);
  });

  test("does not poison anchored context from list_windows on another pid", async () => {
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "list_windows",
          args: { pid: 2820 },
          purpose: "inspect another Chrome process",
        },
        {
          tool: "click",
          args: { pid: "$pid", window_id: "$window_id", element_index: 12 },
          purpose: "continue in the original task window",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      if (step.tool === "list_windows") {
        return {
          ok: true,
          stdout: JSON.stringify({
            windows: [
              {
                pid: 2820,
                window_id: 555,
                title: "Different Chrome window",
                bounds: { width: 1440, height: 900 },
                on_current_space: true,
                is_on_screen: true,
              },
            ],
          }),
        };
      }
      captured = step.args;
      return { ok: true };
    };

    await executePlan(plan, {
      stepRunner: runner,
      initialContext: { pid: 1838, windowId: 16412 },
      refreshBeforeAxClick: false,
    });

    expect(captured.pid).toBe(1838);
    expect(captured.window_id).toBe(16412);
  });

  test("reacquires an anchored window by exact title when the window id changes", async () => {
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "list_windows",
          args: { pid: "$pid" },
          purpose: "refresh windows after app recreated the document window",
        },
        {
          tool: "click",
          args: { pid: "$pid", window_id: "$window_id", element_index: 12 },
          purpose: "continue in the same document window",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      if (step.tool === "list_windows") {
        return {
          ok: true,
          stdout: JSON.stringify({
            windows: [
              {
                pid: 44,
                window_id: 20,
                title: "Target Figma file",
                bounds: { width: 1200, height: 800 },
              },
              {
                pid: 44,
                window_id: 30,
                title: "Other Figma file",
                bounds: { width: 1400, height: 900 },
              },
            ],
          }),
        };
      }
      captured = step.args;
      return { ok: true };
    };

    await executePlan(plan, {
      stepRunner: runner,
      initialContext: {
        pid: 44,
        windowId: 10,
        windowTitle: "Target Figma file",
      },
      refreshBeforeAxClick: false,
    });

    expect(captured.pid).toBe(44);
    expect(captured.window_id).toBe(20);
  });

  test("does not reacquire by title when the replacement is ambiguous", async () => {
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "list_windows",
          args: { pid: "$pid" },
          purpose: "refresh windows",
        },
        {
          tool: "click",
          args: { pid: "$pid", window_id: "$window_id", element_index: 12 },
          purpose: "continue in pinned window",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      if (step.tool === "list_windows") {
        return {
          ok: true,
          stdout: JSON.stringify({
            windows: [
              {
                pid: 44,
                window_id: 20,
                title: "Untitled",
                bounds: { width: 1200, height: 800 },
              },
              {
                pid: 44,
                window_id: 30,
                title: "Untitled",
                bounds: { width: 1400, height: 900 },
              },
            ],
          }),
        };
      }
      captured = step.args;
      return { ok: true };
    };

    await executePlan(plan, {
      stepRunner: runner,
      initialContext: { pid: 44, windowId: 10, windowTitle: "Untitled" },
      refreshBeforeAxClick: false,
    });

    expect(captured.pid).toBe(44);
    expect(captured.window_id).toBe(10);
  });

  test("revalidates the window lease before a targeted action", async () => {
    const calls: string[] = [];
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "click",
          args: { pid: "$pid", window_id: "$window_id", element_index: 12 },
          purpose: "click in leased document window",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      calls.push(step.tool);
      if (step.tool === "validate_window") {
        return {
          ok: true,
          stdout: JSON.stringify({
            status: "missing",
            possible_replacements: [
              {
                pid: 44,
                window_id: 20,
                window_uid: "cgwindow:20:pid:44:gen:1",
                title: "Target Figma file",
                bounds: { width: 1200, height: 800 },
              },
            ],
          }),
        };
      }
      captured = step.args;
      return { ok: true };
    };

    await executePlan(plan, {
      stepRunner: runner,
      initialContext: {
        pid: 44,
        windowId: 10,
        windowUid: "cgwindow:10:pid:44:gen:1",
        windowTitle: "Target Figma file",
      },
      refreshBeforeAxClick: false,
      revalidateWindowLease: true,
    });

    expect(calls).toEqual(["validate_window", "click"]);
    expect(captured.pid).toBe(44);
    expect(captured.window_id).toBe(20);
  });

  test("refuses to act when window lease revalidation is ambiguous", async () => {
    let clicked = false;
    const plan: Plan = {
      steps: [
        {
          tool: "click",
          args: { pid: "$pid", window_id: "$window_id", element_index: 12 },
          purpose: "click in leased document window",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      if (step.tool === "validate_window") {
        return {
          ok: true,
          stdout: JSON.stringify({
            status: "missing",
            possible_replacements: [
              {
                pid: 44,
                window_id: 20,
                title: "Untitled",
                bounds: { width: 1200, height: 800 },
              },
              {
                pid: 44,
                window_id: 30,
                title: "Untitled",
                bounds: { width: 1400, height: 900 },
              },
            ],
          }),
        };
      }
      clicked = true;
      return { ok: true };
    };

    const result = await executePlan(plan, {
      stepRunner: runner,
      initialContext: {
        pid: 44,
        windowId: 10,
        windowUid: "cgwindow:10:pid:44:gen:1",
        windowTitle: "Untitled",
      },
      refreshBeforeAxClick: false,
      revalidateWindowLease: true,
    });

    expect(clicked).toBe(false);
    expect(result.error).toContain("window lease lost");
    expect(result.error).toContain("Refusing to switch");
  });

  test("seeds pid and windowId from get_window_state args when stdout is text", async () => {
    let captured: Record<string, unknown> = {};
    const plan: Plan = {
      steps: [
        {
          tool: "get_window_state",
          args: { pid: 14002, window_id: 3745 },
          purpose: "snapshot",
        },
        {
          tool: "click",
          args: { pid: "$pid", __selector: { title: "2", role: "AXButton" } },
          purpose: "press 2",
        },
      ],
      stopWhen: "done",
    };
    const runner: StepRunner = async (step) => {
      if (step.tool === "click") captured = step.args;
      if (step.tool === "get_window_state")
        return { ok: true, stdout: "- [16] AXButton (2) id=Two\n" };
      return { ok: true };
    };
    await executePlan(plan, { stepRunner: runner });
    expect(captured.pid).toBe(14002);
    expect(captured.window_id).toBe(3745);
    expect(captured.element_index).toBe(16);
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

  test("parses quoted AX titles used by macOS menu bar items", () => {
    const entries = parseAxTreeIndex(`
- AXApplication "Figma"
  - [4] AXMenuBar actions=[AXCancel]
    - [9] AXMenuBarItem "File" actions=[AXCancel, AXPick]
`);
    expect(entries.find((entry) => entry.index === 9)?.title).toBe("File");
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

  test("numeric ax_id falls back to element index when the planner confuses [N] for id", () => {
    expect(resolveSelector(entries, { ax_id: "2" })).toBe(2);
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

  test("title_contains + role resolves long AX row labels", () => {
    const rowEntries = parseAxTreeIndex(
      [
        '- [267] AXRow "unread, Mobbin , Monday Mobile Drop , 12:14 , New mobile apps on Mobbin this week."',
        '- [301] AXRow "unread, Pinterest , Ricc, back to your happy place , 12:03"',
      ].join("\n"),
    );
    expect(
      resolveSelector(rowEntries, {
        title_contains: "Monday Mobile Drop",
        role: "AXRow",
      }),
    ).toBe(267);
  });

  test("title_contains remains ambiguous without an ordinal", () => {
    const rowEntries = parseAxTreeIndex(
      [
        '- [1] AXRow "unread, Pinterest , First"',
        '- [2] AXRow "unread, Pinterest , Second"',
      ].join("\n"),
    );
    expect(
      resolveSelector(rowEntries, {
        title_contains: "Pinterest",
        role: "AXRow",
      }),
    ).toBeNull();
    expect(
      resolveSelector(rowEntries, {
        title_contains: "Pinterest",
        role: "AXRow",
        ordinal: 1,
      }),
    ).toBe(2);
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

  test("clears stale AX state when refresh returns no addressable entries", async () => {
    let capturedClickArgs: Record<string, unknown> = {};
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
      if (step.tool === "get_window_state") {
        return { ok: true, stdout: "window state unavailable\n" };
      }
      capturedClickArgs = step.args;
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
    expect(capturedClickArgs.element_index).toBeUndefined();
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
