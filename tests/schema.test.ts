import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateSkillMd } from "../src/schema.ts";

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
---
# Title
## Steps
1. step
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /kebab/i.test(e))).toBe(true);
  });
});
