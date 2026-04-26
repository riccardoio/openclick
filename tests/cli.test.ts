import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { addAppMemoryFact } from "../src/memory.ts";

let originalLog: typeof console.log;
let captured: string[];
let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalLog = console.log;
  originalHome = Bun.env.SHOWME_HOME;
  home = mkdtempSync(join(tmpdir(), "showme-cli-"));
  Bun.env.SHOWME_HOME = home;
  captured = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
  if (originalHome === undefined) Bun.env.SHOWME_HOME = undefined;
  else Bun.env.SHOWME_HOME = originalHome;
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
    expect(text()).toMatch(/^showme \d+\.\d+\.\d+/);
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
});
