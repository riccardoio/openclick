import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompileValidationError, compileSkillMd } from "../src/compile.ts";

const tmpOut = (): string => mkdtempSync(join(tmpdir(), "open42-compile-"));

describe("compile", () => {
  test("produces a valid SKILL.md from a trajectory", async () => {
    const trajectoryDir = join(import.meta.dir, "fixtures/calc/trajectory");
    const fakeClaude = {
      callsMade: 0,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      async generate(_args: any) {
        this.callsMade++;
        return `---
name: calc
description: Use Calculator to compute 17 times 23.
target:
  bundle_id: com.apple.calculator
  app_name: Calculator
keyboard_addressable: true
intent:
  goal: Compute 17 × 23 in Calculator.
  success_signals:
    - The display shows 391.
---

# Calculator: 17 × 23

## Goal
Open Calculator and compute 17 × 23.

## Steps
1. Open Calculator.
2. Type 17.
3. Type *.
4. Type 23.
5. Press =.

## Stop conditions
- The display shows the result.
`;
      },
    };

    const result = await compileSkillMd({
      trajectoryDir,
      skillName: "calc-test-1",
      claudeClient: fakeClaude,
      outputDir: tmpOut(),
    });
    expect(result.valid).toBe(true);
    expect(result.skillMd).toContain("name: calc");
    expect(fakeClaude.callsMade).toBe(1);
  });

  test("re-prompts Claude once when first output is invalid", async () => {
    const trajectoryDir = join(import.meta.dir, "fixtures/calc/trajectory");
    const fakeClaude = {
      callsMade: 0,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      async generate(_args: any) {
        this.callsMade++;
        if (this.callsMade === 1) return "no frontmatter at all";
        return `---
name: calc
description: ok now.
target:
  bundle_id: com.apple.calculator
  app_name: Calculator
intent:
  goal: Compute something.
  success_signals:
    - Done.
---
# C
## Steps
1. ok
`;
      },
    };
    const result = await compileSkillMd({
      trajectoryDir,
      skillName: "calc-test-2",
      claudeClient: fakeClaude,
      outputDir: tmpOut(),
    });
    expect(result.valid).toBe(true);
    expect(fakeClaude.callsMade).toBe(2);
  });

  test("passes resolved target metadata to Claude when the trajectory contains it", async () => {
    const trajectoryDir = join(import.meta.dir, "fixtures/calc/trajectory");
    let firstPrompt = "";
    const fakeClaude = {
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      async generate(args: any) {
        firstPrompt ||= args.prompt;
        return `---
name: calc
description: Use Calculator to compute 17 times 23.
target:
  bundle_id: com.apple.calculator
  app_name: Calculator
keyboard_addressable: true
intent:
  goal: Compute 17 × 23 in Calculator.
  success_signals:
    - The display shows 391.
---
# Calculator: 17 × 23
## Goal
Open Calculator and compute 17 × 23.
## Steps
1. Enter the expression.
## Stop conditions
- The display shows the result.
`;
      },
    };

    await compileSkillMd({
      trajectoryDir,
      skillName: "calc-target-metadata",
      claudeClient: fakeClaude,
      outputDir: tmpOut(),
    });

    expect(firstPrompt).toContain("bundle_id: com.apple.calculator");
    expect(firstPrompt).toContain("app_name: Calculator");
    expect(firstPrompt).toContain("use these exact values");
  });

  test("throws CompileValidationError if both attempts are invalid (no file written)", async () => {
    const trajectoryDir = join(import.meta.dir, "fixtures/calc/trajectory");
    const out = tmpOut();
    const fakeClaude = {
      callsMade: 0,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      async generate(_args: any) {
        this.callsMade++;
        return "still no frontmatter";
      },
    };
    await expect(
      compileSkillMd({
        trajectoryDir,
        skillName: "calc-bad",
        claudeClient: fakeClaude,
        outputDir: out,
      }),
    ).rejects.toBeInstanceOf(CompileValidationError);
    expect(fakeClaude.callsMade).toBe(2);
    // No SKILL.md should have been written.
    expect(existsSync(join(out, "SKILL.md"))).toBe(false);
  });
});
