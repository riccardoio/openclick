import { readFileSync } from "node:fs";
import { detectImageMimeType } from "./imagemime.ts";
import {
  type ModelProvider,
  type ModelRole,
  resolveModelName,
  resolveModelProvider,
  resolveProviderApiKey,
} from "./settings.ts";

export interface ModelCapabilities {
  vision: boolean;
  jsonMode: boolean;
  local: boolean;
}

export interface ModelGenerateArgs {
  prompt: string;
  imagePaths?: string[];
  role?: ModelRole;
  maxTokens?: number;
  jsonMode?: boolean;
}

export interface ModelClient {
  provider: ModelProvider;
  model: string;
  capabilities: ModelCapabilities;
  generate(args: ModelGenerateArgs): Promise<string>;
}

export function createModelClient(
  role: ModelRole,
  provider: ModelProvider = resolveModelProvider(),
): ModelClient {
  const model = resolveModelName(role, provider);
  if (provider === "openai") {
    return new OpenAIModelClient({ model, role });
  }
  return new AnthropicModelClient({ model, role });
}

export class AnthropicModelClient implements ModelClient {
  readonly provider = "anthropic" as const;
  readonly model: string;
  readonly capabilities = { vision: true, jsonMode: false, local: false };
  private readonly role: ModelRole;
  private readonly apiKey: string;

  constructor(
    opts: { model?: string; role?: ModelRole; apiKey?: string } = {},
  ) {
    this.role = opts.role ?? "planner";
    this.model = opts.model ?? resolveModelName(this.role, "anthropic");
    this.apiKey = opts.apiKey ?? resolveProviderApiKey("anthropic");
    if (!this.apiKey) {
      throw new Error("ANTHROPIC_API_KEY or saved Anthropic API key required");
    }
  }

  async generate(args: ModelGenerateArgs): Promise<string> {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: this.apiKey });
    const content = await anthropicContent(args.prompt, args.imagePaths ?? []);
    const maxTokens = args.maxTokens ?? configuredMaxTokens(this.role);
    const msg = await client.messages.create({
      model: this.model,
      max_tokens:
        Number.isFinite(maxTokens) && maxTokens > 0
          ? maxTokens
          : defaultMaxTokens(this.role),
      // biome-ignore lint/suspicious/noExplicitAny: SDK content union is verbose and not exported cleanly
      messages: [{ role: "user", content: content as any }],
    });
    // biome-ignore lint/suspicious/noExplicitAny: SDK content block union, narrowed by type tag
    const textBlock = msg.content.find((b: any) => b.type === "text") as any;
    return textBlock?.text ?? "";
  }
}

export class OpenAIModelClient implements ModelClient {
  readonly provider = "openai" as const;
  readonly model: string;
  readonly capabilities = { vision: true, jsonMode: false, local: false };
  private readonly role: ModelRole;
  private readonly apiKey: string;

  constructor(
    opts: { model?: string; role?: ModelRole; apiKey?: string } = {},
  ) {
    this.role = opts.role ?? "planner";
    this.model = opts.model ?? resolveModelName(this.role, "openai");
    this.apiKey = opts.apiKey ?? resolveProviderApiKey("openai");
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY or saved OpenAI API key required");
    }
  }

  async generate(args: ModelGenerateArgs): Promise<string> {
    const body = {
      model: this.model,
      input: [
        {
          role: "user",
          content: await openAIContent(args.prompt, args.imagePaths ?? []),
        },
      ],
      max_output_tokens: args.maxTokens ?? defaultMaxTokens(this.role),
    };
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI request failed (${response.status}): ${text}`);
    }
    return extractOpenAIText(JSON.parse(text));
  }
}

async function anthropicContent(
  prompt: string,
  imagePaths: string[],
): Promise<string | Array<unknown>> {
  if (imagePaths.length === 0) return prompt;
  const blocks: Array<unknown> = [{ type: "text", text: prompt }];
  for (const path of imagePaths) {
    const image = tryReadImageAsData(path);
    if (!image) continue;
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mediaType,
        data: image.base64,
      },
    });
  }
  return blocks;
}

async function openAIContent(
  prompt: string,
  imagePaths: string[],
): Promise<Array<Record<string, unknown>>> {
  const blocks: Array<Record<string, unknown>> = [
    { type: "input_text", text: prompt },
  ];
  for (const path of imagePaths) {
    const image = tryReadImageAsData(path);
    if (!image) continue;
    blocks.push({
      type: "input_image",
      image_url: `data:${image.mediaType};base64,${image.base64}`,
      detail: "high",
    });
  }
  return blocks;
}

function readImageAsData(path: string): { mediaType: string; base64: string } {
  const data = readFileSync(path);
  return {
    mediaType: detectImageMimeType(data),
    base64: data.toString("base64"),
  };
}

function tryReadImageAsData(
  path: string,
): { mediaType: string; base64: string } | null {
  try {
    return readImageAsData(path);
  } catch (e) {
    console.warn(
      `[model] couldn't attach image ${path}: ${(e as Error).message}`,
    );
    return null;
  }
}

function extractOpenAIText(value: unknown): string {
  const obj = value as Record<string, unknown>;
  if (typeof obj.output_text === "string") return obj.output_text;
  const output = Array.isArray(obj.output) ? obj.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

function defaultMaxTokens(role: ModelRole): number {
  if (role === "compile") return 4096;
  return 2048;
}

function configuredMaxTokens(role: ModelRole): number {
  const env =
    role === "compile"
      ? Bun.env.OPENCLICK_COMPILE_MAX_TOKENS
      : Bun.env.OPENCLICK_PLANNER_MAX_TOKENS;
  const parsed = Number(env ?? defaultMaxTokens(role));
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : defaultMaxTokens(role);
}
