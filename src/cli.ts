const VERSION = "0.1.0";

const USAGE = `Usage: showme <command> [options]

Commands:
  doctor [--fix]                       Check prereqs (cua-driver, perms, API key).
                                       --fix auto-starts the daemon if down.
  run <task> [--live] [--cursor]       Complete a macOS task from your prompt
                                       (default: dry-run: plans but does not act).
                                       --cursor shows the agent cursor moving on
                                       screen while it works.
                                       --criteria adds explicit success criteria
                                       for verifier feedback/retry rounds.
                                       --no-memory disables app-memory retrieval.
                                       --no-learn disables writing new memories.
                                       --allow-foreground permits tools that may
                                       steal focus, move cursor, or touch global state.
                                       Plans cheap small batches, executes via
                                       cua-driver, then screenshots/replans.
  bar [--detach]                       Launch the native macOS menu-bar prompt.
  cancel <run-id>                      Request cancellation for a running task.
  record <task-name>                   Legacy: record a task by demonstration
  compile <skill-name>                 Legacy: compile a recording into SKILL.md
  memory list                          List learned local app memories
  memory export <file>                 Export memories to a shareable JSON bundle
  memory import <file>                 Import a shared memory JSON bundle

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
    case "memory": {
      const action = args[1];
      const { listAppMemories, writeMemoryBundle, importMemoryBundle } =
        await import("./memory.ts");
      if (action === "list") {
        const memories = listAppMemories();
        if (memories.length === 0) {
          console.log("[showme] no app memories yet.");
          return;
        }
        for (const memory of memories) {
          console.log(
            `${memory.app_name ?? memory.bundle_id} [${memory.bundle_id}] affordances=${memory.affordances.length} avoid=${memory.avoid.length} observations=${memory.observations.length}`,
          );
        }
        return;
      }
      if (action === "export") {
        const path = args[2];
        if (!path) throw new Error("memory export requires <file>");
        const bundle = writeMemoryBundle(path);
        console.log(
          `[showme] exported ${bundle.memories.length} app memory file(s) to ${path}`,
        );
        return;
      }
      if (action === "import") {
        const path = args[2];
        if (!path) throw new Error("memory import requires <file>");
        const bundle = importMemoryBundle(path);
        console.log(
          `[showme] imported ${bundle.memories.length} app memory file(s) from ${path}`,
        );
        return;
      }
      throw new Error(
        "memory requires one of: list, export <file>, import <file>",
      );
    }
    case "bar": {
      const { launchChatBar } = await import("./bar.ts");
      await launchChatBar({ detach: args.includes("--detach") });
      return;
    }
    case "cancel": {
      const runId = args[1];
      if (!runId) throw new Error("cancel requires <run-id>");
      const { requestRunCancel } = await import("./trace.ts");
      requestRunCancel(runId);
      console.log(`[showme] cancellation requested for ${runId}`);
      return;
    }
    case "run": {
      const runArgs = args
        .slice(1)
        .filter(
          (arg, index, all) =>
            arg !== "--live" &&
            arg !== "--confirm" &&
            arg !== "--cursor" &&
            arg !== "--fast" &&
            arg !== "--agent" &&
            arg !== "--max-steps" &&
            arg !== "--max-batches" &&
            arg !== "--max-model-calls" &&
            arg !== "--max-screenshots" &&
            arg !== "--criteria" &&
            arg !== "--no-memory" &&
            arg !== "--no-learn" &&
            arg !== "--allow-foreground" &&
            all[index - 1] !== "--max-steps" &&
            all[index - 1] !== "--max-batches" &&
            all[index - 1] !== "--max-model-calls" &&
            all[index - 1] !== "--max-screenshots" &&
            all[index - 1] !== "--criteria",
        );
      const taskPrompt = runArgs.join(" ").trim();
      if (!taskPrompt) throw new Error("run requires <task>");
      const live = args.includes("--live");
      const confirm = args.includes("--confirm");
      const cursor = args.includes("--cursor");
      const fast = !args.includes("--agent");
      const memory = !args.includes("--no-memory");
      const learn = !args.includes("--no-learn");
      const allowForeground = args.includes("--allow-foreground");
      if (!fast) {
        console.warn(
          "[showme] WARNING: --agent uses the legacy higher-cost Agent SDK path and does not support the prompt-first verifier loop. Prefer the default fast path.",
        );
      }
      const maxStepsIdx = args.indexOf("--max-steps");
      const maxBatchesIdx = args.indexOf("--max-batches");
      const maxModelCallsIdx = args.indexOf("--max-model-calls");
      const maxScreenshotsIdx = args.indexOf("--max-screenshots");
      const criteriaIdx = args.indexOf("--criteria");
      const maxSteps = parsePositiveIntFlag(
        args,
        maxStepsIdx,
        "--max-steps",
        50,
      );
      const maxBatches = parsePositiveIntFlag(
        args,
        maxBatchesIdx,
        "--max-batches",
        6,
      );
      const maxModelCalls = parsePositiveIntFlag(
        args,
        maxModelCallsIdx,
        "--max-model-calls",
        12,
      );
      const maxScreenshots = parsePositiveIntFlag(
        args,
        maxScreenshotsIdx,
        "--max-screenshots",
        8,
      );
      const criteria = parseOptionalStringFlag(args, criteriaIdx, "--criteria");
      const { runTask } = await import("./run.ts");
      await runTask({
        taskPrompt,
        criteria,
        live,
        confirm,
        cursor,
        fast,
        maxSteps,
        maxBatches,
        maxModelCalls,
        maxScreenshots,
        memory,
        learn,
        allowForeground,
      });
      return;
    }
    default:
      throw new Error(`unknown subcommand: ${cmd}`);
  }
}

function parseOptionalStringFlag(
  args: string[],
  index: number,
  flag: string,
): string | undefined {
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveIntFlag(
  args: string[],
  index: number,
  flag: string,
  fallback: number,
): number {
  const parsed = index >= 0 ? Number(args[index + 1]) : fallback;
  if (!Number.isInteger(parsed) || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}
