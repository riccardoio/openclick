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
