import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveSkillTrajectoryPath(skillName: string): string {
  return join(homedir(), ".cua", "skills", skillName, "trajectory");
}

export function resolveSkillRoot(skillName: string): string {
  return join(homedir(), ".cua", "skills", skillName);
}

export function resolveOpen42Home(): string {
  return (
    Bun.env.OPEN42_HOME ?? Bun.env.SHOWME_HOME ?? join(homedir(), ".open42")
  );
}

export function resolveAppMemoryRoot(): string {
  return join(resolveOpen42Home(), "apps");
}

export function resolveAppMemoryPath(bundleId: string): string {
  return join(
    resolveAppMemoryRoot(),
    sanitizeBundleId(bundleId),
    "memory.json",
  );
}

export function resolveRunLockPath(): string {
  return join(resolveOpen42Home(), "run.lock");
}

export function resolveRunCancelPath(runId: string): string {
  return join(resolveOpen42Home(), "runs", sanitizeBundleId(runId), "cancel");
}

export function resolveRunInterventionPath(runId: string): string {
  return join(
    resolveOpen42Home(),
    "runs",
    sanitizeBundleId(runId),
    "intervention.json",
  );
}

export function resolveRunTakeoverResumePath(runId: string): string {
  return join(
    resolveOpen42Home(),
    "runs",
    sanitizeBundleId(runId),
    "takeover-resume.json",
  );
}

export function resolveRunTracePath(runId: string): string {
  return join(
    resolveOpen42Home(),
    "runs",
    sanitizeBundleId(runId),
    "trace.json",
  );
}

function sanitizeBundleId(bundleId: string): string {
  return bundleId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function resolveCuaDriverBinary(): string | null {
  const candidates = [
    Bun.env.OPEN42_CUA_DRIVER_BIN,
    Bun.env.CUA_DRIVER,
    resolveBundledCuaDriverBinary(),
    Bun.which("cua-driver"),
    "/usr/local/bin/cua-driver",
    "/opt/homebrew/bin/cua-driver",
    "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
  ];
  for (const path of candidates) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

function resolveBundledCuaDriverBinary(): string {
  return join(import.meta.dir, "..", "..", "cua-driver");
}

export function requireCuaDriverBinary(): string {
  const path = resolveCuaDriverBinary();
  if (!path) {
    throw new Error(
      "cua-driver not found. Re-run `open42 doctor` and install/configure cua-driver first.",
    );
  }
  return path;
}

export function resolveRecorderBinary(): string {
  // First check vendored binary in the repo (built via `swift build`).
  const repoBin = join(
    import.meta.dir,
    "..",
    "mac-app",
    ".build",
    "release",
    "open42-recorder",
  );
  return repoBin;
}
