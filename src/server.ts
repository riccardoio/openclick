import { currentOpenClickBin } from "./daemon.ts";
import { VERSION } from "./version.ts";

export interface ApiServerOptions {
  host?: string;
  port?: number;
  token?: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function startApiServer(
  options: ApiServerOptions = {},
): Promise<void> {
  const host = options.host ?? Bun.env.OPENCLICK_SERVER_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(Bun.env.OPENCLICK_SERVER_PORT ?? 4242);
  const token = options.token ?? Bun.env.OPENCLICK_SERVER_TOKEN;

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(request) {
      return handleApiRequest(request, { host, port, token });
    },
  });

  console.log(
    `[openclick] API server listening on http://${server.hostname}:${server.port}`,
  );
  await new Promise<never>(() => {});
}

export async function handleApiRequest(
  request: Request,
  options: ApiServerOptions = {},
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return jsonResponse({}, 204);
  }

  const url = new URL(request.url);
  const token = options.token ?? Bun.env.OPENCLICK_SERVER_TOKEN;
  if (token && !isAuthorized(request, token)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, name: "openclick", version: VERSION });
    }

    if (request.method === "GET" && url.pathname === "/v1/status") {
      const { runDoctor, RealSystemProbe } = await import("./doctor.ts");
      const report = await runDoctor(new RealSystemProbe());
      return jsonResponse({ ok: report.allOk, report });
    }

    if (url.pathname === "/v1/settings/api-key") {
      return handleApiKeyRequest(request);
    }

    if (request.method === "POST" && url.pathname === "/v1/run") {
      const body = await parseJsonObject(request);
      const task = stringField(body, "task");
      if (!task) return jsonResponse({ error: "task is required" }, 400);
      const live = body.live !== false;
      const args = ["run", task];
      if (live) args.push("--live");
      if (body.allowForeground === true) args.push("--allow-foreground");
      if (typeof body.criteria === "string" && body.criteria.trim()) {
        args.push("--criteria", body.criteria.trim());
      }
      const result = await runOpenClickCommand(args);
      return jsonResponse({ ok: result.exitCode === 0, ...result });
    }

    if (request.method === "POST" && url.pathname === "/v1/cancel") {
      const body = await parseJsonObject(request);
      const runId = stringField(body, "runId") ?? stringField(body, "run_id");
      if (!runId) return jsonResponse({ error: "runId is required" }, 400);
      const result = await runOpenClickCommand(["cancel", runId]);
      return jsonResponse({ ok: result.exitCode === 0, ...result });
    }

    if (request.method === "GET" && url.pathname === "/v1/memory") {
      const result = await runOpenClickCommand(["memory", "list"]);
      return jsonResponse({ ok: result.exitCode === 0, ...result });
    }

    return jsonResponse({ error: "not found" }, 404);
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
}

export async function startMcpServer(): Promise<void> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { z } = await import("zod");

  const server = new McpServer({ name: "openclick", version: VERSION });

  server.registerTool(
    "run_task",
    {
      title: "Run openclick task",
      description:
        "Run a natural-language macOS desktop task through openclick and return the CLI output.",
      inputSchema: {
        task: z.string(),
        live: z.boolean().optional(),
        allowForeground: z.boolean().optional(),
        criteria: z.string().optional(),
      },
    },
    async (args) => {
      const runArgs = ["run", args.task];
      if (args.live !== false) runArgs.push("--live");
      if (args.allowForeground === true) runArgs.push("--allow-foreground");
      if (args.criteria?.trim()) runArgs.push("--criteria", args.criteria);
      const result = await runOpenClickCommand(runArgs);
      return {
        content: [
          {
            type: "text",
            text:
              result.stdout.trim() ||
              result.stderr.trim() ||
              `openclick exited with status ${result.exitCode}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "status",
    {
      title: "Check openclick status",
      description: "Run openclick doctor and return the current setup status.",
    },
    async () => {
      const result = await runOpenClickCommand(["doctor", "--json"]);
      return {
        content: [{ type: "text", text: result.stdout || result.stderr }],
      };
    },
  );

  await server.connect(new StdioServerTransport());
}

async function handleApiKeyRequest(request: Request): Promise<Response> {
  const {
    apiKeyStatus,
    clearProviderApiKey,
    resolveModelProvider,
    saveProviderApiKey,
  } = await import("./settings.ts");
  if (request.method === "GET") {
    const provider = resolveModelProvider();
    return jsonResponse({ provider, ...apiKeyStatus(provider) });
  }
  if (request.method === "POST") {
    const body = await parseJsonObject(request);
    const apiKey = stringField(body, "apiKey") ?? stringField(body, "api_key");
    if (!apiKey) return jsonResponse({ error: "apiKey is required" }, 400);
    const provider =
      parseProviderField(body.provider) ?? resolveModelProvider();
    const saved = saveProviderApiKey(provider, apiKey);
    return jsonResponse({
      ok: true,
      provider,
      storage: saved.storage,
      ...apiKeyStatus(provider),
    });
  }
  if (request.method === "DELETE") {
    const provider = resolveModelProvider();
    clearProviderApiKey(provider);
    return jsonResponse({ ok: true, provider, ...apiKeyStatus(provider) });
  }
  return jsonResponse({ error: "method not allowed" }, 405);
}

function parseProviderField(
  value: unknown,
): "anthropic" | "openai" | undefined {
  if (value === "anthropic" || value === "openai") return value;
  return undefined;
}

async function runOpenClickCommand(args: string[]): Promise<CommandResult> {
  const proc = Bun.spawn([currentOpenClickBin(), ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, OPENCLICK_APP_USE_ENV: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function parseJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

function stringField(
  object: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = object[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isAuthorized(request: Request, token: string): boolean {
  const auth = request.headers.get("authorization");
  if (auth === `Bearer ${token}`) return true;
  return request.headers.get("x-openclick-token") === token;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "http://localhost",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers":
        "authorization,content-type,x-openclick-token",
    },
  });
}
