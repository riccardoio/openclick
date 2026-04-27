import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AxNode, truncateAxTree } from "./axtree.ts";
import {
  AnthropicModelClient,
  type ModelClient,
  createModelClient,
} from "./models.ts";
import { resolveSkillRoot } from "./paths.ts";
import { buildCompilePrompt } from "./prompt.ts";
import { sampleScreenshots } from "./sampler.ts";
import { validateSkillMd } from "./schema.ts";
import { readTrajectory } from "./trajectory.ts";

export interface ClaudeClient {
  generate(args: { prompt: string; imagePaths: string[] }): Promise<string>;
}

export interface CompileOptions {
  trajectoryDir: string;
  skillName: string;
  claudeClient: ClaudeClient;
  /** Override the output directory. Defaults to ~/.cua/skills/<skillName>. */
  outputDir?: string;
}

export interface CompileResult {
  valid: boolean;
  skillMd: string;
  outputPath: string;
  errors: string[];
}

const SCREENSHOT_CAP = 6;
const AX_MAX_NODES = 200;
const AX_MAX_DEPTH = 6;

interface TargetMetadata {
  bundleId: string;
  appName: string;
}

export async function compileSkillMd(
  opts: CompileOptions,
): Promise<CompileResult> {
  const trajectory = await readTrajectory(opts.trajectoryDir);
  const targetMetadata = resolveTargetMetadata(trajectory.events);
  const sampled = sampleScreenshots(trajectory.events, SCREENSHOT_CAP).map(
    (name) => join(opts.trajectoryDir, name),
  );

  // Dedupe AX trees by (pid, role, title). Title-only collapses two distinct
  // apps that happen to share a window title (e.g. two "Untitled" docs).
  const uniqueAxTrees: AxNode[] = [];
  const seen = new Set<string>();
  for (const e of trajectory.events) {
    if (!e.ax_tree) continue;
    const ax = e.ax_tree as AxNode;
    const key = `${e.pid ?? "?"}|${ax.role}|${ax.title ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueAxTrees.push(
      truncateAxTree(ax, {
        maxNodes: AX_MAX_NODES,
        maxDepth: AX_MAX_DEPTH,
      }),
    );
  }

  const prompt = buildCompilePrompt({
    taskName: trajectory.session.task_name,
    taskDescription: trajectory.session.task_description,
    events: trajectory.events,
    sampledScreenshotPaths: sampled,
    truncatedAxTrees: uniqueAxTrees,
    targetMetadata,
  });

  let skillMd = await opts.claudeClient.generate({
    prompt: prompt.text,
    imagePaths: prompt.imageReferences,
  });
  let validation = validateSkillMd(skillMd);

  if (!validation.valid) {
    // Single retry with the error feedback.
    const fixPrompt = `${prompt.text}\n\nThe previous attempt failed validation:\n${validation.errors.join("\n")}\n\nFix it. Output ONLY the corrected SKILL.md.`;
    skillMd = await opts.claudeClient.generate({
      prompt: fixPrompt,
      imagePaths: prompt.imageReferences,
    });
    validation = validateSkillMd(skillMd);
  }

  // Don't write a known-invalid SKILL.md to the canonical path — `run` would
  // load it later and fail in confusing ways. Surface the bad output in the
  // error so the user can iterate, but keep the skill directory clean.
  if (!validation.valid) {
    throw new CompileValidationError(skillMd, validation.errors);
  }

  const root = opts.outputDir ?? resolveSkillRoot(opts.skillName);
  mkdirSync(root, { recursive: true });
  const outputPath = join(root, "SKILL.md");
  writeFileSync(outputPath, skillMd);

  return {
    valid: validation.valid,
    skillMd,
    outputPath,
    errors: validation.errors,
  };
}

function resolveTargetMetadata(
  events: Array<{ bundle_id?: string; app_name?: string }>,
): TargetMetadata | null {
  const counts = new Map<string, { value: TargetMetadata; count: number }>();
  for (const event of events) {
    const bundleId = event.bundle_id?.trim();
    const appName = event.app_name?.trim();
    if (!bundleId || !appName) continue;
    const key = `${bundleId}\u0000${appName}`;
    const existing = counts.get(key);
    counts.set(key, {
      value: { bundleId, appName },
      count: (existing?.count ?? 0) + 1,
    });
  }

  let best: { value: TargetMetadata; count: number } | null = null;
  for (const entry of counts.values()) {
    if (best === null || entry.count > best.count) best = entry;
  }
  return best?.value ?? null;
}

/** Thrown when both compile attempts produce a SKILL.md that fails validation. */
export class CompileValidationError extends Error {
  public readonly skillMd: string;
  public readonly validationErrors: string[];
  constructor(skillMd: string, validationErrors: string[]) {
    super(
      `compile produced an invalid SKILL.md after 1 retry: ${validationErrors.join("; ")}`,
    );
    this.name = "CompileValidationError";
    this.skillMd = skillMd;
    this.validationErrors = validationErrors;
  }
}

// Production Claude client wrapper.
export class AnthropicClaudeClient implements ClaudeClient {
  private client: ModelClient;

  constructor(apiKey?: string) {
    this.client = new AnthropicModelClient({
      apiKey,
      role: "compile",
    });
  }

  async generate(args: {
    prompt: string;
    imagePaths: string[];
  }): Promise<string> {
    return this.client.generate({
      prompt: args.prompt,
      imagePaths: args.imagePaths,
      role: "compile",
      maxTokens: 4096,
    });
  }
}

export class RoutedClaudeClient implements ClaudeClient {
  private readonly client = createModelClient("compile");

  async generate(args: {
    prompt: string;
    imagePaths: string[];
  }): Promise<string> {
    return this.client.generate({
      prompt: args.prompt,
      imagePaths: args.imagePaths,
      role: "compile",
      maxTokens: 4096,
    });
  }
}
