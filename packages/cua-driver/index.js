import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const scopeRoot = dirname(root);

export function resolveCuaDriverBinary() {
  if (process.platform !== "darwin") return null;
  const archPackage =
    process.arch === "arm64" ? "cua-driver-darwin-arm64" : null;
  if (!archPackage) return null;
  const candidates = [
    join(scopeRoot, archPackage, "bin", "cua-driver"),
    join(root, "node_modules", "@openclick", archPackage, "bin", "cua-driver"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
