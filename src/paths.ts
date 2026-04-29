import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveSkillTrajectoryPath(skillName: string): string {
  return join(homedir(), ".cua", "skills", skillName, "trajectory");
}

export function resolveSkillRoot(skillName: string): string {
  return join(homedir(), ".cua", "skills", skillName);
}

export function resolveOpenClickHome(): string {
  return Bun.env.OPENCLICK_HOME ?? join(homedir(), ".openclick");
}

export function resolveAppMemoryRoot(): string {
  return join(resolveOpenClickHome(), "apps");
}

export function resolveAppMemoryPath(bundleId: string): string {
  return join(
    resolveAppMemoryRoot(),
    sanitizeBundleId(bundleId),
    "memory.json",
  );
}

export function resolveRunLockPath(): string {
  return join(resolveOpenClickHome(), "run.lock");
}

export function resolveRunCancelPath(runId: string): string {
  return join(
    resolveOpenClickHome(),
    "runs",
    sanitizeBundleId(runId),
    "cancel",
  );
}

export function resolveRunInterventionPath(runId: string): string {
  return join(
    resolveOpenClickHome(),
    "runs",
    sanitizeBundleId(runId),
    "intervention.json",
  );
}

export function resolveRunTakeoverResumePath(runId: string): string {
  return join(
    resolveOpenClickHome(),
    "runs",
    sanitizeBundleId(runId),
    "takeover-resume.json",
  );
}

export function resolveRunTracePath(runId: string): string {
  return join(
    resolveOpenClickHome(),
    "runs",
    sanitizeBundleId(runId),
    "trace.json",
  );
}

export function resolveApiRunOutputPath(runId: string): string {
  return join(
    resolveOpenClickHome(),
    "runs",
    sanitizeBundleId(runId),
    "api-output.json",
  );
}

export function resolveApiRunEventsPath(runId: string): string {
  return join(
    resolveOpenClickHome(),
    "runs",
    sanitizeBundleId(runId),
    "api-events.jsonl",
  );
}

function sanitizeBundleId(bundleId: string): string {
  return bundleId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function resolveCuaDriverBinary(): string | null {
  const candidates = [
    Bun.env.OPENCLICK_CUA_DRIVER_BIN,
    Bun.env.CUA_DRIVER,
    resolveNpmCuaDriverBinary(),
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

function resolveNpmCuaDriverBinary(): string | null {
  if (process.platform !== "darwin") return null;
  if (process.arch !== "arm64") return null;

  const packageRoot = join(import.meta.dir, "..");
  const candidates = [
    join(
      packageRoot,
      "node_modules",
      "@openclick",
      "cua-driver",
      "bin",
      "cua-driver",
    ),
    join(
      packageRoot,
      "node_modules",
      "@openclick",
      "cua-driver-darwin-arm64",
      "bin",
      "cua-driver",
    ),
  ];

  return candidates.find((path) => existsSync(path)) ?? null;
}

export function requireCuaDriverBinary(): string {
  const path = resolveCuaDriverBinary();
  if (!path) {
    throw new Error(
      "cua-driver not found. Re-run `openclick doctor` and install/configure cua-driver first.",
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
    "openclick-recorder",
  );
  return repoBin;
}
