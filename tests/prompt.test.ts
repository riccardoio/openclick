import { describe, expect, test } from "bun:test";
import { TOKEN_HARD_CAP, buildCompilePrompt } from "../src/prompt.ts";

describe("prompt", () => {
  test("includes task description, events, and sampled screenshots", () => {
    const prompt = buildCompilePrompt({
      taskName: "calc",
      taskDescription: "calculator 17 times 23",
      // biome-ignore lint/suspicious/noExplicitAny: minimal event for assertion
      events: [{ kind: "click", ts: "x", pid: 1 } as any],
      sampledScreenshotPaths: ["/tmp/step_0001.jpg"],
      truncatedAxTrees: [{ role: "AXWindow", title: "Calc", children: [] }],
    });
    expect(prompt.text).toContain("calculator 17 times 23");
    expect(prompt.text).toContain('"kind":"click"');
    expect(prompt.imageReferences).toEqual(["/tmp/step_0001.jpg"]);
  });

  test("requires structured target.bundle_id + target.app_name in the output", () => {
    const prompt = buildCompilePrompt({
      taskName: "x",
      taskDescription: "y",
      events: [],
      sampledScreenshotPaths: [],
      truncatedAxTrees: [],
    });
    // The compile prompt explicitly tells the model these fields are required.
    expect(prompt.text).toContain("target");
    expect(prompt.text).toContain("bundle_id");
    expect(prompt.text).toContain("app_name");
    expect(prompt.text).toContain("keyboard_addressable");
  });

  test("throws over token cap", () => {
    const huge = "x".repeat(TOKEN_HARD_CAP * 5);
    expect(() =>
      buildCompilePrompt({
        taskName: "big",
        taskDescription: huge,
        events: [],
        sampledScreenshotPaths: [],
        truncatedAxTrees: [],
      }),
    ).toThrow(/too long/i);
  });
});
