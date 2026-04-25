import { describe, expect, test } from "bun:test";
import { type PlannerClient, generatePlan } from "../src/planner.ts";

const SAMPLE_SKILL = `---
name: calc
description: Compute 17 times 23 using Calculator
---
# Calculator: 17x23
## Steps
1. Launch Calculator.
2. Click 1, 7, x, 2, 3, =.
## Stop conditions
- Display shows 391.
`;

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
      skillMd: SAMPLE_SKILL,
      currentStateSummary: "no relevant apps running",
      claudeClient: client,
    });
    expect(calls).toBe(1);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.tool).toBe("launch_app");
    expect(plan.steps[0]?.purpose).toBe("open Calculator");
    expect(plan.stopWhen).toBe("display shows 391");
    // The skill body and current state must be threaded into the prompt the
    // planner sends to the LLM so it can produce a grounded plan.
    expect(lastPrompt).toContain("Calculator: 17x23");
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
      skillMd: SAMPLE_SKILL,
      currentStateSummary: "",
      claudeClient: client,
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.tool).toBe("press_key");
  });

  test("throws when the response is not valid JSON", async () => {
    const client: PlannerClient = {
      async generatePlanText() {
        return "this is not JSON at all";
      },
    };
    await expect(
      generatePlan({
        skillMd: SAMPLE_SKILL,
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
        skillMd: SAMPLE_SKILL,
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
        skillMd: SAMPLE_SKILL,
        currentStateSummary: "",
        claudeClient: client,
      }),
    ).rejects.toThrow(/args|purpose/i);
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
      skillMd: SAMPLE_SKILL,
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

  test("system prompt advises keyboard-first execution and gives both example modes", async () => {
    let lastPrompt = "";
    const client: PlannerClient = {
      async generatePlanText(prompt) {
        lastPrompt = prompt;
        return JSON.stringify({ steps: [], stopWhen: "done" });
      },
    };
    await generatePlan({
      skillMd: SAMPLE_SKILL,
      currentStateSummary: "",
      claudeClient: client,
    });
    // Keyboard-first guidance is present.
    expect(lastPrompt).toMatch(/keyboard-first/i);
    // Both example modes are present.
    expect(lastPrompt).toContain("type_text");
    expect(lastPrompt).toContain("17*23");
    expect(lastPrompt).toContain("Labels");
    // Warns against press_key("*").
    expect(lastPrompt).toMatch(/press_key.*"\*"|press_key\("\*"\)/);
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
      skillMd: SAMPLE_SKILL,
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
});
