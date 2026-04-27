import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCuaDriverBinary,
  resolveSkillTrajectoryPath,
} from "../src/paths.ts";
import { waitForRecorderExit } from "../src/record.ts";

describe("paths", () => {
  test("resolveSkillTrajectoryPath returns ~/.cua/skills/<name>/trajectory", () => {
    const result = resolveSkillTrajectoryPath("triage-issues");
    expect(result).toMatch(/\.cua\/skills\/triage-issues\/trajectory$/);
  });

  test("resolveCuaDriverBinary honors the CUA_DRIVER override", () => {
    const dir = mkdtempSync(join(tmpdir(), "open42-cua-driver-"));
    const fakeBinary = join(dir, "cua-driver");
    writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBinary, 0o755);

    const original = Bun.env.CUA_DRIVER;
    Bun.env.CUA_DRIVER = fakeBinary;
    try {
      expect(resolveCuaDriverBinary()).toBe(fakeBinary);
    } finally {
      if (original === undefined) Bun.env.CUA_DRIVER = undefined;
      else Bun.env.CUA_DRIVER = original;
    }
  });
});

describe("waitForRecorderExit", () => {
  test("rejects with the terminating signal when the recorder is interrupted", async () => {
    const proc = new EventEmitter();
    const pending = waitForRecorderExit(proc);
    proc.emit("exit", null, "SIGTERM");
    await expect(pending).rejects.toThrow(/signal SIGTERM/);
  });

  test("rejects spawn errors instead of hanging forever", async () => {
    const proc = new EventEmitter();
    const pending = waitForRecorderExit(proc);
    proc.emit("error", new Error("spawn EACCES"));
    await expect(pending).rejects.toThrow(/EACCES/);
  });
});
