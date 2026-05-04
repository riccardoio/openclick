import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveOpenclickHelperBinary,
  resolveSkillTrajectoryPath,
} from "../src/paths.ts";
import { waitForRecorderExit } from "../src/record.ts";

describe("paths", () => {
  test("resolveSkillTrajectoryPath returns ~/.cua/skills/<name>/trajectory", () => {
    const result = resolveSkillTrajectoryPath("triage-issues");
    expect(result).toMatch(/\.cua\/skills\/triage-issues\/trajectory$/);
  });

  test("resolveOpenclickHelperBinary honors the OPENCLICK_HELPER_BIN override", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclick-helper-"));
    const fakeBinary = join(dir, "OpenclickHelper");
    writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBinary, 0o755);

    const original = Bun.env.OPENCLICK_HELPER_BIN;
    Bun.env.OPENCLICK_HELPER_BIN = fakeBinary;
    try {
      expect(resolveOpenclickHelperBinary()).toBe(fakeBinary);
    } finally {
      if (original === undefined) Bun.env.OPENCLICK_HELPER_BIN = undefined;
      else Bun.env.OPENCLICK_HELPER_BIN = original;
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
