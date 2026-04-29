import { spawn as spawnDetached } from "node:child_process";
import { existsSync } from "node:fs";
import { Badge, Box, colorize, fg, style } from "@vr_patel/tui";
import { resolveCuaDriverBinary, resolveRecorderBinary } from "./paths.ts";
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
  cuaDriverPath(): string | null;
  cuaDriverDaemonRunning(): Promise<boolean>;
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

  cuaDriverPath(): string | null {
    return resolveCuaDriverBinary();
  }

  async cuaDriverDaemonRunning(): Promise<boolean> {
    const path = this.cuaDriverPath();
    if (!path) return false;
    const proc = Bun.spawn([path, "status"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
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
    const path = this.cuaDriverPath();
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

const CUA_INSTALL_HINT =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"';
const CUA_DAEMON_AUTOFIX_HINT =
  "openclick starts this automatically when the app or runner needs it";
const SR_HINT =
  "Run `cua-driver check_permissions`. If Screen Recording is missing, grant it in System Settings → Privacy & Security → Screen Recording for the CuaDriver app, then restart the daemon.";
const RECORDER_BUILD_HINT =
  "cd mac-app && swift build -c release  # builds ./.build/release/openclick-recorder";
const ACCESSIBILITY_HINT =
  "Open System Settings → Privacy & Security → Accessibility → click + → add the recorder binary at the path above. Then re-run `openclick doctor`. (Each rebuild changes the binary's cdhash, so the grant must be re-added after rebuilds.)";
const API_KEY_HINT =
  "Run `openclick settings api-key set sk-ant-...`, `openclick settings openai-api-key set sk-...`, or add the provider API key to your shell.";

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

  const cuaPath = probe.cuaDriverPath();
  results.push(
    cuaPath
      ? { name: "cua-driver installed", status: "ok", detail: cuaPath }
      : {
          name: "cua-driver installed",
          status: "fail",
          detail: "not found in PATH or standard locations",
          fixHint: `Install: ${CUA_INSTALL_HINT}`,
        },
  );

  const daemonRunning = cuaPath ? await probe.cuaDriverDaemonRunning() : false;
  results.push(
    daemonRunning
      ? { name: "cua-driver daemon", status: "ok", detail: "running" }
      : {
          name: "cua-driver daemon",
          status: "fail",
          detail: "not running",
          fixHint: CUA_DAEMON_AUTOFIX_HINT,
        },
  );

  const ax = daemonRunning ? await probe.accessibilityGranted() : false;
  results.push(
    ax
      ? {
          name: "Accessibility (via cua-driver)",
          status: "ok",
          detail: "granted",
        }
      : {
          name: "Accessibility (via cua-driver)",
          status: "fail",
          detail: daemonRunning
            ? "not granted"
            : "skipped (daemon not running)",
          fixHint:
            "Grant Accessibility in System Settings → Privacy & Security → Accessibility for CuaDriver, then restart the daemon.",
        },
  );

  const sr = daemonRunning ? await probe.screenRecordingGranted() : false;
  results.push(
    sr
      ? {
          name: "Screen Recording (via cua-driver)",
          status: "ok",
          detail: "granted",
        }
      : {
          name: "Screen Recording (via cua-driver)",
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
    (r) => r.name === "cua-driver installed" && r.status === "ok",
  );
  if (!driverInstalled) return report;

  const daemon = report.results.find((r) => r.name === "cua-driver daemon");
  if (daemon?.status !== "fail") return report;

  opts.onActivity?.("Starting CuaDriver...");
  const result = await tryAutoStartDaemon(probe, {
    timeoutMs: opts.autostartTimeoutMs,
    pollMs: opts.autostartPollMs,
  });
  if (!opts.quiet) console.error(result.message);
  const next = await runDoctor(probe, opts);
  next.activity = result.started
    ? "CuaDriver started. Checking permissions..."
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
 * Attempts to launch the resolved cua-driver daemon directly, then polls the
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
    launch?: (cuaDriver: string) => void;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<{ started: boolean; message: string }> {
  // Don't double-start.
  if (await probe.cuaDriverDaemonRunning()) {
    return { started: false, message: "[doctor] daemon already running" };
  }

  const cuaDriver = probe.cuaDriverPath();
  if (!cuaDriver) {
    return {
      started: false,
      message:
        "[doctor] could not start the cua-driver helper automatically because no cua-driver binary was found.",
    };
  }

  // Fire-and-forget. Force the resolved binary to serve in-process so an older
  // /Applications/CuaDriver.app install cannot shadow a bundled driver.
  try {
    const launch = opts.launch ?? launchCuaDriverDaemon;
    launch(cuaDriver);
  } catch (e) {
    return {
      started: false,
      message: `[doctor] could not start the CuaDriver helper automatically (${(e as Error).message}). Reinstall CuaDriver or open the openclick permissions window again.`,
    };
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  const pollMs = opts.pollMs ?? 250;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (await probe.cuaDriverDaemonRunning()) {
      return { started: true, message: "[doctor] daemon up" };
    }
  }

  return {
    started: false,
    message:
      "[doctor] CuaDriver helper did not come up within 5s. It may still be launching — re-run `openclick doctor` in a moment.",
  };
}

function normalizeDoctorActivity(message: string): string {
  return message.replace(/^\[doctor\]\s*/i, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function launchCuaDriverDaemon(cuaDriver: string): void {
  const proc = spawnDetached(cuaDriver, ["serve"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CUA_DRIVER_NO_RELAUNCH: "1" },
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
  if (result.name === "cua-driver installed" && result.status === "ok") {
    return "found";
  }
  if (result.name === "cua-driver daemon" && result.status === "fail") {
    return "starting automatically";
  }
  if (result.detail === "skipped (daemon not running)") {
    return "waiting for CuaDriver";
  }
  return result.detail;
}

function formatDoctorHint(result: CheckResult): string {
  if (result.name === "cua-driver daemon") {
    return "OpenClick is starting it now. Keep this window open.";
  }
  if (result.name.includes("Accessibility")) {
    return "Grant CuaDriver in System Settings > Privacy & Security > Accessibility.";
  }
  if (result.name.includes("Screen Recording")) {
    return "Grant CuaDriver in System Settings > Privacy & Security > Screen Recording.";
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
  if (name.includes("cua-driver")) {
    return "Local desktop helper.";
  }
  if (name.endsWith("_API_KEY")) {
    return "Needed for the selected model.";
  }
  return "";
}
