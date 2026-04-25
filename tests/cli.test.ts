import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";

let originalLog: typeof console.log;
let captured: string[];

beforeEach(() => {
  originalLog = console.log;
  captured = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
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

  test("run without skill-name throws", async () => {
    await expect(main(["run"])).rejects.toThrow(/run requires <skill-name>/);
  });

  test("--help mentions --fast", async () => {
    await main(["--help"]);
    expect(text()).toContain("--fast");
  });
});
