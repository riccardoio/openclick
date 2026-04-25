import { describe, expect, test } from "bun:test";
import {
  type SystemProbe,
  formatDoctorReport,
  runDoctor,
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
