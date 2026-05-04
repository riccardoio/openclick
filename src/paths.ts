import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OPENCLICK_HELPER_APP_NAME = "OpenclickHelper.app";
export const OPENCLICK_HELPER_EXECUTABLE_NAME = "OpenclickHelper";
export const OPENCLICK_HELPER_BUNDLE_ID = "com.openclick.helper";
export const OPENCLICK_HELPER_SYSTEM_APP_PATH = join(
  "/Applications",
  OPENCLICK_HELPER_APP_NAME,
);
export const OPENCLICK_HELPER_USER_APP_PATH = join(
  homedir(),
  "Applications",
  OPENCLICK_HELPER_APP_NAME,
);
export const OPENCLICK_HELPER_RELATIVE_BINARY = join(
  "Contents",
  "MacOS",
  OPENCLICK_HELPER_EXECUTABLE_NAME,
);

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

export function resolveSetupLockPath(): string {
  return join(resolveOpenClickHome(), "setup.lock");
}

export function resolveSetupStatusPath(): string {
  return join(resolveOpenClickHome(), "setup-status.json");
}

export function resolveSetupCompletionMarkerPath(): string {
  return join(resolveOpenClickHome(), "setup-complete");
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
  return resolveOpenclickHelperBinary();
}

export function resolveOpenclickHelperBinary(): string | null {
  const candidates = [
    Bun.env.OPENCLICK_HELPER_BIN,
    openclickHelperBinaryForApp(OPENCLICK_HELPER_SYSTEM_APP_PATH),
    openclickHelperBinaryForApp(OPENCLICK_HELPER_USER_APP_PATH),
    resolveNpmOpenclickHelperBinary(),
  ];
  for (const path of candidates) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

export function openclickHelperBinaryForApp(appPath: string): string {
  return join(appPath, OPENCLICK_HELPER_RELATIVE_BINARY);
}

export function resolveOpenclickHelperAppPath(): string | null {
  const binary = resolveOpenclickHelperBinary();
  if (!binary) return null;
  return helperAppPathFromBinary(binary);
}

export function helperAppPathFromBinary(binaryPath: string): string | null {
  const suffix = `/${OPENCLICK_HELPER_RELATIVE_BINARY}`;
  return binaryPath.endsWith(suffix)
    ? binaryPath.slice(0, -suffix.length)
    : null;
}

function resolveNpmOpenclickHelperBinary(): string | null {
  if (process.platform !== "darwin") return null;

  const packageRoot = join(import.meta.dir, "..");
  const candidates = [
    join(
      packageRoot,
      "node_modules",
      "@openclick",
      "openclick-helper-darwin",
      OPENCLICK_HELPER_APP_NAME,
      OPENCLICK_HELPER_RELATIVE_BINARY,
    ),
    join(
      packageRoot,
      "node_modules",
      "@openclick",
      "openclick-helper",
      OPENCLICK_HELPER_APP_NAME,
      OPENCLICK_HELPER_RELATIVE_BINARY,
    ),
  ];

  return candidates.find((path) => existsSync(path)) ?? null;
}

export function requireCuaDriverBinary(): string {
  return requireOpenclickHelperBinary();
}

export function requireOpenclickHelperBinary(): string {
  const path = resolveOpenclickHelperBinary();
  if (!path) {
    throw new Error(
      "OpenclickHelper not found. Re-run `openclick setup` to install and grant permissions.",
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
