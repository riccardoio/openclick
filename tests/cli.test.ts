import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";

describe("cli", () => {
  test("--help prints usage with all three subcommands", async () => {
    const log = captureLog();
    await main(["--help"]);
    const text = log.text();
    expect(text).toContain("record");
    expect(text).toContain("compile");
    expect(text).toContain("run");
  });

  test("--version prints version", async () => {
    const log = captureLog();
    await main(["--version"]);
    expect(log.text()).toMatch(/^showme \d+\.\d+\.\d+/);
  });

  test("unknown subcommand throws", async () => {
    await expect(main(["bogus"])).rejects.toThrow(/unknown subcommand/i);
  });

  test("no args prints help", async () => {
    const log = captureLog();
    await main([]);
    expect(log.text()).toContain("Usage:");
  });

  test("known subcommands report 'not implemented yet' before wiring", async () => {
    for (const cmd of ["record", "compile", "run"]) {
      const log = captureLog();
      await main([cmd]);
      expect(log.text()).toContain(cmd);
    }
  });
});

function captureLog() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return {
    text: () => {
      console.log = original;
      return lines.join("\n");
    },
  };
}
