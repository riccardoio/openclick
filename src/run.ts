import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RunOptions {
  skillRoot: string;
  userPrompt: string;
  live: boolean;
  maxSteps: number;
  confirm?: boolean;
  /** Injectable for tests. In production, leave unset to load the real SDK. */
  queryFn?: QueryFn;
}

export type QueryFn = (input: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export async function runSkill(opts: RunOptions): Promise<void> {
  const skillMd = readFileSync(join(opts.skillRoot, "SKILL.md"), "utf-8");
  const systemPrompt = buildSystemPrompt(skillMd);

  if (!opts.live) {
    console.log(
      "[showme] DRY RUN — no cua-driver tools will execute. Pass --live to actually run.",
    );
  }
  console.log("[showme] press Ctrl-C to abort.");

  let aborted = false;
  const onSigint = (): void => {
    aborted = true;
    console.log("\n[showme] aborted by user.");
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  // biome-ignore lint/suspicious/noExplicitAny: SDK hook input is an opaque object.
  const previewHook = async (input: any): Promise<Record<string, unknown>> => {
    const tool = input.tool_name ?? "<unknown>";
    const args = input.tool_input ?? {};
    const summary = summarizeToolCall(tool, args);
    console.log(`[showme] about to: ${summary}`);
    if (!opts.live) {
      // Block execution by returning a "denied" decision.
      return { decision: "block", reason: "dry-run mode" };
    }
    if (opts.confirm) {
      const ok = await promptYesNo("execute? [y/N]: ");
      if (!ok) return { decision: "block", reason: "user declined" };
    }
    return {};
  };

  const queryFn = opts.queryFn ?? (await loadRealQuery());

  let stepCount = 0;
  try {
    for await (const message of queryFn({
      prompt: opts.userPrompt,
      options: {
        systemPrompt,
        mcpServers: { "cua-driver": { command: "cua-driver", args: ["mcp"] } },
        allowedTools: [
          "mcp__cua-driver__click",
          "mcp__cua-driver__type_text",
          "mcp__cua-driver__get_window_state",
          "mcp__cua-driver__screenshot",
          "mcp__cua-driver__press_key",
          "mcp__cua-driver__hotkey",
          "mcp__cua-driver__list_apps",
          "mcp__cua-driver__list_windows",
          "mcp__cua-driver__launch_app",
          "mcp__cua-driver__scroll",
        ],
        hooks: { PreToolUse: [{ matcher: ".*", hooks: [previewHook] }] },
        maxTurns: opts.maxSteps,
      },
    })) {
      if (aborted) break;
      // biome-ignore lint/suspicious/noExplicitAny: SDK message union not exported.
      const msg = message as any;
      if (msg.type === "tool_use") stepCount++;
      if (msg.type === "result" && "result" in msg) {
        console.log(`[showme] ${msg.result}`);
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  console.log(`[showme] done. ${stepCount} tool calls.`);
}

function buildSystemPrompt(skillMd: string): string {
  return `You are an agent executing a recorded skill on the user's macOS via cua-driver.

You have access to cua-driver MCP tools: click, type_text, get_window_state, screenshot, press_key, hotkey, list_apps, list_windows, launch_app, scroll.

Before each tool call, the system will preview your intended action to the user. Be concise and intentional.

Stop when the skill's stop conditions are met OR you cannot proceed (e.g., unrecognized modal, stuck state).

SKILL:
${skillMd}`;
}

function summarizeToolCall(
  tool: string,
  args: Record<string, unknown>,
): string {
  if (tool.endsWith("click"))
    return `click element ${(args.element_index as number) ?? `${args.x},${args.y}`}`;
  if (tool.endsWith("type_text")) return `type ${JSON.stringify(args.text)}`;
  if (tool.endsWith("press_key")) return `press ${args.key}`;
  if (tool.endsWith("hotkey"))
    return `hotkey ${(args.modifiers as string[])?.join("+")}`;
  if (tool.endsWith("launch_app")) return `launch ${args.bundle_id}`;
  if (tool.endsWith("get_window_state"))
    return `snapshot window ${args.window_id}`;
  return `${tool}(${JSON.stringify(args)})`;
}

async function promptYesNo(prompt: string): Promise<boolean> {
  process.stdout.write(prompt);
  const buf = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(d.toString().trim()));
  });
  return buf.toLowerCase() === "y" || buf.toLowerCase() === "yes";
}

async function loadRealQuery(): Promise<QueryFn> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  // biome-ignore lint/suspicious/noExplicitAny: SDK input type isn't exported.
  return (input) => sdk.query(input as any) as AsyncIterable<unknown>;
}
