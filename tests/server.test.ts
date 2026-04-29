import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetApiRunForTests } from "../src/api-runs.ts";
import { handleApiRequest } from "../src/server.ts";

let home: string;
let originalHome: string | undefined;
let originalDisableKeychain: string | undefined;
let originalAnthropicApiKey: string | undefined;
let originalOpenClickApiKey: string | undefined;
let originalOpenClickBin: string | undefined;

beforeEach(() => {
  originalHome = Bun.env.OPENCLICK_HOME;
  originalDisableKeychain = Bun.env.OPENCLICK_DISABLE_KEYCHAIN;
  originalAnthropicApiKey = Bun.env.ANTHROPIC_API_KEY;
  originalOpenClickApiKey = Bun.env.OPENCLICK_API_KEY;
  originalOpenClickBin = Bun.env.OPENCLICK_BIN;
  home = mkdtempSync(join(tmpdir(), "openclick-server-"));
  Bun.env.OPENCLICK_HOME = home;
  Bun.env.OPENCLICK_DISABLE_KEYCHAIN = "1";
  Bun.env.ANTHROPIC_API_KEY = undefined;
  Bun.env.OPENCLICK_API_KEY = undefined;
});

afterEach(() => {
  if (originalHome === undefined) Bun.env.OPENCLICK_HOME = undefined;
  else Bun.env.OPENCLICK_HOME = originalHome;
  if (originalDisableKeychain === undefined)
    Bun.env.OPENCLICK_DISABLE_KEYCHAIN = undefined;
  else Bun.env.OPENCLICK_DISABLE_KEYCHAIN = originalDisableKeychain;
  if (originalAnthropicApiKey === undefined)
    Bun.env.ANTHROPIC_API_KEY = undefined;
  else Bun.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
  if (originalOpenClickApiKey === undefined)
    Bun.env.OPENCLICK_API_KEY = undefined;
  else Bun.env.OPENCLICK_API_KEY = originalOpenClickApiKey;
  if (originalOpenClickBin === undefined) Bun.env.OPENCLICK_BIN = undefined;
  else Bun.env.OPENCLICK_BIN = originalOpenClickBin;
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
    expect(body.name).toBe("openclick");
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

  test("capabilities endpoint describes OpenClaw-friendly desktop commands", async () => {
    const response = await handleApiRequest(
      new Request("http://127.0.0.1:4242/v1/capabilities"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.name).toBe("openclick");
    expect(body.capabilities).toContain("desktop.run");
    expect(body.endpoints.start_run).toBe("POST /v1/runs");
  });

  test("blocking run response includes standardized output envelope", async () => {
    Bun.env.OPENCLICK_BIN = writeFakeOpenClickBin();
    const response = await handleApiRequest(
      new Request("http://127.0.0.1:4242/v1/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "read the current email" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.output.status).toBe("completed");
    expect(body.output.result.kind).toBe("answer");
    expect(body.output.result.body).toBe("Hello from the fake desktop.");
  });

  test("async run lifecycle exposes status and events", async () => {
    Bun.env.OPENCLICK_BIN = writeFakeOpenClickBin();
    const start = await handleApiRequest(
      new Request("http://127.0.0.1:4242/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "read the current email" }),
      }),
    );
    expect(start.status).toBe(202);
    const started = await start.json();
    const runId = started.run.run_id;
    expect(started.run.status).toBe("running");

    await waitForRunCompletion(runId);

    const status = await handleApiRequest(
      new Request(`http://127.0.0.1:4242/v1/runs/${runId}`),
    );
    const body = await status.json();
    expect(body.run.status).toBe("completed");
    expect(body.run.result.body).toBe("Hello from the fake desktop.");

    const events = await handleApiRequest(
      new Request(`http://127.0.0.1:4242/v1/runs/${runId}/events`),
    );
    const eventText = await events.text();
    expect(eventText).toContain("event: result");
    expect(eventText).toContain("Hello from the fake desktop.");
  });

  test("async run status and events survive in-memory registry loss", async () => {
    Bun.env.OPENCLICK_BIN = writeFakeOpenClickBin();
    const start = await handleApiRequest(
      new Request("http://127.0.0.1:4242/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "read the current email" }),
      }),
    );
    const started = await start.json();
    const runId = started.run.run_id;
    await waitForRunCompletion(runId);

    forgetApiRunForTests(runId);

    const status = await handleApiRequest(
      new Request(`http://127.0.0.1:4242/v1/runs/${runId}`),
    );
    const body = await status.json();
    expect(body.run.status).toBe("completed");
    expect(body.run.result.body).toBe("Hello from the fake desktop.");

    const events = await handleApiRequest(
      new Request(`http://127.0.0.1:4242/v1/runs/${runId}/events?after=0`),
    );
    const eventText = await events.text();
    expect(eventText).toContain("event: finished");
    expect(eventText).toContain("event: result");
  });
});

function writeFakeOpenClickBin(): string {
  const path = join(home, "fake-openclick");
  writeFileSync(
    path,
    `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args[0] === "run") {
  console.log("[openclick] run id: child-test-run");
  console.log('[openclick] task_result {"kind":"answer","title":"Result","body":"Hello from the fake desktop.","created_at":"2026-04-29T00:00:00.000Z"}');
  console.log("[openclick] done. 1 tool calls.");
  process.exit(0);
}
if (args[0] === "cancel") {
  console.log("[openclick] cancellation requested for " + args[1]);
  process.exit(0);
}
console.error("unexpected args: " + args.join(" "));
process.exit(2);
`,
  );
  chmodSync(path, 0o755);
  return path;
}

async function waitForRunCompletion(runId: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await handleApiRequest(
      new Request(`http://127.0.0.1:4242/v1/runs/${runId}`),
    );
    const body = await response.json();
    if (["completed", "failed", "cancelled"].includes(body.run.status)) return;
    await Bun.sleep(25);
  }
  throw new Error(`run ${runId} did not complete`);
}
