import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { addAppMemoryFact } from "../src/memory.ts";
import { readRunTakeoverResume } from "../src/trace.ts";

let originalLog: typeof console.log;
let captured: string[];
let home: string;
let originalHome: string | undefined;
let originalDisableKeychain: string | undefined;
let originalLaunchAgentsDir: string | undefined;
let originalSkipLaunchctl: string | undefined;
let originalAnthropicApiKey: string | undefined;
let originalOpenClickApiKey: string | undefined;

beforeEach(() => {
  originalLog = console.log;
  originalHome = Bun.env.OPENCLICK_HOME;
  originalDisableKeychain = Bun.env.OPENCLICK_DISABLE_KEYCHAIN;
  originalLaunchAgentsDir = Bun.env.OPENCLICK_LAUNCH_AGENTS_DIR;
  originalSkipLaunchctl = Bun.env.OPENCLICK_SKIP_LAUNCHCTL;
  originalAnthropicApiKey = Bun.env.ANTHROPIC_API_KEY;
  originalOpenClickApiKey = Bun.env.OPENCLICK_API_KEY;
  home = mkdtempSync(join(tmpdir(), "openclick-cli-"));
  Bun.env.OPENCLICK_HOME = home;
  Bun.env.OPENCLICK_DISABLE_KEYCHAIN = "1";
  Bun.env.OPENCLICK_LAUNCH_AGENTS_DIR = join(home, "LaunchAgents");
  Bun.env.OPENCLICK_SKIP_LAUNCHCTL = "1";
  Bun.env.ANTHROPIC_API_KEY = undefined;
  Bun.env.OPENCLICK_API_KEY = undefined;
  captured = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
  if (originalHome === undefined) Bun.env.OPENCLICK_HOME = undefined;
  else Bun.env.OPENCLICK_HOME = originalHome;
  if (originalDisableKeychain === undefined)
    Bun.env.OPENCLICK_DISABLE_KEYCHAIN = undefined;
  else Bun.env.OPENCLICK_DISABLE_KEYCHAIN = originalDisableKeychain;
  if (originalLaunchAgentsDir === undefined)
    Bun.env.OPENCLICK_LAUNCH_AGENTS_DIR = undefined;
  else Bun.env.OPENCLICK_LAUNCH_AGENTS_DIR = originalLaunchAgentsDir;
  if (originalSkipLaunchctl === undefined)
    Bun.env.OPENCLICK_SKIP_LAUNCHCTL = undefined;
  else Bun.env.OPENCLICK_SKIP_LAUNCHCTL = originalSkipLaunchctl;
  if (originalAnthropicApiKey === undefined)
    Bun.env.ANTHROPIC_API_KEY = undefined;
  else Bun.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
  if (originalOpenClickApiKey === undefined)
    Bun.env.OPENCLICK_API_KEY = undefined;
  else Bun.env.OPENCLICK_API_KEY = originalOpenClickApiKey;
  rmSync(home, { recursive: true, force: true });
});

const text = () => captured.join("\n");

describe("cli", () => {
  test("--help prints usage with all four subcommands", async () => {
    await main(["--help"]);
    const t = text();
    expect(t).toContain("doctor");
    expect(t).toContain("record");
    expect(t).toContain("compile");
    expect(t).toContain("run");
  });

  test("--version prints version", async () => {
    await main(["--version"]);
    expect(text()).toMatch(/^openclick \d+\.\d+\.\d+/);
  });

  test("unknown subcommand throws", async () => {
    await expect(main(["bogus"])).rejects.toThrow(/unknown subcommand/i);
  });

  test("no args prints help", async () => {
    await main([]);
    expect(text()).toContain("Usage:");
  });

  test("record without skill-name throws", async () => {
    await expect(main(["record"])).rejects.toThrow(
      /record requires <skill-name>/,
    );
  });

  test("compile without skill-name throws", async () => {
    await expect(main(["compile"])).rejects.toThrow(
      /compile requires <skill-name>/,
    );
  });

  test("run without task throws", async () => {
    await expect(main(["run"])).rejects.toThrow(/run requires <task>/);
  });

  test("--help describes prompt-first planning", async () => {
    await main(["--help"]);
    expect(text()).toContain("Complete a macOS task from your prompt");
    expect(text()).toContain("screenshots/replans");
  });

  test("--help advertises doctor --json for the menu-bar onboarding", async () => {
    await main(["--help"]);
    expect(text()).toContain("--json");
  });

  test("invalid --max-steps throws", async () => {
    await expect(main(["run", "skill", "--max-steps", "0"])).rejects.toThrow(
      /positive integer/i,
    );
  });

  test("invalid budget flags throw", async () => {
    await expect(
      main(["run", "do thing", "--max-batches", "0"]),
    ).rejects.toThrow(/--max-batches requires a positive integer/i);
    await expect(
      main(["run", "do thing", "--max-model-calls", "0"]),
    ).rejects.toThrow(/--max-model-calls requires a positive integer/i);
    await expect(
      main(["run", "do thing", "--max-screenshots", "0"]),
    ).rejects.toThrow(/--max-screenshots requires a positive integer/i);
  });

  test("--criteria requires a value", async () => {
    await expect(main(["run", "do thing", "--criteria"])).rejects.toThrow(
      /--criteria requires a value/i,
    );
  });

  test("run accepts memory escape hatches in the task parser", async () => {
    await expect(main(["run", "--no-memory", "--no-learn"])).rejects.toThrow(
      /run requires <task>/i,
    );
  });

  test("run accepts foreground opt-in in the task parser", async () => {
    await expect(main(["run", "--allow-foreground"])).rejects.toThrow(
      /run requires <task>/i,
    );
  });

  test("memory list/export/import commands work", async () => {
    addAppMemoryFact({
      bundleId: "com.example.App",
      appName: "Example",
      kind: "affordance",
      description: "Press n to create a new document.",
    });

    await main(["memory", "list"]);
    expect(text()).toContain("Example");

    const exportPath = join(home, "bundle.json");
    await main(["memory", "export", exportPath]);
    expect(text()).toContain("exported 1 app memory");

    await main(["memory", "import", exportPath]);
    expect(text()).toContain("imported 1 app memory");
  });

  test("cancel writes a run cancellation marker", async () => {
    await main(["cancel", "run-123"]);

    expect(text()).toContain("cancellation requested for run-123");
    expect(existsSync(join(home, "runs", "run-123", "cancel"))).toBe(true);
  });

  test("takeover finish writes a resume marker for the paused runner", async () => {
    await main([
      "takeover",
      "finish",
      "--run-id",
      "run-123",
      "--outcome",
      "success",
      "--bundle-id",
      "com.example.App",
      "--app-name",
      "Example",
      "--task",
      "Download invoice",
      "--issue",
      "Confirmation click required",
      "--summary",
      "Clicked the confirm button after checking the dialog.",
      "--reason-type",
      "confirmation_dialog",
      "--feedback",
      "completed",
      "--trajectory-path",
      "/tmp/openclick-takeover",
    ]);

    const marker = readRunTakeoverResume("run-123");
    expect(marker?.outcome).toBe("success");
    expect(marker?.reason_type).toBe("confirmation_dialog");
    expect(marker?.summary).toContain("confirm button");
    expect(marker?.trajectory_path).toBe("/tmp/openclick-takeover");
  });

  test("settings api-key stores and masks the saved key", async () => {
    await main(["settings", "api-key", "status"]);
    expect(text()).toContain("not configured");

    await main(["settings", "api-key", "set", "sk-ant-test-secret"]);
    expect(text()).toContain("API key saved");

    await main(["settings", "api-key", "status"]);
    expect(text()).toContain("settings");
    expect(text()).toContain("******************");
    expect(text()).not.toContain("sk-ant-test-secret");

    await main(["settings", "api-key", "clear"]);
    await main(["settings", "api-key", "status"]);
    expect(text()).toContain("saved anthropic API key cleared");
    expect(text()).toContain("not configured");
  });

  test("settings provider and model commands persist provider choices", async () => {
    await main(["settings", "provider", "status"]);
    expect(text()).toContain("model provider: anthropic");

    await main(["settings", "provider", "set", "openai"]);
    await main(["settings", "provider", "status"]);
    expect(text()).toContain("model provider set to openai");
    expect(text()).toContain("model provider: openai");

    await main(["settings", "model", "set", "planner", "gpt-4.1"]);
    await main(["settings", "model", "status"]);
    expect(text()).toContain("planner=gpt-4.1");
  });

  test("daemon install writes a launch agent plist for the API server", async () => {
    await main(["daemon", "install", "--port", "4343", "--token", "secret"]);

    const plistPath = join(home, "LaunchAgents", "dev.openclick.server.plist");
    expect(existsSync(plistPath)).toBe(true);
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("<string>server</string>");
    expect(plist).toContain("<string>4343</string>");
    expect(plist).toContain("OPENCLICK_SERVER_TOKEN");

    await main(["daemon", "status"]);
    expect(text()).toContain("daemon installed");

    await main(["daemon", "uninstall"]);
    expect(existsSync(plistPath)).toBe(false);
  });
});
