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
