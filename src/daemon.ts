import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DAEMON_LABEL = "dev.openclick.server";
export const DEFAULT_DAEMON_HOST = "127.0.0.1";
export const DEFAULT_DAEMON_PORT = 4242;

export interface DaemonInstallOptions {
  openclickBin?: string;
  host?: string;
  port?: number;
  token?: string;
}

export interface DaemonStatus {
  installed: boolean;
  loaded: boolean;
  path: string;
  label: string;
}

export function resolveLaunchAgentPath(): string {
  const dir =
    Bun.env.OPENCLICK_LAUNCH_AGENTS_DIR ??
    join(homedir(), "Library", "LaunchAgents");
  return join(dir, `${DAEMON_LABEL}.plist`);
}

export function currentOpenClickBin(): string {
  if (Bun.env.OPENCLICK_BIN) return resolve(Bun.env.OPENCLICK_BIN);
  if (Bun.argv[1]) return resolve(Bun.argv[1]);
  return "openclick";
}

export function buildLaunchAgentPlist(opts: DaemonInstallOptions = {}): string {
  const bin = opts.openclickBin ?? currentOpenClickBin();
  const host = opts.host ?? DEFAULT_DAEMON_HOST;
  const port = String(opts.port ?? DEFAULT_DAEMON_PORT);
  const env = opts.token
    ? `
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENCLICK_SERVER_TOKEN</key>
    <string>${escapePlist(opts.token)}</string>
  </dict>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapePlist(bin)}</string>
    <string>server</string>
    <string>--host</string>
    <string>${escapePlist(host)}</string>
    <string>--port</string>
    <string>${escapePlist(port)}</string>
  </array>${env}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapePlist(join(homedir(), ".openclick", "server.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(join(homedir(), ".openclick", "server.err.log"))}</string>
</dict>
</plist>
`;
}

export function installDaemon(opts: DaemonInstallOptions = {}): string {
  const path = resolveLaunchAgentPath();
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(homedir(), ".openclick"), { recursive: true });
  writeFileSync(path, buildLaunchAgentPlist(opts), { mode: 0o644 });
  if (!Bun.env.OPENCLICK_SKIP_LAUNCHCTL) {
    runLaunchctl(["bootstrap", launchctlDomain(), path], true);
    runLaunchctl(
      ["kickstart", "-k", `${launchctlDomain()}/${DAEMON_LABEL}`],
      true,
    );
  }
  return path;
}

export function uninstallDaemon(): void {
  const path = resolveLaunchAgentPath();
  if (!Bun.env.OPENCLICK_SKIP_LAUNCHCTL) {
    runLaunchctl(["bootout", launchctlDomain(), path], true);
  }
  rmSync(path, { force: true });
}

export function daemonStatus(): DaemonStatus {
  const path = resolveLaunchAgentPath();
  const installed = existsSync(path);
  let loaded = false;
  if (!Bun.env.OPENCLICK_SKIP_LAUNCHCTL) {
    const result = runLaunchctl(
      ["print", `${launchctlDomain()}/${DAEMON_LABEL}`],
      true,
    );
    loaded = result === 0;
  } else if (installed) {
    loaded = true;
  }
  return { installed, loaded, path, label: DAEMON_LABEL };
}

export function daemonPlist(): string | null {
  const path = resolveLaunchAgentPath();
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function runLaunchctl(args: string[], tolerateFailure: boolean): number {
  const proc = Bun.spawnSync(["/bin/launchctl", ...args], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  if (!tolerateFailure && proc.exitCode !== 0) {
    throw new Error(`launchctl ${args.join(" ")} failed`);
  }
  return proc.exitCode ?? 1;
}

function launchctlDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

function escapePlist(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
