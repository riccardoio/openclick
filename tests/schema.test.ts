import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTargetMetadata, validateSkillMd } from "../src/schema.ts";

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
