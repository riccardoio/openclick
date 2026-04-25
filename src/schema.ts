import { parse as parseYaml } from "yaml";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  frontmatter: Record<string, unknown> | null;
}

export function validateSkillMd(md: string): ValidationResult {
  const errors: string[] = [];
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    return {
      valid: false,
      errors: ["missing YAML frontmatter (---...---)"],
      frontmatter: null,
    };
  }
  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(fmMatch[1] ?? "") as Record<string, unknown>;
  } catch (e) {
    return {
      valid: false,
      errors: [`invalid YAML frontmatter: ${e}`],
      frontmatter: null,
    };
  }
  const body = fmMatch[2] ?? "";

  // Required: name
  if (!fm.name || typeof fm.name !== "string") {
    errors.push("frontmatter must include `name` (string)");
  } else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name)) {
    errors.push("`name` must be kebab-case (e.g. triage-issues)");
  }
  // Required: description
  if (!fm.description || typeof fm.description !== "string") {
    errors.push("frontmatter must include `description` (string)");
  }
  // Required: target.bundle_id + target.app_name. Codex flagged this: the
  // runtime used to fish for a reverse-DNS string in the prose, which is
  // unreliable. Now compile MUST emit them explicitly.
  if (!fm.target || typeof fm.target !== "object") {
    errors.push(
      "frontmatter must include `target` (object) with `bundle_id` and `app_name`",
    );
  } else {
    const t = fm.target as Record<string, unknown>;
    if (typeof t.bundle_id !== "string" || t.bundle_id.length === 0)
      errors.push("frontmatter `target.bundle_id` must be a non-empty string");
    if (typeof t.app_name !== "string" || t.app_name.length === 0)
      errors.push("frontmatter `target.app_name` must be a non-empty string");
  }
  // Required: intent.goal + intent.success_signals (non-empty array). The
  // intent block is what makes SKILL.md context for the planner instead of
  // a literal click-by-click script — the planner reasons about WHAT the
  // user wanted, not HOW they typed it. Other intent.* fields are optional.
  if (!fm.intent || typeof fm.intent !== "object") {
    errors.push(
      "frontmatter must include `intent` (object) with at minimum `goal` and `success_signals`",
    );
  } else {
    const intent = fm.intent as Record<string, unknown>;
    if (typeof intent.goal !== "string" || intent.goal.length === 0)
      errors.push("frontmatter `intent.goal` must be a non-empty string");
    if (
      !Array.isArray(intent.success_signals) ||
      intent.success_signals.length === 0
    )
      errors.push(
        "frontmatter `intent.success_signals` must be a non-empty array",
      );
  }
  // Body: must have a top-level # Title
  if (!/^#\s+\S/m.test(body)) {
    errors.push("body must include a top-level `# Title` heading");
  }
  // Body: must have a ## Steps section
  if (!/^##\s+Steps\b/im.test(body)) {
    errors.push("body must include a `## Steps` section");
  }

  return { valid: errors.length === 0, errors, frontmatter: fm };
}

/**
 * Reads the structured target metadata out of a (validated) SKILL.md.
 * Returns null when frontmatter is malformed or `target` is missing —
 * callers fall back to the legacy prose-scan heuristic.
 */
export function readTargetMetadata(md: string): {
  bundleId: string;
  appName: string;
  keyboardAddressable?: boolean;
} | null {
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return null;
  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(fmMatch[1] ?? "") as Record<string, unknown>;
  } catch {
    return null;
  }
  const target = fm.target as Record<string, unknown> | undefined;
  if (!target) return null;
  const bundleId = target.bundle_id;
  const appName = target.app_name;
  if (typeof bundleId !== "string" || typeof appName !== "string") return null;
  const result: {
    bundleId: string;
    appName: string;
    keyboardAddressable?: boolean;
  } = { bundleId, appName };
  if (typeof fm.keyboard_addressable === "boolean")
    result.keyboardAddressable = fm.keyboard_addressable;
  return result;
}

/**
 * Structured representation of the SKILL.md `intent:` frontmatter block.
 * Returned by {@link readIntent} for the planner to thread into its prompt.
 *
 * Only `goal` and `successSignals` are guaranteed (validateSkillMd enforces
 * them). The other fields surface when the compiler emitted them — callers
 * should treat absence as "skip that section in the planner prompt".
 */
export interface SkillIntent {
  goal: string;
  successSignals: string[];
  inputs?: Record<string, unknown>;
  subgoals?: string[];
  observedInputModes?: string[];
}

/**
 * Parse the `intent:` block from a (validated) SKILL.md frontmatter. Returns
 * null when frontmatter is malformed or the block is missing.
 */
export function readIntent(md: string): SkillIntent | null {
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return null;
  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(fmMatch[1] ?? "") as Record<string, unknown>;
  } catch {
    return null;
  }
  const raw = fm.intent as Record<string, unknown> | undefined;
  if (!raw) return null;
  if (typeof raw.goal !== "string" || raw.goal.length === 0) return null;
  if (!Array.isArray(raw.success_signals) || raw.success_signals.length === 0)
    return null;
  const out: SkillIntent = {
    goal: raw.goal,
    successSignals: raw.success_signals.filter(
      (s): s is string => typeof s === "string",
    ),
  };
  if (raw.inputs && typeof raw.inputs === "object")
    out.inputs = raw.inputs as Record<string, unknown>;
  if (Array.isArray(raw.subgoals))
    out.subgoals = raw.subgoals.filter(
      (s): s is string => typeof s === "string",
    );
  if (Array.isArray(raw.observed_input_modes))
    out.observedInputModes = raw.observed_input_modes.filter(
      (s): s is string => typeof s === "string",
    );
  return out;
}

/**
 * Render a {@link SkillIntent} as a plain-text block for the planner prompt.
 * Used by run.ts to thread structured intent into the planner without making
 * the planner parse YAML itself.
 */
export function renderIntentForPrompt(intent: SkillIntent): string {
  const lines: string[] = ["Intent:", `  Goal: ${intent.goal}`];
  if (intent.inputs && Object.keys(intent.inputs).length > 0) {
    lines.push("  Inputs:");
    for (const [k, v] of Object.entries(intent.inputs)) {
      lines.push(`    ${k}: ${JSON.stringify(v)}`);
    }
  }
  if (intent.subgoals && intent.subgoals.length > 0) {
    lines.push("  Subgoals:");
    for (const s of intent.subgoals) lines.push(`    - ${s}`);
  }
  lines.push("  Success signals:");
  for (const s of intent.successSignals) lines.push(`    - ${s}`);
  if (intent.observedInputModes && intent.observedInputModes.length > 0) {
    lines.push(
      `  Observed input modes: ${intent.observedInputModes.join(", ")}`,
    );
  }
  return lines.join("\n");
}
