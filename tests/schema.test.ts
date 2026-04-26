import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readIntent,
  readTargetMetadata,
  renderIntentForPrompt,
  validateSkillMd,
} from "../src/schema.ts";

const fx = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures/skills", name), "utf-8");

describe("schema", () => {
  test("valid hybrid SKILL.md passes both validators", () => {
    const result = validateSkillMd(fx("valid-hybrid.md"));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("missing name fails with specific error", () => {
    const result = validateSkillMd(fx("missing-name.md"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /name/i.test(e))).toBe(true);
  });

  test("no steps section fails", () => {
    const result = validateSkillMd(fx("no-steps.md"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /steps/i.test(e))).toBe(true);
  });

  test("non-kebab-case name fails", () => {
    const result = validateSkillMd(`---
name: TriageIssues
description: bad casing
target:
  bundle_id: com.example.app
  app_name: Example
---
# Title
## Steps
1. step
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /kebab/i.test(e))).toBe(true);
  });

  test("missing target.bundle_id fails", () => {
    const result = validateSkillMd(`---
name: ok
description: missing target
---
# Title
## Steps
1. step
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /target/.test(e))).toBe(true);
  });

  test("partial target (no app_name) fails with specific error", () => {
    const result = validateSkillMd(`---
name: ok
description: partial target
target:
  bundle_id: com.example.app
---
# Title
## Steps
1. step
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /app_name/.test(e))).toBe(true);
  });

  test("missing intent block fails", () => {
    const result = validateSkillMd(`---
name: ok
description: missing intent
target:
  bundle_id: com.example.app
  app_name: Example
---
# Title
## Steps
1. step
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /intent/.test(e))).toBe(true);
  });

  test("missing intent.goal fails with specific error", () => {
    const result = validateSkillMd(`---
name: ok
description: no goal
target:
  bundle_id: com.example.app
  app_name: Example
intent:
  success_signals:
    - x
---
# Title
## Steps
1. step
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /intent\.goal/.test(e))).toBe(true);
  });

  test("empty intent.success_signals fails", () => {
    const result = validateSkillMd(`---
name: ok
description: empty signals
target:
  bundle_id: com.example.app
  app_name: Example
intent:
  goal: do a thing
  success_signals: []
---
# Title
## Steps
1. step
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /success_signals/.test(e))).toBe(true);
  });

  test("non-string intent.success_signals entries fail validation", () => {
    const result = validateSkillMd(`---
name: ok
description: bad signal types
target:
  bundle_id: com.example.app
  app_name: Example
intent:
  goal: do a thing
  success_signals:
    - done
    - 123
---
# Title
## Steps
1. step
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /success_signals/.test(e))).toBe(true);
  });

  test("rejects coordinate / positional leakage in body", () => {
    const base = `---
name: ok
description: leaks coords
target:
  bundle_id: com.example.app
  app_name: Example
intent:
  goal: do the thing
  success_signals:
    - done
---
# Title
## Steps
1. step
`;
    // y≈ position hint
    expect(
      validateSkillMd(
        `${base}\nThe address bar sits around y≈47-58.\n`,
      ).errors.some((e) => /position|positional/i.test(e)),
    ).toBe(true);
    // pixel-position phrase (the leak pattern: "320px wide", "320px from")
    expect(
      validateSkillMd(
        `${base}\nClick the button 320px from the top.\n`,
      ).errors.some((e) => /pixel/i.test(e)),
    ).toBe(true);
    // Anchors section
    expect(
      validateSkillMd(`${base}\n## Anchors\n- some hint\n`).errors.some((e) =>
        /Anchors/i.test(e),
      ),
    ).toBe(true);
    // pixel/screen coordinates phrase
    expect(
      validateSkillMd(
        `${base}\nUse the pixel coordinates from the screenshot.\n`,
      ).errors.some((e) => /pixel|coordinate/i.test(e)),
    ).toBe(true);
  });

  test("allows legitimate domain words ('GPS coordinates', 'x=5')", () => {
    const base = `---
name: ok
description: real domain words
target:
  bundle_id: com.example.app
  app_name: Example
intent:
  goal: do the thing
  success_signals:
    - done
---
# Title
## Steps
1. step
`;
    // GPS coordinates is a legitimate domain phrase, not a position hint.
    expect(
      validateSkillMd(`${base}\nEnter the GPS coordinates of your location.\n`)
        .valid,
    ).toBe(true);
    // Algebra-style x=5 should pass (no ≈ or ~).
    expect(
      validateSkillMd(`${base}\nSet x = 5 in the form field.\n`).valid,
    ).toBe(true);
    // Bare "320px" with no positional follow-up word should pass.
    expect(
      validateSkillMd(`${base}\nThe icon is rendered at 320px resolution.\n`)
        .valid,
    ).toBe(true);
  });

  test("intent block with goal + non-empty success_signals validates", () => {
    const result = validateSkillMd(`---
name: ok
description: full intent
target:
  bundle_id: com.example.app
  app_name: Example
intent:
  goal: do the thing
  success_signals:
    - the thing is done
---
# Title
## Steps
1. step
`);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("readIntent", () => {
  test("returns full intent when present", () => {
    const md = `---
name: x
description: y
target:
  bundle_id: com.example
  app_name: Example
intent:
  goal: do the thing
  inputs:
    a: 17
    b: 23
  subgoals:
    - phase one
    - phase two
  success_signals:
    - it is done
  observed_input_modes:
    - click
    - type_text
---
# t
## Steps
1. s
`;
    const intent = readIntent(md);
    expect(intent).not.toBeNull();
    expect(intent?.goal).toBe("do the thing");
    expect(intent?.inputs).toEqual({ a: 17, b: 23 });
    expect(intent?.subgoals).toEqual(["phase one", "phase two"]);
    expect(intent?.successSignals).toEqual(["it is done"]);
    expect(intent?.observedInputModes).toEqual(["click", "type_text"]);
  });

  test("returns null when intent is missing", () => {
    const md = `---
name: x
description: y
target:
  bundle_id: com.x
  app_name: X
---
# t
## Steps
1. s
`;
    expect(readIntent(md)).toBeNull();
  });

  test("renderIntentForPrompt produces a stable plain-text block", () => {
    const text = renderIntentForPrompt({
      goal: "compute 17 × 23",
      successSignals: ['display reads "391"'],
      subgoals: ["enter expression", "evaluate"],
      observedInputModes: ["click"],
    });
    expect(text).toContain("Intent:");
    expect(text).toContain("Goal: compute 17 × 23");
    expect(text).toContain("Subgoals:");
    expect(text).toContain("- enter expression");
    expect(text).toContain('display reads "391"');
    expect(text).toContain("Observed input modes: click");
  });
});

describe("readTargetMetadata", () => {
  test("returns structured metadata when frontmatter has it", () => {
    const md = `---
name: calc
description: x
target:
  bundle_id: com.apple.calculator
  app_name: Calculator
keyboard_addressable: true
---
# x
## Steps
1. step
`;
    const meta = readTargetMetadata(md);
    expect(meta).toEqual({
      bundleId: "com.apple.calculator",
      appName: "Calculator",
      keyboardAddressable: true,
    });
  });

  test("returns null when target is missing", () => {
    const md = `---
name: x
description: y
---
# t
## Steps
1. s
`;
    expect(readTargetMetadata(md)).toBeNull();
  });

  test("omits keyboardAddressable when not present", () => {
    const md = `---
name: x
description: y
target:
  bundle_id: com.x
  app_name: X
---
# t
## Steps
1. s
`;
    const meta = readTargetMetadata(md);
    expect(meta?.keyboardAddressable).toBeUndefined();
    expect(meta?.bundleId).toBe("com.x");
  });
});
