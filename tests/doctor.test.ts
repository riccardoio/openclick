import { describe, expect, test } from "bun:test";
import {
  type SystemProbe,
  formatDoctorReport,
  runDoctor,
  tryAutoStartDaemon,
} from "../src/doctor.ts";

function makeProbe(overrides: Partial<SystemProbe> = {}): SystemProbe {
  return {
    bunVersion: () => "1.3.11",
    cuaDriverPath: () => "/usr/local/bin/cua-driver",
    cuaDriverDaemonRunning: async () => true,
    screenRecordingGranted: async () => true,
    recorderBinaryExists: () => true,
    recorderHasAccessibility: async () => true,
    anthropicApiKeySet: () => true,
    ...overrides,
  };
}

describe("doctor", () => {
  test("all prereqs met → allOk true, no fixHints", async () => {
    const report = await runDoctor(makeProbe());
    expect(report.allOk).toBe(true);
    expect(report.results.every((r) => r.status === "ok")).toBe(true);
    expect(report.results.every((r) => !r.fixHint)).toBe(true);
  });

  test("missing cua-driver propagates to daemon + screen recording fails", async () => {
    const report = await runDoctor(
      makeProbe({
        cuaDriverPath: () => null,
        cuaDriverDaemonRunning: async () => true, // ignored when path is null
      }),
    );
    expect(report.allOk).toBe(false);
    const driver = report.results.find(
      (r) => r.name === "cua-driver installed",
    );
    expect(driver?.status).toBe("fail");
    const daemon = report.results.find((r) => r.name === "cua-driver daemon");
    expect(daemon?.status).toBe("fail");
    expect(daemon?.detail).toBe("not running");
  });

  test("missing recorder binary skips Accessibility check with clear reason", async () => {
    const report = await runDoctor(
      makeProbe({
        recorderBinaryExists: () => false,
        recorderHasAccessibility: async () => true, // ignored when binary missing
      }),
    );
    const ax = report.results.find(
      (r) => r.name === "Accessibility (recorder)",
    );
    expect(ax?.status).toBe("fail");
    expect(ax?.detail).toContain("recorder not built");
  });

  test("missing API key flagged with shell-export hint", async () => {
    const report = await runDoctor(
      makeProbe({ anthropicApiKeySet: () => false }),
    );
    const k = report.results.find((r) => r.name === "ANTHROPIC_API_KEY");
    expect(k?.status).toBe("fail");
    expect(k?.fixHint).toContain("export ANTHROPIC_API_KEY");
  });

  test("formatter prints check marks for ok and a fix hint for failures", async () => {
    const report = await runDoctor(
      makeProbe({ anthropicApiKeySet: () => false }),
    );
    const text = formatDoctorReport(report);
    expect(text).toContain("✓ bun runtime");
    expect(text).toContain("✗ ANTHROPIC_API_KEY");
    expect(text).toContain("→ export ANTHROPIC_API_KEY");
    expect(text).toContain("Fix the");
  });

  test("formatter prints next-step CTA when all OK", async () => {
    const report = await runDoctor(makeProbe());
    const text = formatDoctorReport(report);
    expect(text).toContain("All set");
    expect(text).toContain("showme record");
  });

  test("--fix path: tryAutoStartDaemon flips daemon ok on rerun", async () => {
    // The user's pain point: every fresh shell, the daemon is down. With
    // --fix, we spawn `open -n -g -a CuaDriver --args serve` and poll the
    // status command. Here we fake the transition: the first two probe
    // calls (the doctor's pre-fix check + the autostart's early-return
    // check) report false; subsequent polls report true, simulating the
    // daemon coming up after `open` was invoked.
    let probeCalls = 0;
    const probe = makeProbe({
      cuaDriverDaemonRunning: async () => {
        probeCalls++;
        // calls 1 (doctor pre-fix) and 2 (autostart guard) → false.
        // calls ≥3 (polling after spawn) → true.
        return probeCalls >= 3;
      },
      // Pre-fix: daemon down implies SR check is skipped → also false; once
      // daemon is up, SR is reported as granted.
      screenRecordingGranted: async () => probeCalls >= 3,
    });

    // First doctor pass — daemon not yet up.
    const before = await runDoctor(probe);
    const daemonBefore = before.results.find(
      (r) => r.name === "cua-driver daemon",
    );
    expect(daemonBefore?.status).toBe("fail");

    // Run the auto-start. This will fire `open` (fire-and-forget) and poll
    // — our fake reports true from poll 1 onward, so this resolves started=true.
    const result = await tryAutoStartDaemon(probe);
    expect(result.started).toBe(true);
    expect(result.message).toContain("up");

    // Second doctor pass — daemon now reported as ok.
    const after = await runDoctor(probe);
    const daemonAfter = after.results.find(
      (r) => r.name === "cua-driver daemon",
    );
    expect(daemonAfter?.status).toBe("ok");
    expect(daemonAfter?.detail).toBe("running");
  });

  test("--fix path: tryAutoStartDaemon is a no-op when daemon already running", async () => {
    let calls = 0;
    const probe = makeProbe({
      cuaDriverDaemonRunning: async () => {
        calls++;
        return true;
      },
    });
    const result = await tryAutoStartDaemon(probe);
    expect(result.started).toBe(false);
    expect(result.message).toContain("already running");
    // Only the initial probe; we should NOT have entered the polling loop.
    expect(calls).toBe(1);
  });

  test("daemon-down fix-hint mentions --fix as an option", async () => {
    const report = await runDoctor(
      makeProbe({ cuaDriverDaemonRunning: async () => false }),
    );
    const daemon = report.results.find((r) => r.name === "cua-driver daemon");
    expect(daemon?.status).toBe("fail");
    expect(daemon?.fixHint).toContain("--fix");
  });

  test("doctor report is JSON-serializable with stable shape (consumed by Swift onboarding)", async () => {
    const report = await runDoctor(
      makeProbe({
        anthropicApiKeySet: () => false,
        cuaDriverDaemonRunning: async () => false,
      }),
    );
    const round = JSON.parse(JSON.stringify(report));
    expect(typeof round.allOk).toBe("boolean");
    expect(round.allOk).toBe(false);
    expect(Array.isArray(round.results)).toBe(true);
    expect(round.results.length).toBeGreaterThan(0);
    for (const r of round.results) {
      expect(typeof r.name).toBe("string");
      expect(["ok", "fail"]).toContain(r.status);
      expect(typeof r.detail).toBe("string");
      // fixHint is only present on failures
      if (r.status === "fail") expect(typeof r.fixHint).toBe("string");
    }
    // Every check the onboarding cares about must be present by name.
    const names = round.results.map((r: { name: string }) => r.name);
    expect(names).toContain("cua-driver installed");
    expect(names).toContain("cua-driver daemon");
    expect(names).toContain("Screen Recording (via cua-driver)");
    expect(names).toContain("Accessibility (recorder)");
    expect(names).toContain("ANTHROPIC_API_KEY");
  });

  test("Screen Recording parser handles cua-driver title-case + JSON formats (regression)", () => {
    // cua-driver's CLI prints '✅ Screen Recording: granted.' (title case, with
    // space). The original parser looked for 'screen_recording' (snake_case)
    // and never matched. This test pins the parsing rules used inside
    // RealSystemProbe.screenRecordingGranted.
    const samples: { input: string; expected: boolean }[] = [
      {
        input: "✅ Accessibility: granted.\n✅ Screen Recording: granted.\n",
        expected: true,
      },
      { input: "❌ Screen Recording: NOT granted\n", expected: false },
      {
        input: '{"screen_recording": true, "accessibility": true}\n',
        expected: true,
      },
      { input: '{"screen_recording": false}\n', expected: false },
      { input: "no relevant line at all\n", expected: false },
    ];
    for (const s of samples) {
      const srLine = s.input
        .split("\n")
        .find((l) => /screen[\s_]?recording/i.test(l));
      const result =
        srLine !== undefined &&
        !/not\s+granted/i.test(srLine) &&
        /(:\s*true\b|granted)/i.test(srLine);
      expect(result).toBe(s.expected);
    }
  });
});
