import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicClaudeClient, compileSkillMd } from "../src/compile.ts";
import { validateSkillMd } from "../src/schema.ts";

/**
 * Shape-based assertions for the live-API eval. Compile is non-deterministic
 * across model rolls so we deliberately AVOID asserting on specific button
 * labels or literal step text — instead we check that the output is
 * schema-valid (structurally well-formed), the step phase count is in a
 * reasonable range for the task, and the intent block matches the goal
 * domain of the recording.
 */
interface Assertions {
  /** Phase count range — semantic phases, NOT button-by-button steps. */
  step_count_min: number;
  step_count_max: number;
  /**
   * Substrings expected in the intent block (frontmatter). These describe
   * the goal/domain (e.g. "calculator", "reminder") — not button labels.
   * One match anywhere in the rendered intent suffices per phrase.
   */
  intent_must_mention: string[];
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
          outputDir: mkdtempSync(join(tmpdir(), `open42-eval-${fx}-`)),
        });

        // Phase count: count "## Steps" body items. Use numbered list lines
        // that occur AFTER "## Steps" up to the next top-level (## or end).
        const stepsMatch = result.skillMd.match(
          /## Steps\s*\n([\s\S]*?)(?=^##\s|\Z)/m,
        );
        const stepsBody = stepsMatch?.[1] ?? "";
        const stepLines = stepsBody.match(/^\d+\./gm) ?? [];
        expect(stepLines.length).toBeGreaterThanOrEqual(
          assertions.step_count_min,
        );
        expect(stepLines.length).toBeLessThanOrEqual(assertions.step_count_max);

        // Intent block must mention the goal domain. Match against the full
        // SKILL.md (which includes the intent: frontmatter) — case-insensitive.
        const lower = result.skillMd.toLowerCase();
        for (const phrase of assertions.intent_must_mention) {
          expect(lower).toContain(phrase.toLowerCase());
        }
      },
      60_000,
    );
  }
});
