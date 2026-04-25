import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AxNode, truncateAxTree } from "./axtree.ts";
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

export async function compileSkillMd(
  opts: CompileOptions,
): Promise<CompileResult> {
  const trajectory = await readTrajectory(opts.trajectoryDir);
  const sampled = sampleScreenshots(trajectory.events, SCREENSHOT_CAP).map(
    (name) => join(opts.trajectoryDir, name),
  );

  const uniqueAxTrees: AxNode[] = [];
  const seen = new Set<string>();
  for (const e of trajectory.events) {
    if (!e.ax_tree) continue;
    const key = JSON.stringify((e.ax_tree as AxNode).title);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueAxTrees.push(
      truncateAxTree(e.ax_tree as AxNode, {
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

// Production Claude client wrapper.
export class AnthropicClaudeClient implements ClaudeClient {
  private apiKey: string;

  constructor(apiKey: string = Bun.env.ANTHROPIC_API_KEY ?? "") {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var required");
    this.apiKey = apiKey;
  }

  async generate(args: {
    prompt: string;
    imagePaths: string[];
  }): Promise<string> {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: this.apiKey });

    const content: Array<unknown> = [{ type: "text", text: args.prompt }];
    for (const path of args.imagePaths) {
      const data = readFileSync(path);
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: data.toString("base64"),
        },
      });
    }
    const msg = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 4096,
      // biome-ignore lint/suspicious/noExplicitAny: SDK content union not exported cleanly
      messages: [{ role: "user", content: content as any }],
    });
    // biome-ignore lint/suspicious/noExplicitAny: SDK content block union, narrowed by type tag
    const textBlock = msg.content.find((b: any) => b.type === "text") as any;
    return textBlock?.text ?? "";
  }
}
