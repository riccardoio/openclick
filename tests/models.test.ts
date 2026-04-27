import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIModelClient, createModelClient } from "../src/models.ts";

let home: string;
let originalHome: string | undefined;
let originalOpenAIKey: string | undefined;
let originalProvider: string | undefined;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalHome = Bun.env.OPEN42_HOME;
  originalOpenAIKey = Bun.env.OPENAI_API_KEY;
  originalProvider = Bun.env.OPEN42_MODEL_PROVIDER;
  originalFetch = globalThis.fetch;
  home = mkdtempSync(join(tmpdir(), "open42-models-"));
  Bun.env.OPEN42_HOME = home;
  Bun.env.OPENAI_API_KEY = "sk-test";
  Bun.env.OPEN42_MODEL_PROVIDER = undefined;
});

afterEach(() => {
  if (originalHome === undefined) Bun.env.OPEN42_HOME = undefined;
  else Bun.env.OPEN42_HOME = originalHome;
  if (originalOpenAIKey === undefined) Bun.env.OPENAI_API_KEY = undefined;
  else Bun.env.OPENAI_API_KEY = originalOpenAIKey;
  if (originalProvider === undefined) Bun.env.OPEN42_MODEL_PROVIDER = undefined;
  else Bun.env.OPEN42_MODEL_PROVIDER = originalProvider;
  globalThis.fetch = originalFetch;
  rmSync(home, { recursive: true, force: true });
});

describe("model providers", () => {
  test("OpenAIModelClient uses Responses API with text and image inputs", async () => {
    const imagePath = join(home, "screen.png");
    writeFileSync(
      imagePath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    );

    let capturedBody: unknown;
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
        }),
      );
    }) as typeof fetch;

    const client = new OpenAIModelClient({ model: "gpt-4.1", role: "planner" });
    const text = await client.generate({
      prompt: "plan",
      imagePaths: [imagePath],
    });

    expect(text).toBe("ok");
    const body = capturedBody as Record<string, unknown>;
    expect(body.model).toBe("gpt-4.1");
    const input = body.input as Array<Record<string, unknown>>;
    const content = input[0]?.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "input_text", text: "plan" });
    expect(String(content[1]?.image_url)).toMatch(/^data:image\/png;base64,/);
  });

  test("createModelClient routes to OpenAI when provider is configured", () => {
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({ provider: "openai" }),
    );

    const client = createModelClient("planner");

    expect(client.provider).toBe("openai");
  });
});
