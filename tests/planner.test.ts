import { describe, expect, test } from "bun:test";
import { type PlannerClient, generatePlan } from "../src/planner.ts";

const SAMPLE_TASK =
  "Use Calculator to compute 17 times 23. Stop when the display shows 391.";

describe("planner", () => {
  test("calls the planner client exactly once and parses returned JSON", async () => {
    let calls = 0;
    let lastPrompt = "";
    const client: PlannerClient = {
      async generatePlanText(prompt) {
        calls++;
        lastPrompt = prompt;
        return JSON.stringify({
          steps: [
            {
              tool: "launch_app",
              args: { bundle_id: "com.apple.calculator" },
              purpose: "open Calculator",
            },
            {
              tool: "click",
              args: { pid: 0, window_id: 0, element_index: 5 },
              purpose: "press 1",
            },
          ],
          stopWhen: "display shows 391",
        });
      },
    };

    const plan = await generatePlan({
      taskPrompt: SAMPLE_TASK,
      currentStateSummary: "no relevant apps running",
      claudeClient: client,
    });
    expect(calls).toBe(1);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.tool).toBe("launch_app");
    expect(plan.steps[0]?.purpose).toBe("open Calculator");
    expect(plan.stopWhen).toBe("display shows 391");
    // The task and current state must be threaded into the prompt the
    // planner sends to the LLM so it can produce a grounded plan.
    expect(lastPrompt).toContain("Use Calculator to compute");
    expect(lastPrompt).toContain("no relevant apps running");
  });

  test("strips markdown fences around the JSON response", async () => {
    const client: PlannerClient = {
      async generatePlanText() {
        return [
          "```json",
          JSON.stringify({
            steps: [
              {
                tool: "press_key",
                args: { pid: 1, key: "return" },
                purpose: "press return",
              },
            ],
            stopWhen: "done",
          }),
          "```",
        ].join("\n");
      },
    };
    const plan = await generatePlan({
      taskPrompt: SAMPLE_TASK,
      currentStateSummary: "",
      claudeClient: client,
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.tool).toBe("press_key");
  });

  test("extracts the first balanced JSON object when the model emits prose and a second plan", async () => {
    const client: PlannerClient = {
      async generatePlanText() {
        return [
          "I should inspect first.",
          JSON.stringify({
            steps: [
              {
                tool: "click",
                args: { pid: "$pid", window_id: "$window_id" },
                purpose: "first plan",
              },
            ],
            stopWhen: "first",
          }),
          "Let me restart with a better plan:",
          JSON.stringify({
            steps: [
              {
                tool: "click",
                args: { pid: "$pid", window_id: "$window_id" },
                purpose: "second plan",
              },
            ],
            stopWhen: "second",
          }),
        ].join("\n");
      },
    };
    const plan = await generatePlan({
      taskPrompt: SAMPLE_TASK,
      currentStateSummary: "",
      claudeClient: client,
    });
    expect(plan.stopWhen).toBe("first");
    expect(plan.steps[0]?.purpose).toBe("first plan");
  });

  test("normalizes shifted-symbol press_key steps to hotkey steps", async () => {
    const client: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({
          steps: [
            {
              tool: "press_key",
              args: { pid: 1, key: "*" },
              purpose: "press multiply",
            },
            {
              tool: "press_key",
              args: { pid: 1, key: "A" },
              purpose: "press uppercase A",
            },
          ],
          stopWhen: "done",
        });
      },
    };
    const plan = await generatePlan({
      taskPrompt: SAMPLE_TASK,
      currentStateSummary: "",
      claudeClient: client,
    });
    expect(plan.steps[0]?.tool).toBe("hotkey");
    expect(plan.steps[0]?.args).toEqual({ pid: 1, keys: ["shift", "8"] });
    expect(plan.steps[1]?.tool).toBe("hotkey");
    expect(plan.steps[1]?.args).toEqual({ pid: 1, keys: ["shift", "a"] });
  });

  test("throws when the response is not valid JSON", async () => {
    const client: PlannerClient = {
      async generatePlanText() {
        return "this is not JSON at all";
      },
    };
    await expect(
      generatePlan({
        taskPrompt: SAMPLE_TASK,
        currentStateSummary: "",
        claudeClient: client,
      }),
    ).rejects.toThrow(/parse/i);
  });

  test("throws when the plan shape is wrong (missing steps)", async () => {
    const client: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({ stopWhen: "done" });
      },
    };
    await expect(
      generatePlan({
        taskPrompt: SAMPLE_TASK,
        currentStateSummary: "",
        claudeClient: client,
      }),
    ).rejects.toThrow(/steps/i);
  });

  test("throws when a step is missing required fields", async () => {
    const client: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({
          steps: [{ tool: "click" }],
          stopWhen: "done",
        });
      },
    };
    await expect(
      generatePlan({
        taskPrompt: SAMPLE_TASK,
        currentStateSummary: "",
        claudeClient: client,
      }),
    ).rejects.toThrow(/args/i);
  });

  test("fills a default purpose when the model omits one", async () => {
    const client: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({
          steps: [{ tool: "click", args: { pid: 1, x: 10, y: 20 } }],
          stopWhen: "done",
        });
      },
    };
    const plan = await generatePlan({
      taskPrompt: SAMPLE_TASK,
      currentStateSummary: "",
      claudeClient: client,
    });
    expect(plan.steps[0]?.purpose).toBe("run click");
  });

  test("throws when model emits more steps than the batch cap", async () => {
    const client: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({
          steps: [
            { tool: "click", args: {}, purpose: "one" },
            { tool: "click", args: {}, purpose: "two" },
          ],
          stopWhen: "done",
        });
      },
    };
    await expect(
      generatePlan({
        taskPrompt: SAMPLE_TASK,
        currentStateSummary: "",
        claudeClient: client,
        maxStepsPerPlan: 1,
      }),
    ).rejects.toThrow(/max allowed/i);
  });

  test("accepts non-action statuses for done or blocked states", async () => {
    const client: PlannerClient = {
      async generatePlanText() {
        return JSON.stringify({
          status: "done",
          steps: [],
          stopWhen: "display shows 391",
          message: "already complete",
        });
      },
    };
    const plan = await generatePlan({
      taskPrompt: SAMPLE_TASK,
      currentStateSummary: "display shows 391",
      claudeClient: client,
    });
    expect(plan.status).toBe("done");
    expect(plan.steps).toHaveLength(0);
    expect(plan.message).toBe("already complete");
  });

  test("threads executed-step history and live AX tree into the replan prompt", async () => {
    let lastPrompt = "";
    const client: PlannerClient = {
      async generatePlanText(prompt) {
        lastPrompt = prompt;
        return JSON.stringify({ steps: [], stopWhen: "done" });
      },
    };
    await generatePlan({
      taskPrompt: SAMPLE_TASK,
      currentStateSummary: "",
      claudeClient: client,
      replanContext: {
        failedStepIndex: 4,
        failedStep: {
          tool: "click",
          args: { __title: "=" },
          purpose: "press equals",
        },
        errorMessage: "stale element_index",
        executedSteps: [
          {
            tool: "click",
            args: { __title: "1" },
            purpose: "press 1",
          },
          {
            tool: "click",
            args: { __title: "7" },
            purpose: "press 7",
          },
        ],
        liveAxTree: "- [12] AXStaticText (17) id=display\n",
      },
    });
    expect(lastPrompt).toContain("Already-executed steps");
    expect(lastPrompt).toContain("press 1");
    expect(lastPrompt).toContain("press 7");
    expect(lastPrompt).toContain("Live AX tree");
    expect(lastPrompt).toContain("AXStaticText (17)");
    expect(lastPrompt).toMatch(/SUFFIX/i);
  });

  test("system prompt is small, generic, and grounded in intent + screenshot + AX tree", async () => {
    let lastPrompt = "";
    const client: PlannerClient = {
      async generatePlanText(prompt) {
        lastPrompt = prompt;
        return JSON.stringify({ steps: [], stopWhen: "done" });
      },
    };
    await generatePlan({
      taskPrompt: SAMPLE_TASK,
      currentStateSummary: "",
      claudeClient: client,
    });
    // The system-guidance preamble (everything before "User task:") is the
    // first principles block we shipped — extract it so we measure that, not
    // the task / replan / state appendices.
    const guidance = lastPrompt.split("\nUser task:")[0] ?? "";
    const guidanceLines = guidance.split("\n").length;
    // ~50 lines is a generous ceiling for "first principles, not a tutorial".
    expect(guidanceLines).toBeLessThanOrEqual(50);
    // Refers to the live planning inputs.
    expect(guidance).toMatch(/user's task/i);
    expect(guidance).toMatch(/screenshot/i);
    expect(guidance).toMatch(/AX tree/i);
    // No app-specific hand-holding.
    expect(guidance).not.toContain("Calculator");
    expect(guidance).not.toContain("ANTI-PATTERN");
  });

  test("replan context tells the planner to switch primitive on retry", async () => {
    let lastPrompt = "";
    const client: PlannerClient = {
      async generatePlanText(prompt) {
        lastPrompt = prompt;
        return JSON.stringify({ steps: [], stopWhen: "done" });
      },
    };
    await generatePlan({
      taskPrompt: SAMPLE_TASK,
      currentStateSummary: "",
      claudeClient: client,
      replanContext: {
        failedStepIndex: 1,
        failedStep: {
          tool: "type_text",
          args: { pid: 1, text: "5*2" },
          purpose: "enter expression",
        },
        errorMessage: "assertion failed: expected '10' got '0'",
      },
    });
    // The replan section should explicitly instruct switching primitive
    // (otherwise Sonnet retries the same broken type_text + assert loop).
    expect(lastPrompt).toMatch(/switch.*tool|switch primitive/i);
    expect(lastPrompt).toMatch(/type_text/i);
  });

  test("threads optional replan context (failed step + error) into the prompt", async () => {
    let lastPrompt = "";
    const client: PlannerClient = {
      async generatePlanText(prompt) {
        lastPrompt = prompt;
        return JSON.stringify({ steps: [], stopWhen: "done" });
      },
    };
    await generatePlan({
      taskPrompt: SAMPLE_TASK,
      currentStateSummary: "Calculator window 42 visible",
      claudeClient: client,
      replanContext: {
        failedStepIndex: 3,
        failedStep: {
          tool: "click",
          args: { pid: 0, element_index: 99 },
          purpose: "press 7",
        },
        errorMessage: "element_index 99 not found",
      },
    });
    expect(lastPrompt).toContain("element_index 99 not found");
    expect(lastPrompt).toContain("press 7");
    // Should mention the failure index so the model knows where to resume.
    expect(lastPrompt).toMatch(/step 3|step #3|step index 3/i);
  });

  test("forwards image paths to the planner client when provided", async () => {
    let receivedImages: string[] | undefined;
    const client: PlannerClient = {
      async generatePlanText(_prompt, imagePaths) {
        receivedImages = imagePaths;
        return JSON.stringify({ steps: [], stopWhen: "done" });
      },
    };
    await generatePlan({
      taskPrompt: SAMPLE_TASK,
      currentStateSummary: "",
      claudeClient: client,
      imagePaths: ["/tmp/showme-discovery-abc.png"],
    });
    expect(receivedImages).toEqual(["/tmp/showme-discovery-abc.png"]);
  });

  test("works without image paths (text-only fallback)", async () => {
    let receivedImages: string[] | undefined;
    const client: PlannerClient = {
      async generatePlanText(_prompt, imagePaths) {
        receivedImages = imagePaths;
        return JSON.stringify({ steps: [], stopWhen: "done" });
      },
    };
    await generatePlan({
      taskPrompt: SAMPLE_TASK,
      currentStateSummary: "",
      claudeClient: client,
    });
    // Default to empty array so production planner doesn't have to guard.
    expect(receivedImages).toEqual([]);
  });
});
