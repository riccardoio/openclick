import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveSkillTrajectoryPath(skillName: string): string {
  return join(homedir(), ".cua", "skills", skillName, "trajectory");
}

export function resolveSkillRoot(skillName: string): string {
  return join(homedir(), ".cua", "skills", skillName);
}

export function resolveShowmeHome(): string {
  return Bun.env.SHOWME_HOME ?? join(homedir(), ".showme");
}

export function resolveAppMemoryRoot(): string {
  return join(resolveShowmeHome(), "apps");
}

export function resolveAppMemoryPath(bundleId: string): string {
  return join(
    resolveAppMemoryRoot(),
    sanitizeBundleId(bundleId),
    "memory.json",
  );
}

export function resolveRunLockPath(): string {
  return join(resolveShowmeHome(), "run.lock");
}

export function resolveRunCancelPath(runId: string): string {
  return join(resolveShowmeHome(), "runs", sanitizeBundleId(runId), "cancel");
}

export function resolveRunTracePath(runId: string): string {
  return join(
    resolveShowmeHome(),
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
    Bun.env.CUA_DRIVER,
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

export function requireCuaDriverBinary(): string {
  const path = resolveCuaDriverBinary();
  if (!path) {
    throw new Error(
      "cua-driver not found. Re-run `showme doctor` and install/configure cua-driver first.",
    );
  }
  return path;
}

export function resolveRecorderBinary(): string {
  // First check vendored binary in the repo (built via `swift build`).
  const repoBin = join(
    import.meta.dir,
    "..",
    "recorder",
    ".build",
    "release",
    "showme-recorder",
  );
  return repoBin;
}
