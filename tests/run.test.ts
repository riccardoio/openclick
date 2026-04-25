import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type QueryFn, runSkill } from "../src/run.ts";

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
