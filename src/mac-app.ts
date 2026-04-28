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

export async function launchMacApp(options: { detach?: boolean } = {}) {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const open42Bin = join(repoRoot, "bin", "open42");
  const packagePath = join(repoRoot, "mac-app");

  const build = Bun.spawn(["swift", "build", "--package-path", packagePath], {
    cwd: repoRoot,
    stdout: options.detach ? "ignore" : "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  const buildCode = await build.exited;
  if (buildCode !== 0) {
    throw new Error(`Open42 app build failed with status ${buildCode}`);
  }

  const executable = join(
    packagePath,
    ".build",
    process.arch === "arm64" ? "arm64-apple-macosx" : "x86_64-apple-macosx",
    "debug",
    "open42-app",
  );

  if (options.detach) {
    const appPath = createAppBundle({
      repoRoot,
      executable,
      open42Bin,
    });
    const launch = Bun.spawn(["/usr/bin/open", "-n", appPath], {
      cwd: repoRoot,
      stdout: "ignore",
      stderr: "inherit",
      stdin: "ignore",
    });
    const code = await launch.exited;
    if (code !== 0) {
      throw new Error(`Open42 app launch failed with status ${code}`);
    }
    console.log("[open42] Mac app launched.");
    return;
  }

  const proc = Bun.spawn([executable], {
    cwd: repoRoot,
    env: {
      ...Bun.env,
      OPEN42_REPO_ROOT: repoRoot,
      OPEN42_BIN: open42Bin,
    },
    stdout: options.detach ? "ignore" : "inherit",
    stderr: options.detach ? "ignore" : "inherit",
    stdin: "ignore",
  });

  const code = await proc.exited;
  // 130 (SIGINT) and 143 (SIGTERM) mean "user closed the attached run" — not a crash.
  if (code !== 0 && code !== 130 && code !== 143) {
    throw new Error(`Open42 app exited with status ${code}`);
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
  open42Bin: string;
}): string {
  const appPath = join(options.repoRoot, ".build", "Open42App.app");
  const contentsPath = join(appPath, "Contents");
  const macOsPath = join(contentsPath, "MacOS");
  const resourcesPath = join(contentsPath, "Resources");
  const bundledExecutable = join(macOsPath, "open42-app");
  const bundledRecorder = join(resourcesPath, "open42-recorder");
  const bundledCuaDriver = join(resourcesPath, "cua-driver");
  const bundledCliRoot = join(resourcesPath, "open42-cli");
  const bundledCliBinDir = join(bundledCliRoot, "bin");
  const bundledCli = join(bundledCliBinDir, "open42");
  const cuaDriverSource = resolveCuaDriverBundleSource(options.repoRoot);

  mkdirSync(macOsPath, { recursive: true });
  mkdirSync(resourcesPath, { recursive: true });
  rmSync(bundledCliRoot, { recursive: true, force: true });
  mkdirSync(bundledCliBinDir, { recursive: true });
  copyFileSync(options.executable, bundledExecutable);
  const recorderExecutable = join(
    dirname(options.executable),
    "open42-recorder",
  );
  if (existsSync(recorderExecutable)) {
    copyFileSync(recorderExecutable, bundledRecorder);
    chmodSync(bundledRecorder, 0o755);
  }
  if (cuaDriverSource) {
    copyFileSync(cuaDriverSource, bundledCuaDriver);
    chmodSync(bundledCuaDriver, 0o755);
  }
  copyFileSync(options.open42Bin, bundledCli);
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
  <string>open42-app</string>
  <key>CFBundleIdentifier</key>
  <string>dev.open42.app</string>
  <key>CFBundleName</key>
  <string>open42</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSEnvironment</key>
  <dict>
    <key>OPEN42_REPO_ROOT</key>
    <string>${escapePlist(options.repoRoot)}</string>
    <key>OPEN42_BIN</key>
    <string>${escapePlist(bundledCli)}</string>
    ${
      cuaDriverSource
        ? `<key>CUA_DRIVER</key>
    <string>${escapePlist(bundledCuaDriver)}</string>`
        : ""
    }
  </dict>
</dict>
</plist>
`,
  );

  return appPath;
}

function resolveCuaDriverBundleSource(repoRoot: string): string | null {
  const candidates = [
    Bun.env.OPEN42_CUA_DRIVER_BIN,
    Bun.env.CUA_DRIVER,
    join(
      dirname(repoRoot),
      "cua",
      "libs",
      "cua-driver",
      ".build",
      "release",
      "cua-driver",
    ),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function escapePlist(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
