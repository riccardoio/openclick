import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const sourceApp = join(root, "OpenclickHelper.app");
const appName = "OpenclickHelper.app";

function warn(message) {
  console.warn(`[openclick-helper] ${message}`);
}

function bundleVersion(appPath) {
  const plist = join(appPath, "Contents", "Info.plist");
  if (!existsSync(plist)) return null;
  try {
    return execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print:CFBundleVersion", plist],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null;
  }
}

function copyIfNeeded(destination) {
  const sourceVersion = bundleVersion(sourceApp);
  const destinationVersion = bundleVersion(destination);
  if (
    sourceVersion &&
    destinationVersion &&
    sourceVersion === destinationVersion
  ) {
    return true;
  }

  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    rmSync(destination, { recursive: true, force: true });
  }
  cpSync(sourceApp, destination, { recursive: true });
  return true;
}

if (process.platform !== "darwin") {
  process.exit(0);
}

if (!existsSync(sourceApp)) {
  warn("bundled OpenclickHelper.app is missing; run `openclick setup` after install.");
  process.exit(0);
}

const destinations = [
  join("/Applications", appName),
  join(homedir(), "Applications", appName),
];

let lastError = null;
for (const destination of destinations) {
  try {
    if (copyIfNeeded(destination)) process.exit(0);
  } catch (error) {
    lastError = error;
  }
}

warn(
  `could not copy OpenclickHelper.app to /Applications or ~/Applications: ${
    lastError?.message ?? "unknown error"
  }`,
);
process.exit(0);
