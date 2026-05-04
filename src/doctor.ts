import { spawn as spawnDetached, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Badge, Box, colorize, fg, style } from "@vr_patel/tui";
import {
  OPENCLICK_HELPER_BUNDLE_ID,
  helperAppPathFromBinary,
  resolveOpenclickHelperBinary,
  resolveRecorderBinary,
} from "./paths.ts";
import { apiKeyStatus, resolveModelProvider } from "./settings.ts";

export type CheckStatus = "ok" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fixHint?: string;
}

export interface DoctorReport {
  results: CheckResult[];
  allOk: boolean;
  activity?: string;
}

/**
 * System probes. Real implementation shells out / reads env / runs the
 * recorder's --check-accessibility self-probe. Tests inject fakes.
 */
export interface SystemProbe {
  bunVersion(): string | null;
  macOSVersion(): string | null;
  openclickHelperPath(): string | null;
  openclickHelperDaemonRunning(): Promise<boolean>;
  openclickHelperSignatureValid(): Promise<boolean | null>;
  accessibilityGranted(): Promise<boolean>;
  screenRecordingGranted(): Promise<boolean>;
  recorderBinaryExists(): boolean;
  recorderHasAccessibility(): Promise<boolean>;
  anthropicApiKeySet(): boolean;
}

export interface DoctorOptions {
  includeRecorder?: boolean;
}

export class RealSystemProbe implements SystemProbe {
  bunVersion(): string | null {
    try {
      return Bun.version;
    } catch {
      return null;
    }
  }

  macOSVersion(): string | null {
    if (process.platform !== "darwin") return null;
    const result = spawnSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf8",
    });
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
  }

  openclickHelperPath(): string | null {
    return resolveOpenclickHelperBinary();
  }

  async openclickHelperDaemonRunning(): Promise<boolean> {
    const path = this.openclickHelperPath();
    if (!path) return false;
    const proc = Bun.spawn([path, "status"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  }

  async openclickHelperSignatureValid(): Promise<boolean | null> {
    if (Bun.env.OPENCLICK_HELPER_BIN) return null;
    const path = this.openclickHelperPath();
    if (!path) return null;
    const appPath = helperAppPathFromBinary(path);
    if (!appPath) return null;
    const proc = Bun.spawn(
      ["/usr/bin/codesign", "--verify", "--deep", "--strict", appPath],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await proc.exited;
    return proc.exitCode === 0;
  }

  async screenRecordingGranted(): Promise<boolean> {
    return this.permissionGranted(/screen[\s_]?recording/i);
  }

  async accessibilityGranted(): Promise<boolean> {
    return this.permissionGranted(/accessibility/i);
  }

  private async permissionGranted(namePattern: RegExp): Promise<boolean> {
    const path = this.openclickHelperPath();
    if (!path) return false;
    const proc = Bun.spawn([path, "check_permissions"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return false;
    const line = out.split("\n").find((l) => namePattern.test(l));
    if (!line) return false;
    if (/not\s+granted/i.test(line)) return false;
    return /(:\s*true\b|granted)/i.test(line);
  }

  recorderBinaryExists(): boolean {
    return existsSync(resolveRecorderBinary());
  }

  async recorderHasAccessibility(): Promise<boolean> {
    const bin = resolveRecorderBinary();
    if (!existsSync(bin)) return false;
    const proc = Bun.spawn([bin, "--check-accessibility"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  }

  anthropicApiKeySet(): boolean {
    return apiKeyStatus(resolveModelProvider()).available;
  }
}

const HELPER_INSTALL_HINT =
  "Run `openclick setup` to open the OpenclickHelper installer and permission window.";
const HELPER_DAEMON_AUTOFIX_HINT =
  "openclick starts OpenclickHelper automatically when the app or runner needs it";
const SR_HINT =
  "Run `openclick setup`. If Screen Recording is missing, grant it in System Settings -> Privacy & Security -> Screen Recording for OpenclickHelper, then restart the daemon.";
const RECORDER_BUILD_HINT =
  "cd mac-app && swift build -c release  # builds ./.build/release/openclick-recorder";
const ACCESSIBILITY_HINT =
  "Open System Settings → Privacy & Security → Accessibility → click + → add the recorder binary at the path above. Then re-run `openclick doctor`. (Each rebuild changes the binary's cdhash, so the grant must be re-added after rebuilds.)";
const API_KEY_HINT =
  "Run `openclick settings api-key set sk-ant-...`, `openclick settings openai-api-key set sk-...`, or add the provider API key to your shell.";

function macOSVersionResult(version: string | null): CheckResult {
  if (!version) {
    return {
      name: "macOS version",
      status: "fail",
      detail: "not detected",
      fixHint: "Requires macOS 13.0 or later.",
    };
  }
  if (!isAtLeastMacOS13(version)) {
    return {
      name: "macOS version",
      status: "fail",
      detail: version,
      fixHint: "Requires macOS 13.0 or later.",
    };
  }
  return { name: "macOS version", status: "ok", detail: version };
}

function isAtLeastMacOS13(version: string): boolean {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isInteger(major) && major >= 13;
}

export async function runDoctor(
  probe: SystemProbe,
  opts: DoctorOptions = {},
): Promise<DoctorReport> {
  const results: CheckResult[] = [];

  const bun = probe.bunVersion();
  results.push(
    bun
      ? { name: "bun runtime", status: "ok", detail: bun }
      : {
          name: "bun runtime",
          status: "fail",
          detail: "not detected",
          fixHint: "Install bun: https://bun.sh",
        },
  );

  const macOS = probe.macOSVersion();
  results.push(macOSVersionResult(macOS));

  const helperPath = probe.openclickHelperPath();
  results.push(
    helperPath
      ? {
          name: "OpenclickHelper installed",
          status: "ok",
          detail: `${helperPath} (${OPENCLICK_HELPER_BUNDLE_ID})`,
        }
      : {
          name: "OpenclickHelper installed",
          status: "fail",
          detail: "not found at /Applications or ~/Applications",
          fixHint: HELPER_INSTALL_HINT,
        },
  );

  const signatureValid = helperPath
    ? await probe.openclickHelperSignatureValid()
    : null;
  if (helperPath) {
    results.push(
      signatureValid === false
        ? {
            name: "OpenclickHelper signature",
            status: "fail",
            detail: "codesign verification failed",
            fixHint:
              "Reinstall the signed OpenclickHelper app with `openclick setup`.",
          }
        : {
            name: "OpenclickHelper signature",
            status: "ok",
            detail:
              signatureValid === null
                ? "skipped for OPENCLICK_HELPER_BIN"
                : "valid",
          },
    );
  }

  const daemonRunning = helperPath
    ? await probe.openclickHelperDaemonRunning()
    : false;
  results.push(
    daemonRunning
      ? { name: "OpenclickHelper daemon", status: "ok", detail: "running" }
      : {
          name: "OpenclickHelper daemon",
          status: "fail",
          detail: "not running",
          fixHint: HELPER_DAEMON_AUTOFIX_HINT,
        },
  );

  const ax = daemonRunning ? await probe.accessibilityGranted() : false;
  results.push(
    ax
      ? {
          name: "Accessibility (OpenclickHelper)",
          status: "ok",
          detail: "granted",
        }
      : {
          name: "Accessibility (OpenclickHelper)",
          status: "fail",
          detail: daemonRunning
            ? "not granted"
            : "skipped (daemon not running)",
          fixHint:
            "Grant Accessibility in System Settings -> Privacy & Security -> Accessibility for OpenclickHelper, then restart the daemon.",
        },
  );

  const sr = daemonRunning ? await probe.screenRecordingGranted() : false;
  results.push(
    sr
      ? {
          name: "Screen Recording (OpenclickHelper)",
          status: "ok",
          detail: "granted",
        }
      : {
          name: "Screen Recording (OpenclickHelper)",
          status: "fail",
          detail: daemonRunning
            ? "not granted"
            : "skipped (daemon not running)",
          fixHint: SR_HINT,
        },
  );

  if (opts.includeRecorder) {
    const recBin = probe.recorderBinaryExists();
    const { resolveRecorderBinary } = await import("./paths.ts");
    const recPath = resolveRecorderBinary();
    results.push(
      recBin
        ? { name: "Swift recorder built", status: "ok", detail: recPath }
        : {
            name: "Swift recorder built",
            status: "fail",
            detail: `missing at ${recPath}`,
            fixHint: RECORDER_BUILD_HINT,
          },
    );

    const recorderAx = recBin ? await probe.recorderHasAccessibility() : false;
    results.push(
      recorderAx
        ? {
            name: "Accessibility (recorder)",
            status: "ok",
            detail: "granted to recorder cdhash",
          }
        : {
            name: "Accessibility (recorder)",
            status: "fail",
            detail: recBin
              ? "not granted to recorder cdhash"
              : "skipped (recorder not built)",
            fixHint: recBin
              ? `${ACCESSIBILITY_HINT}\n         Path: ${recPath}`
              : ACCESSIBILITY_HINT,
          },
    );
  }

  const provider = resolveModelProvider();
  const apiKeyName =
    provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const apiKey = probe.anthropicApiKeySet();
  results.push(
    apiKey
      ? {
          name: apiKeyName,
          status: "ok",
          detail: `configured for ${provider}`,
        }
      : {
          name: apiKeyName,
          status: "fail",
          detail: "unset",
          fixHint: API_KEY_HINT,
        },
  );

  return { results, allOk: results.every((r) => r.status === "ok") };
}

export async function runDoctorWithAutostart(
  probe: SystemProbe,
  opts: DoctorOptions & {
    autostartTimeoutMs?: number;
    autostartPollMs?: number;
    onActivity?: (activity: string) => void;
    quiet?: boolean;
  } = {},
): Promise<DoctorReport> {
  const report = await runDoctor(probe, opts);
  const driverInstalled = report.results.some(
    (r) => r.name === "OpenclickHelper installed" && r.status === "ok",
  );
  if (!driverInstalled) return report;

  const daemon = report.results.find(
    (r) => r.name === "OpenclickHelper daemon",
  );
  if (daemon?.status !== "fail") return report;

  opts.onActivity?.("Starting OpenclickHelper...");
  const result = await tryAutoStartDaemon(probe, {
    timeoutMs: opts.autostartTimeoutMs,
    pollMs: opts.autostartPollMs,
  });
  if (!opts.quiet) console.error(result.message);
  const next = await runDoctor(probe, opts);
  next.activity = result.started
    ? "OpenclickHelper started. Checking permissions..."
    : normalizeDoctorActivity(result.message);
  return next;
}

export async function watchDoctor(
  probe: SystemProbe,
  opts: DoctorOptions & {
    intervalMs?: number;
    clearScreen?: boolean;
    onReport?: (report: DoctorReport) => void;
  } = {},
): Promise<DoctorReport> {
  const intervalMs = opts.intervalMs ?? 1500;
  let activity = "Preparing checks...";
  while (true) {
    const report = await runDoctorWithAutostart(probe, {
      ...opts,
      quiet: true,
      onActivity: (next) => {
        activity = next;
        if (opts.clearScreen ?? true) {
          process.stdout.write("\x1b[2J\x1b[H");
        }
        process.stdout.write(
          formatDoctorReport({ results: [], allOk: false, activity }),
        );
      },
    });
    activity =
      report.activity ??
      (report.allOk ? "Ready." : "Waiting for permissions...");
    if (opts.clearScreen ?? true) {
      process.stdout.write("\x1b[2J\x1b[H");
    }
    process.stdout.write(formatDoctorReport({ ...report, activity }));
    opts.onReport?.(report);
    if (report.allOk) return report;
    await sleep(intervalMs);
  }
}

/**
 * Attempts to launch the resolved OpenclickHelper daemon directly, then polls the
 * probe until it reports the daemon as running or a deadline elapses.
 * Side-effecty by design — kept out of `runDoctor` so the report builder stays
 * pure.
 *
 * Returns:
 *   started: true  → polling observed daemon transition to running
 *   started: false → daemon was already running (no-op), or polling timed out,
 *                    or the spawn failed
 * `message` is a one-liner suitable for printing to the user.
 */
export async function tryAutoStartDaemon(
  probe: SystemProbe,
  opts: {
    launch?: (openclickHelper: string) => void;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<{ started: boolean; message: string }> {
  // Don't double-start.
  if (await probe.openclickHelperDaemonRunning()) {
    return { started: false, message: "[doctor] daemon already running" };
  }

  const helper = probe.openclickHelperPath();
  if (!helper) {
    return {
      started: false,
      message:
        "[doctor] could not start OpenclickHelper automatically because no helper app was found.",
    };
  }

  try {
    const launch = opts.launch ?? launchOpenclickHelperDaemon;
    launch(helper);
  } catch (e) {
    return {
      started: false,
      message: `[doctor] could not start OpenclickHelper automatically (${(e as Error).message}). Reinstall OpenclickHelper or open the openclick permissions window again.`,
    };
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  const pollMs = opts.pollMs ?? 250;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (await probe.openclickHelperDaemonRunning()) {
      return { started: true, message: "[doctor] daemon up" };
    }
  }

  return {
    started: false,
    message:
      "[doctor] OpenclickHelper did not come up within 5s. It may still be launching - re-run `openclick doctor` in a moment.",
  };
}

function normalizeDoctorActivity(message: string): string {
  return message.replace(/^\[doctor\]\s*/i, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function launchOpenclickHelperDaemon(openclickHelper: string): void {
  const proc = spawnDetached(openclickHelper, ["serve"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OPENCLICK_HELPER_NO_RELAUNCH: "1" },
  });
  proc.unref();
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(
    `${colorize("OpenClick", fg.cyan, style.bold)} ${Badge.outline("setup", fg.cyan)} ${report.allOk ? Badge.success("READY") : Badge.warning("ACTION NEEDED")}`,
  );
  if (report.activity) {
    lines.push("");
    lines.push(
      `${colorize("●", fg.cyan, style.bold)} ${colorize(report.activity, fg.cyan)}`,
    );
  }
  lines.push("");
  for (const r of report.results) {
    const mark = r.status === "ok" ? "✓" : "✗";
    const statusColor = r.status === "ok" ? fg.green : fg.red;
    const padded = r.name.padEnd(36);
    const explanation = prerequisiteExplanation(r.name);
    lines.push(
      `  ${colorize(`${mark} ${padded}`, statusColor, style.bold)}${colorize(formatDoctorDetail(r), r.status === "ok" ? fg.green : fg.yellow)}${explanation ? colorize(` - ${explanation}`, fg.gray) : ""}`,
    );
    if (r.status === "fail" && r.fixHint) {
      lines.push(`       ${colorize(`→ ${formatDoctorHint(r)}`, fg.cyan)}`);
    }
  }
  lines.push("");
  if (report.allOk) {
    lines.push(colorize("All set. Try:", fg.green, style.bold));
    lines.push(
      colorize(
        "  openclick record my-first-skill 'describe what you're about to do'",
        fg.gray,
      ),
    );
  } else {
    const failed = report.results.filter((r) => r.status === "fail").length;
    lines.push(
      colorize(
        failed > 0
          ? `Fix the ${failed} issue(s) above. This view refreshes automatically. Press Ctrl-C to stop.`
          : "Checking status. This view refreshes automatically. Press Ctrl-C to stop.",
        fg.yellow,
        style.bold,
      ),
    );
  }
  const box = new Box({
    title: "Status",
    borderStyle: "round",
    borderColor: report.allOk ? fg.green : fg.yellow,
    titleColor: report.allOk ? fg.green : fg.yellow,
    paddingX: 1,
    paddingY: 1,
    width: 98,
    dimBorder: true,
  });
  return `\n${box.render(lines.join("\n"))}\n`;
}

function formatDoctorDetail(result: CheckResult): string {
  if (result.name === "OpenclickHelper installed" && result.status === "ok") {
    return "found";
  }
  if (result.name === "OpenclickHelper daemon" && result.status === "fail") {
    return "starting automatically";
  }
  if (result.detail === "skipped (daemon not running)") {
    return "waiting for OpenclickHelper";
  }
  return result.detail;
}

function formatDoctorHint(result: CheckResult): string {
  if (result.name === "OpenclickHelper daemon") {
    return "OpenClick is starting OpenclickHelper now. Keep this window open.";
  }
  if (result.name.includes("Accessibility")) {
    return "Grant OpenclickHelper in System Settings > Privacy & Security > Accessibility.";
  }
  if (result.name.includes("Screen Recording")) {
    return "Grant OpenclickHelper in System Settings > Privacy & Security > Screen Recording.";
  }
  if (result.name.endsWith("_API_KEY")) {
    return "Run `openclick setup` or `openclick settings api-key set <key>`.";
  }
  return result.fixHint ?? "";
}

function prerequisiteExplanation(name: string): string {
  if (name.includes("Accessibility")) {
    return "Needed to click and type.";
  }
  if (name.includes("Screen Recording")) {
    return "Needed to see and verify progress.";
  }
  if (name.includes("OpenclickHelper")) {
    return "Local desktop helper.";
  }
  if (name === "macOS version") {
    return "Ventura or later is required.";
  }
  if (name.endsWith("_API_KEY")) {
    return "Needed for the selected model.";
  }
  return "";
}
