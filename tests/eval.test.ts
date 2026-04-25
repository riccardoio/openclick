import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicClaudeClient, compileSkillMd } from "../src/compile.ts";
import { validateSkillMd } from "../src/schema.ts";

interface Assertions {
  must_contain_step_with: string[];
  must_contain_anchor_with_role: string;
  step_count_min: number;
  step_count_max: number;
}

const FIXTURES = ["calc", "triage", "todo"] as const;

// Live eval against the real Anthropic API runs in CI when the key is set,
// and skipped locally otherwise. Each fixture also needs a real `trajectory/`
// directory; if one's missing, the live test for that fixture skips with a
// clear note.
const RUN_LIVE = !!process.env.ANTHROPIC_API_KEY;

describe("eval (offline structure check)", () => {
  for (const fx of FIXTURES) {
    test(`fixture/${fx} has a valid expected.md`, () => {
      const path = join(import.meta.dir, "fixtures", fx, "expected.md");
      const expected = readFileSync(path, "utf-8");
      const v = validateSkillMd(expected);
      expect(v.valid).toBe(true);
      if (!v.valid) console.error(`${fx}: ${v.errors.join(", ")}`);
    });
  }
});

describe.skipIf(!RUN_LIVE)("eval (live Claude API)", () => {
  for (const fx of FIXTURES) {
    const fixtureRoot = join(import.meta.dir, "fixtures", fx);
    const trajectoryDir = join(fixtureRoot, "trajectory");
    const hasTrajectory = existsSync(trajectoryDir);

    test.skipIf(!hasTrajectory)(
      `fixture/${fx} compiles to a valid SKILL.md matching assertions`,
      async () => {
        const assertions = JSON.parse(
          readFileSync(join(fixtureRoot, "assertions.json"), "utf-8"),
        ) as Assertions;

        // compileSkillMd throws CompileValidationError if both attempts produce
        // an invalid SKILL.md. If we get here without throwing, the output is
        // schema-valid by construction.
        const result = await compileSkillMd({
          trajectoryDir,
          skillName: `eval-${fx}`,
          claudeClient: new AnthropicClaudeClient(),
          outputDir: mkdtempSync(join(tmpdir(), `showme-eval-${fx}-`)),
        });

        const stepLines = result.skillMd.match(/^\d+\./gm) ?? [];
        expect(stepLines.length).toBeGreaterThanOrEqual(
          assertions.step_count_min,
        );
        expect(stepLines.length).toBeLessThanOrEqual(assertions.step_count_max);
        const lower = result.skillMd.toLowerCase();
        for (const phrase of assertions.must_contain_step_with) {
          expect(lower).toContain(phrase.toLowerCase());
        }
        // Loose anchor check: the SKILL.md mentions the expected AX role somewhere.
        expect(result.skillMd).toContain(
          assertions.must_contain_anchor_with_role,
        );
      },
      60_000,
    );
  }
});
