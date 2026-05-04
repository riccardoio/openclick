import { describe, expect, test } from "bun:test";
import { normalizePlanStep } from "../src/planner.ts";

describe("normalizePlanStep — hotkey shifted-symbol normalization", () => {
  test("rewrites a single shifted symbol to ['shift', base]", () => {
    const step = normalizePlanStep({
      tool: "hotkey",
      args: { keys: ["+"] },
      purpose: "Press +",
    });
    expect(step.args.keys).toEqual(["shift", "="]);
  });

  test("rewrites ['shift','+'] to ['shift','=']", () => {
    const step = normalizePlanStep({
      tool: "hotkey",
      args: { keys: ["shift", "+"] },
      purpose: "Press shift+plus",
    });
    expect(step.args.keys).toEqual(["shift", "="]);
  });

  test("rewrites ['command','+'] to ['command','shift','=']", () => {
    const step = normalizePlanStep({
      tool: "hotkey",
      args: { keys: ["command", "+"] },
      purpose: "Zoom in",
    });
    expect(step.args.keys).toEqual(["command", "shift", "="]);
  });

  test("rewrites ['?'] to ['shift', '/']", () => {
    const step = normalizePlanStep({
      tool: "hotkey",
      args: { keys: ["?"] },
      purpose: "Press ?",
    });
    expect(step.args.keys).toEqual(["shift", "/"]);
  });

  test("rewrites uppercase letter to ['shift', lowercase]", () => {
    const step = normalizePlanStep({
      tool: "hotkey",
      args: { keys: ["A"] },
      purpose: "Press A",
    });
    expect(step.args.keys).toEqual(["shift", "a"]);
  });

  test("rewrites ['command','shift','+'] to ['command','shift','=']", () => {
    const step = normalizePlanStep({
      tool: "hotkey",
      args: { keys: ["command", "shift", "+"] },
      purpose: "Zoom in (already had shift)",
    });
    expect(step.args.keys).toEqual(["command", "shift", "="]);
  });

  test("rewrites ['control','shift','?'] to ['control','shift','/']", () => {
    const step = normalizePlanStep({
      tool: "hotkey",
      args: { keys: ["control", "shift", "?"] },
      purpose: "Help shortcut",
    });
    expect(step.args.keys).toEqual(["control", "shift", "/"]);
  });

  test("leaves a clean modifier+base hotkey unchanged", () => {
    const original = ["command", "l"];
    const step = normalizePlanStep({
      tool: "hotkey",
      args: { keys: original },
      purpose: "Focus address bar",
    });
    expect(step.args.keys).toEqual(original);
  });

  test("leaves ['shift','='] unchanged", () => {
    const original = ["shift", "="];
    const step = normalizePlanStep({
      tool: "hotkey",
      args: { keys: original },
      purpose: "Press =",
    });
    expect(step.args.keys).toEqual(original);
  });

  test("press_key with '+' gets rewritten to hotkey ['shift','=']", () => {
    const step = normalizePlanStep({
      tool: "press_key",
      args: { key: "+" },
      purpose: "Press +",
    });
    expect(step.tool).toBe("hotkey");
    expect(step.args.keys).toEqual(["shift", "="]);
    expect(step.args.key).toBeUndefined();
  });
});
