import { existsSync } from "node:fs";
import { resolveRecorderBinary } from "./paths.ts";

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
}

/**
 * System probes. Real implementation shells out / reads env / runs the
 * recorder's --check-accessibility self-probe. Tests inject fakes.
 */
export interface SystemProbe {
  bunVersion(): string | null;
  cuaDriverPath(): string | null;
  cuaDriverDaemonRunning(): Promise<boolean>;
  screenRecordingGranted(): Promise<boolean>;
  recorderBinaryExists(): boolean;
  recorderHasAccessibility(): Promise<boolean>;
  anthropicApiKeySet(): boolean;
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
    const candidates = [
      Bun.env.CUA_DRIVER,
      "/usr/local/bin/cua-driver",
      "/opt/homebrew/bin/cua-driver",
      "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    ];
    for (const path of candidates) {
      if (path && existsSync(path)) return path;
    }
    return null;
  }

  async cuaDriverDaemonRunning(): Promise<boolean> {
    const path = this.cuaDriverPath();
    if (!path) return false;
    const proc = Bun.spawn([path, "status"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  }

  async screenRecordingGranted(): Promise<boolean> {
    const path = this.cuaDriverPath();
    if (!path) return false;
    const proc = Bun.spawn([path, "check_permissions"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return false;
    // cua-driver check_permissions output formats observed:
    //   "✅ Screen Recording: granted."           (CLI human-readable, current)
    //   "❌ Screen Recording: NOT granted"        (negative case)
    //   '"screen_recording": true'                (JSON-ish, older versions)
    // Find the screen-recording line and verify it says granted but not
    // "not granted". Match both snake_case and title-case naming.
    const srLine = out
      .split("\n")
      .find((l) => /screen[\s_]?recording/i.test(l));
    if (!srLine) return false;
    if (/not\s+granted/i.test(srLine)) return false;
    return /(:\s*true\b|granted)/i.test(srLine);
  }

  recorderBinaryExists(): boolean {
    return existsSync(resolveRecorderBinary());
  }

  async recorderHasAccessibility(): Promise<boolean> {
    const bin = resolveRecorderBinary();
    if (!existsSync(bin)) return false;
    const proc = Bun.spawn([bin, "--check-accessibility"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  }

  anthropicApiKeySet(): boolean {
    return !!Bun.env.ANTHROPIC_API_KEY;
  }
}

const CUA_INSTALL_HINT =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"';
const CUA_DAEMON_HINT = "open -n -g -a CuaDriver --args serve";
const CUA_DAEMON_AUTOFIX_HINT =
  "or run `showme doctor --fix` to start it for you";
const SR_HINT =
  "Run `cua-driver check_permissions`. If Screen Recording is missing, grant it in System Settings → Privacy & Security → Screen Recording for the CuaDriver app, then restart the daemon.";
const RECORDER_BUILD_HINT =
  "cd recorder && swift build -c release  # builds ./.build/release/showme-recorder";
const ACCESSIBILITY_HINT =
  "Open System Settings → Privacy & Security → Accessibility → click + → add the recorder binary at the path above. Then re-run `showme doctor`. (Each rebuild changes the binary's cdhash, so the grant must be re-added after rebuilds.)";
const API_KEY_HINT =
  "export ANTHROPIC_API_KEY=sk-ant-...  # add to your shell rc to persist";

export async function runDoctor(probe: SystemProbe): Promise<DoctorReport> {
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
          fixHint: `Start it: ${CUA_DAEMON_HINT} (${CUA_DAEMON_AUTOFIX_HINT})`,
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

  const ax = recBin ? await probe.recorderHasAccessibility() : false;
  results.push(
    ax
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

  const apiKey = probe.anthropicApiKeySet();
  results.push(
    apiKey
      ? { name: "ANTHROPIC_API_KEY", status: "ok", detail: "set in env" }
      : {
          name: "ANTHROPIC_API_KEY",
          status: "fail",
          detail: "unset",
          fixHint: API_KEY_HINT,
        },
  );

  return { results, allOk: results.every((r) => r.status === "ok") };
}

/**
 * Attempts to launch the CuaDriver daemon via `open -n -g -a CuaDriver --args
 * serve`, then polls the probe until it reports the daemon as running or a
 * deadline elapses. Side-effecty by design — kept out of `runDoctor` so the
 * report builder stays pure.
 *
 * Returns:
 *   started: true  → polling observed daemon transition to running
 *   started: false → daemon was already running (no-op), or polling timed out,
 *                    or the spawn failed (e.g. `open` not on PATH)
 * `message` is a one-liner suitable for printing to the user.
 */
export async function tryAutoStartDaemon(
  probe: SystemProbe,
): Promise<{ started: boolean; message: string }> {
  // Don't double-start.
  if (await probe.cuaDriverDaemonRunning()) {
    return { started: false, message: "[doctor] daemon already running" };
  }

  // `open` exits immediately while the daemon launches in the background, so
  // fire-and-forget. If `open` itself isn't available (extremely rare on
  // macOS), fall back to telling the user.
  try {
    Bun.spawn(["open", "-n", "-g", "-a", "CuaDriver", "--args", "serve"], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (e) {
    return {
      started: false,
      message: `[doctor] could not invoke 'open' (${(e as Error).message}). Run \`${CUA_DAEMON_HINT}\` manually.`,
    };
  }

  console.log("[doctor] starting cua-driver daemon...");

  const deadline = Date.now() + 5000;
  const pollMs = 250;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (await probe.cuaDriverDaemonRunning()) {
      return { started: true, message: "[doctor] daemon up" };
    }
  }

  return {
    started: false,
    message: `[doctor] daemon did not come up within 5s. It may still be launching — re-run \`showme doctor\` in a moment, or start it manually with \`${CUA_DAEMON_HINT}\`.`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("Welcome to showme.");
  lines.push("");
  lines.push("Prerequisites:");
  for (const r of report.results) {
    const mark = r.status === "ok" ? "✓" : "✗";
    const padded = r.name.padEnd(36);
    lines.push(`  ${mark} ${padded}${r.detail}`);
    if (r.status === "fail" && r.fixHint) {
      lines.push(`       → ${r.fixHint}`);
    }
  }
  lines.push("");
  if (report.allOk) {
    lines.push("All set. Try:");
    lines.push(
      "  showme record my-first-skill 'describe what you're about to do'",
    );
  } else {
    const failed = report.results.filter((r) => r.status === "fail").length;
    lines.push(
      `Fix the ${failed} issue(s) above, then re-run \`showme doctor\`.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
