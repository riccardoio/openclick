import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPENCLICK_HELPER_APP_NAME,
  OPENCLICK_HELPER_BUNDLE_ID,
  OPENCLICK_HELPER_EXECUTABLE_NAME,
} from "./paths.ts";

export async function launchMacApp(options: { detach?: boolean } = {}) {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const openclickBin = join(repoRoot, "bin", "openclick");
  const packagePath = join(repoRoot, "mac-app");

  const build = Bun.spawn(["swift", "build", "--package-path", packagePath], {
    cwd: repoRoot,
    stdout: options.detach ? "ignore" : "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  const buildCode = await build.exited;
  if (buildCode !== 0) {
    throw new Error(
      `OpenclickHelper app build failed with status ${buildCode}`,
    );
  }

  const executable = join(
    packagePath,
    ".build",
    process.arch === "arm64" ? "arm64-apple-macosx" : "x86_64-apple-macosx",
    "debug",
    OPENCLICK_HELPER_EXECUTABLE_NAME,
  );

  if (options.detach) {
    const appPath = createAppBundle({
      repoRoot,
      executable,
      openclickBin,
    });
    const launch = Bun.spawn(["/usr/bin/open", "-n", appPath], {
      cwd: repoRoot,
      stdout: "ignore",
      stderr: "inherit",
      stdin: "ignore",
    });
    const code = await launch.exited;
    if (code !== 0) {
      throw new Error(`OpenclickHelper app launch failed with status ${code}`);
    }
    console.log("[openclick] OpenclickHelper app launched.");
    return;
  }

  const proc = Bun.spawn([executable], {
    cwd: repoRoot,
    env: {
      ...Bun.env,
      OPENCLICK_REPO_ROOT: repoRoot,
      OPENCLICK_BIN: openclickBin,
    },
    stdout: options.detach ? "ignore" : "inherit",
    stderr: options.detach ? "ignore" : "inherit",
    stdin: "ignore",
  });

  const code = await proc.exited;
  // 130 (SIGINT) and 143 (SIGTERM) mean "user closed the attached run" — not a crash.
  if (code !== 0 && code !== 130 && code !== 143) {
    throw new Error(`OpenclickHelper app exited with status ${code}`);
  }
}

if (import.meta.main) {
  if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
    console.log("Usage: bun src/mac-app.ts [--detach]");
    process.exit(0);
  }
  launchMacApp({ detach: Bun.argv.includes("--detach") }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

function createAppBundle(options: {
  repoRoot: string;
  executable: string;
  openclickBin: string;
}): string {
  const appPath = join(options.repoRoot, ".build", OPENCLICK_HELPER_APP_NAME);
  const contentsPath = join(appPath, "Contents");
  const macOsPath = join(contentsPath, "MacOS");
  const resourcesPath = join(contentsPath, "Resources");
  const bundledExecutable = join(macOsPath, OPENCLICK_HELPER_EXECUTABLE_NAME);
  const bundledRecorder = join(resourcesPath, "openclick-recorder");
  const bundledCliRoot = join(resourcesPath, "openclick-cli");
  const bundledCliBinDir = join(bundledCliRoot, "bin");
  const bundledCli = join(bundledCliBinDir, "openclick");

  mkdirSync(macOsPath, { recursive: true });
  mkdirSync(resourcesPath, { recursive: true });
  rmSync(bundledCliRoot, { recursive: true, force: true });
  mkdirSync(bundledCliBinDir, { recursive: true });
  copyFileSync(options.executable, bundledExecutable);
  const recorderExecutable = join(
    dirname(options.executable),
    "openclick-recorder",
  );
  if (existsSync(recorderExecutable)) {
    copyFileSync(recorderExecutable, bundledRecorder);
    chmodSync(bundledRecorder, 0o755);
  }
  copyFileSync(options.openclickBin, bundledCli);
  cpSync(join(options.repoRoot, "src"), join(bundledCliRoot, "src"), {
    recursive: true,
    filter: (source) => !source.endsWith("mac-app.ts"),
  });
  copyFileSync(
    join(options.repoRoot, "VERSION"),
    join(bundledCliRoot, "VERSION"),
  );
  chmodSync(bundledExecutable, 0o755);
  chmodSync(bundledCli, 0o755);

  writeFileSync(
    join(contentsPath, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${OPENCLICK_HELPER_EXECUTABLE_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${OPENCLICK_HELPER_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>OpenclickHelper</string>
  <key>CFBundleDisplayName</key>
  <string>OpenclickHelper</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSEnvironment</key>
  <dict>
    <key>OPENCLICK_REPO_ROOT</key>
    <string>${escapePlist(options.repoRoot)}</string>
    <key>OPENCLICK_BIN</key>
    <string>${escapePlist(bundledCli)}</string>
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
