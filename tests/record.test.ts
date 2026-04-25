import { describe, expect, test } from "bun:test";
import { resolveSkillTrajectoryPath } from "../src/paths.ts";

describe("paths", () => {
  test("resolveSkillTrajectoryPath returns ~/.cua/skills/<name>/trajectory", () => {
    const result = resolveSkillTrajectoryPath("triage-issues");
    expect(result).toMatch(/\.cua\/skills\/triage-issues\/trajectory$/);
  });
});
