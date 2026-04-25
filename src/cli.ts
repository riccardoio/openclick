const VERSION = "0.0.1";

const USAGE = `Usage: showme <command> [options]

Commands:
  doctor [--fix]                       Check prereqs (cua-driver, perms, API key).
                                       --fix auto-starts the daemon if down.
  record <task-name>                   Record a task by demonstration
  compile <skill-name>                 Compile a recording into a SKILL.md
  run <skill-name> [--live] [--cursor] Run a compiled skill (default: --dry-run).
                                       --cursor shows the agent cursor moving on
                                       screen while it works.

Options:
  --help, -h             Show this help
  --version, -v          Show version

First run? Try \`showme doctor\` — it walks you through what to install/grant.
`;

export async function main(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    return;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(`showme ${VERSION}`);
    return;
  }
  const cmd = args[0];
  switch (cmd) {
    case "doctor": {
      const {
        runDoctor,
        formatDoctorReport,
        RealSystemProbe,
        tryAutoStartDaemon,
      } = await import("./doctor.ts");
      const probe = new RealSystemProbe();
      const fix = args.includes("--fix");

      let report = await runDoctor(probe);

      if (fix) {
        const daemon = report.results.find(
          (r) => r.name === "cua-driver daemon",
        );
        if (daemon?.status === "fail") {
          const result = await tryAutoStartDaemon(probe);
          console.log(result.message);
          // Re-run the full doctor checks so the user sees the post-fix state
          // (Screen Recording, etc., depend on daemonRunning).
          report = await runDoctor(probe);
        }
      }

      console.log(formatDoctorReport(report));
      if (!report.allOk) process.exitCode = 1;
      return;
    }
    case "record": {
      const skillName = args[1];
      if (!skillName) throw new Error("record requires <skill-name>");
      const description = args.slice(2).join(" ") || skillName;

      // Auto-run prerequisites check before the recorder spawns. If anything
      // critical is missing (cua-driver path, daemon, Accessibility, recorder
      // binary) print the doctor report and stop.
      const { runDoctor, formatDoctorReport, RealSystemProbe } = await import(
        "./doctor.ts"
      );
      const report = await runDoctor(new RealSystemProbe());
      if (!report.allOk) {
        console.log(formatDoctorReport(report));
        // ANTHROPIC_API_KEY isn't needed for `record`, only `compile`/`run`.
        // If that's the only failing check, allow record to proceed.
        const blocking = report.results.filter(
          (r) => r.status === "fail" && r.name !== "ANTHROPIC_API_KEY",
        );
        if (blocking.length > 0) {
          process.exitCode = 1;
          return;
        }
        console.log(
          "[showme] proceeding without ANTHROPIC_API_KEY (only needed for compile/run).",
        );
      }

      const { recordCommand } = await import("./record.ts");
      await recordCommand({ skillName, description });
      return;
    }
    case "compile": {
      const skillName = args[1];
      if (!skillName) throw new Error("compile requires <skill-name>");
      const { compileSkillMd, AnthropicClaudeClient } = await import(
        "./compile.ts"
      );
      const { resolveSkillTrajectoryPath } = await import("./paths.ts");
      const result = await compileSkillMd({
        trajectoryDir: resolveSkillTrajectoryPath(skillName),
        skillName,
        claudeClient: new AnthropicClaudeClient(),
      });
      console.log(`[showme] wrote ${result.outputPath}`);
      if (!result.valid) {
        console.error(
          `[showme] WARNING: SKILL.md failed validation: ${result.errors.join(", ")}`,
        );
        process.exitCode = 2;
      }
      return;
    }
    case "run": {
      const skillName = args[1];
      if (!skillName) throw new Error("run requires <skill-name>");
      const live = args.includes("--live");
      const confirm = args.includes("--confirm");
      const cursor = args.includes("--cursor");
      const maxStepsIdx = args.indexOf("--max-steps");
      const maxSteps = maxStepsIdx >= 0 ? Number(args[maxStepsIdx + 1]) : 50;
      const userPromptIdx = args.indexOf("--prompt");
      const userPrompt =
        userPromptIdx >= 0
          ? (args[userPromptIdx + 1] ?? "now do the task")
          : "now do the task";

      const { runSkill } = await import("./run.ts");
      const { resolveSkillRoot } = await import("./paths.ts");
      await runSkill({
        skillRoot: resolveSkillRoot(skillName),
        userPrompt,
        live,
        confirm,
        cursor,
        maxSteps,
      });
      return;
    }
    default:
      throw new Error(`unknown subcommand: ${cmd}`);
  }
}
