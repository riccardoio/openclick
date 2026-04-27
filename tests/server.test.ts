import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApiRequest } from "../src/server.ts";

let home: string;
let originalHome: string | undefined;
let originalDisableKeychain: string | undefined;
let originalAnthropicApiKey: string | undefined;
let originalOpen42ApiKey: string | undefined;

beforeEach(() => {
  originalHome = Bun.env.OPEN42_HOME;
  originalDisableKeychain = Bun.env.OPEN42_DISABLE_KEYCHAIN;
  originalAnthropicApiKey = Bun.env.ANTHROPIC_API_KEY;
  originalOpen42ApiKey = Bun.env.OPEN42_API_KEY;
  home = mkdtempSync(join(tmpdir(), "open42-server-"));
  Bun.env.OPEN42_HOME = home;
  Bun.env.OPEN42_DISABLE_KEYCHAIN = "1";
  Bun.env.ANTHROPIC_API_KEY = undefined;
  Bun.env.OPEN42_API_KEY = undefined;
});

afterEach(() => {
  if (originalHome === undefined) Bun.env.OPEN42_HOME = undefined;
  else Bun.env.OPEN42_HOME = originalHome;
  if (originalDisableKeychain === undefined)
    Bun.env.OPEN42_DISABLE_KEYCHAIN = undefined;
  else Bun.env.OPEN42_DISABLE_KEYCHAIN = originalDisableKeychain;
  if (originalAnthropicApiKey === undefined)
    Bun.env.ANTHROPIC_API_KEY = undefined;
  else Bun.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
  if (originalOpen42ApiKey === undefined) Bun.env.OPEN42_API_KEY = undefined;
  else Bun.env.OPEN42_API_KEY = originalOpen42ApiKey;
  rmSync(home, { recursive: true, force: true });
});

describe("api server", () => {
  test("health endpoint returns versioned status", async () => {
    const response = await handleApiRequest(
      new Request("http://127.0.0.1:4242/health"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.name).toBe("open42");
  });

  test("token-protected requests reject missing credentials", async () => {
    const response = await handleApiRequest(
      new Request("http://127.0.0.1:4242/health"),
      { token: "secret" },
    );
    expect(response.status).toBe(401);
  });

  test("API key endpoint never returns the raw key", async () => {
    const save = await handleApiRequest(
      new Request("http://127.0.0.1:4242/v1/settings/api-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-ant-server-secret" }),
      }),
    );
    expect(save.status).toBe(200);

    const response = await handleApiRequest(
      new Request("http://127.0.0.1:4242/v1/settings/api-key"),
    );
    const body = await response.json();
    expect(body.available).toBe(true);
    expect(body.masked).toContain("*");
    expect(JSON.stringify(body)).not.toContain("sk-ant-server-secret");
  });
});
