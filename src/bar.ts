import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function launchChatBar(options: { detach?: boolean } = {}) {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const showmeBin = join(repoRoot, "bin", "showme");
  const packagePath = join(repoRoot, "recorder");

  const build = Bun.spawn(["swift", "build", "--package-path", packagePath], {
    cwd: repoRoot,
    stdout: options.detach ? "ignore" : "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  const buildCode = await build.exited;
  if (buildCode !== 0) {
    throw new Error(`showme bar build failed with status ${buildCode}`);
  }

  const executable = join(
    packagePath,
    ".build",
    process.arch === "arm64" ? "arm64-apple-macosx" : "x86_64-apple-macosx",
    "debug",
    "showme-bar",
  );

  if (options.detach) {
    const appPath = createAppBundle({
      repoRoot,
      executable,
      showmeBin,
    });
    const launch = Bun.spawn(["/usr/bin/open", "-n", appPath], {
      cwd: repoRoot,
      stdout: "ignore",
      stderr: "inherit",
      stdin: "ignore",
    });
    const code = await launch.exited;
    if (code !== 0) {
      throw new Error(`showme bar launch failed with status ${code}`);
    }
    console.log("[showme] chat bar launched.");
    return;
  }

  const proc = Bun.spawn([executable], {
    cwd: repoRoot,
    env: {
      ...Bun.env,
      SHOWME_REPO_ROOT: repoRoot,
      SHOWME_BIN: showmeBin,
    },
    stdout: options.detach ? "ignore" : "inherit",
    stderr: options.detach ? "ignore" : "inherit",
    stdin: "ignore",
  });

  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`showme bar exited with status ${code}`);
  }
}

function createAppBundle(options: {
  repoRoot: string;
  executable: string;
  showmeBin: string;
}): string {
  const appPath = join(options.repoRoot, ".build", "ShowmeBar.app");
  const contentsPath = join(appPath, "Contents");
  const macOsPath = join(contentsPath, "MacOS");
  const bundledExecutable = join(macOsPath, "showme-bar");

  mkdirSync(macOsPath, { recursive: true });
  copyFileSync(options.executable, bundledExecutable);
  chmodSync(bundledExecutable, 0o755);

  writeFileSync(
    join(contentsPath, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>showme-bar</string>
  <key>CFBundleIdentifier</key>
  <string>dev.showme.bar</string>
  <key>CFBundleName</key>
  <string>showme</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSEnvironment</key>
  <dict>
    <key>SHOWME_REPO_ROOT</key>
    <string>${escapePlist(options.repoRoot)}</string>
    <key>SHOWME_BIN</key>
    <string>${escapePlist(options.showmeBin)}</string>
  </dict>
</dict>
</plist>
`,
  );

  return appPath;
}

function escapePlist(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
