import type { InterventionReason } from "./trace.ts";
import { VERSION } from "./version.ts";

const USAGE = `Usage: open42 <command> [options]

Commands:
  doctor [--fix] [--json]              Check prereqs (cua-driver, perms, API key).
                                       Auto-starts the helper if it is down.
                                       --fix is kept as a compatibility alias.
                                       --json prints a structured report to stdout
                                       (status messages go to stderr).
  run <task> [--live] [--cursor]       Complete a macOS task from your prompt
                                       (default: dry-run: plans but does not act).
                                       --cursor shows the agent cursor moving on
                                       screen while it works.
                                       --criteria adds explicit success criteria
                                       for verifier feedback/retry rounds.
                                       --max-steps, --max-batches,
                                       --max-model-calls, --max-screenshots
                                       bound live execution.
                                       --no-memory disables app-memory retrieval.
                                       --no-learn disables writing new memories.
                                       --allow-foreground permits tools that may
                                       steal focus, move cursor, or touch global state.
                                       --agent uses the legacy Agent SDK path.
                                       Plans cheap small batches, executes via
                                       cua-driver, then screenshots/replans.
  cancel <run-id>                      Request cancellation for a running task.
  takeover finish --run-id <id>        Mark a manual takeover finished for
                                       the paused runner.
  record <task-name>                   Legacy: record a task by demonstration
  compile <skill-name>                 Legacy: compile a recording into SKILL.md
  memory list                          List learned local app memories
  memory export <file>                 Export memories to a shareable JSON bundle
  memory import <file>                 Import a shared memory JSON bundle
  memory learn-takeover ...            Save a user-takeover learning directly
  settings provider status|set <name>  Show or change model provider
                                       (anthropic|openai).
  settings model status|set <role> <model>
                                       Show or set role-specific model
                                       (planner|verifier|result|compile).
  settings api-key status|set|clear    Manage the Anthropic API key.
  settings anthropic-api-key status|set|clear
                                       Manage the Anthropic API key explicitly.
  settings openai-api-key status|set|clear
                                       Manage the OpenAI API key.
  server [--host 127.0.0.1] [--port 4242] [--token <token>]
                                       Start the local HTTP API server.
  mcp                                  Start the open42 MCP stdio server.
  daemon install [--host 127.0.0.1] [--port 4242] [--token <token>]
                                       Install the local API server as a
                                       launchd user daemon.
  daemon status                        Show launchd daemon install/load state.
  daemon uninstall                     Remove the launchd user daemon.

Options:
  --help, -h             Show this help
  --version, -v          Show version

First run? Try \`open42 doctor\` — it walks you through what to install/grant.
`;

export async function main(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    return;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(`open42 ${VERSION}`);
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
      const json = args.includes("--json");

      let report = await runDoctor(probe);

      const driverInstalled = report.results.some(
        (r) => r.name === "cua-driver installed" && r.status === "ok",
      );
      if (driverInstalled) {
        const daemon = report.results.find(
          (r) => r.name === "cua-driver daemon",
        );
        if (daemon?.status === "fail") {
          const result = await tryAutoStartDaemon(probe);
          // Status messages on stderr so `--json` stdout stays parseable.
          console.error(result.message);
          report = await runDoctor(probe);
        }
      }

      if (json) {
        console.log(JSON.stringify(report));
      } else {
        console.log(formatDoctorReport(report));
      }
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
      const report = await runDoctor(new RealSystemProbe(), {
        includeRecorder: true,
      });
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
          "[open42] proceeding without ANTHROPIC_API_KEY (only needed for compile/run).",
        );
      }

      const { recordCommand } = await import("./record.ts");
      await recordCommand({ skillName, description });
      return;
    }
    case "compile": {
      const skillName = args[1];
      if (!skillName) throw new Error("compile requires <skill-name>");
      const { compileSkillMd, RoutedClaudeClient } = await import(
        "./compile.ts"
      );
      const { resolveSkillTrajectoryPath } = await import("./paths.ts");
      const result = await compileSkillMd({
        trajectoryDir: resolveSkillTrajectoryPath(skillName),
        skillName,
        claudeClient: new RoutedClaudeClient(),
      });
      console.log(`[open42] wrote ${result.outputPath}`);
      if (!result.valid) {
        console.error(
          `[open42] WARNING: SKILL.md failed validation: ${result.errors.join(", ")}`,
        );
        process.exitCode = 2;
      }
      return;
    }
    case "memory": {
      const action = args[1];
      const {
        listAppMemories,
        writeMemoryBundle,
        importMemoryBundle,
        recordTakeoverLearning,
      } = await import("./memory.ts");
      if (action === "list") {
        const memories = listAppMemories();
        if (memories.length === 0) {
          console.log("[open42] no app memories yet.");
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
          `[open42] exported ${bundle.memories.length} app memory file(s) to ${path}`,
        );
        return;
      }
      if (action === "import") {
        const path = args[2];
        if (!path) throw new Error("memory import requires <file>");
        const bundle = importMemoryBundle(path);
        console.log(
          `[open42] imported ${bundle.memories.length} app memory file(s) from ${path}`,
        );
        return;
      }
      if (action === "learn-takeover") {
        const bundleId = parseRequiredStringOption(args, "--bundle-id");
        const issue = parseRequiredStringOption(args, "--issue");
        const summary = parseRequiredStringOption(args, "--summary");
        const appName = parseOptionalStringOption(args, "--app-name");
        const task = parseOptionalStringOption(args, "--task");
        const memory = recordTakeoverLearning({
          bundleId,
          appName,
          task,
          issue,
          summary,
        });
        console.log(
          `[open42] saved takeover learning for ${memory.app_name ?? memory.bundle_id}`,
        );
        return;
      }
      throw new Error(
        "memory requires one of: list, export <file>, import <file>, learn-takeover --bundle-id <id> --issue <text> --summary <text>",
      );
    }
    case "settings": {
      const area = args[1];
      const action = args[2];
      const {
        apiKeyStatus,
        clearProviderApiKey,
        resolveModelProvider,
        readSettings,
        saveProviderApiKey,
        setModelName,
        setModelProvider,
      } = await import("./settings.ts");
      if (area === "provider") {
        if (action === "status") {
          console.log(`[open42] model provider: ${resolveModelProvider()}`);
          return;
        }
        if (action === "set") {
          const provider = parseModelProviderArg(args[3]);
          setModelProvider(provider);
          console.log(`[open42] model provider set to ${provider}.`);
          return;
        }
        throw new Error("settings provider requires: status|set <provider>");
      }
      if (area === "model") {
        if (action === "status") {
          const models = readSettings().models ?? {};
          console.log(
            `[open42] models: planner=${models.planner ?? "(default)"} verifier=${models.verifier ?? "(default)"} result=${models.result ?? "(default)"} compile=${models.compile ?? "(default)"}`,
          );
          return;
        }
        if (action === "set") {
          const role = parseModelRoleArg(args[3]);
          const model = args[4];
          if (!model) throw new Error("settings model set requires <model>");
          setModelName(role, model);
          console.log(`[open42] ${role} model set to ${model}.`);
          return;
        }
        throw new Error("settings model requires: status|set <role> <model>");
      }
      const provider =
        area === "api-key"
          ? "anthropic"
          : area === "anthropic-api-key"
            ? "anthropic"
            : area === "openai-api-key"
              ? "openai"
              : null;
      if (!provider) {
        throw new Error(
          "settings requires: provider, model, api-key, anthropic-api-key, or openai-api-key",
        );
      }
      if (action === "status") {
        const status = apiKeyStatus(provider);
        if (status.available) {
          console.log(
            `[open42] ${provider} API key configured via ${status.source}: ${status.masked}`,
          );
        } else {
          console.log(`[open42] ${provider} API key is not configured.`);
        }
        return;
      }
      if (action === "set") {
        const value = args[3];
        if (!value) throw new Error(`settings ${area} set requires <key>`);
        const result = saveProviderApiKey(provider, value);
        console.log(`[open42] ${provider} API key saved to ${result.storage}.`);
        return;
      }
      if (action === "clear") {
        clearProviderApiKey(provider);
        console.log(`[open42] saved ${provider} API key cleared.`);
        return;
      }
      throw new Error(`settings ${area} requires: status|set|clear`);
    }
    case "server": {
      const { startApiServer } = await import("./server.ts");
      await startApiServer({
        host: parseOptionalStringOption(args, "--host"),
        port: parseOptionalPortOption(args, "--port"),
        token: parseOptionalStringOption(args, "--token"),
      });
      return;
    }
    case "mcp": {
      const { startMcpServer } = await import("./server.ts");
      await startMcpServer();
      return;
    }
    case "daemon": {
      const action = args[1];
      const {
        daemonStatus,
        installDaemon,
        uninstallDaemon,
        DEFAULT_DAEMON_PORT,
      } = await import("./daemon.ts");
      if (action === "install") {
        const path = installDaemon({
          host: parseOptionalStringOption(args, "--host"),
          port: parseOptionalPortOption(args, "--port") ?? DEFAULT_DAEMON_PORT,
          token: parseOptionalStringOption(args, "--token"),
        });
        console.log(`[open42] daemon installed: ${path}`);
        return;
      }
      if (action === "uninstall") {
        uninstallDaemon();
        console.log("[open42] daemon uninstalled.");
        return;
      }
      if (action === "status") {
        const status = daemonStatus();
        console.log(
          `[open42] daemon ${status.installed ? "installed" : "not installed"}; ${status.loaded ? "loaded" : "not loaded"} (${status.path})`,
        );
        return;
      }
      throw new Error("daemon requires: install|uninstall|status");
    }
    case "takeover": {
      const action = args[1];
      if (action === "finish") {
        const runId = parseRequiredStringOption(args, "--run-id");
        const issue = parseRequiredStringOption(args, "--issue");
        const summary = parseRequiredStringOption(args, "--summary");
        const outcome = parseOutcomeOption(args, "--outcome");
        const bundleId = parseOptionalStringOption(args, "--bundle-id");
        const appName = parseOptionalStringOption(args, "--app-name");
        const task = parseOptionalStringOption(args, "--task");
        const reasonType = parseInterventionReasonOption(args, "--reason-type");
        const feedback = parseOptionalStringOption(args, "--feedback");
        const trajectoryPath = parseOptionalStringOption(
          args,
          "--trajectory-path",
        );
        const { writeRunTakeoverResume } = await import("./trace.ts");
        writeRunTakeoverResume({
          schema_version: 1,
          run_id: runId,
          outcome,
          issue,
          summary,
          reason_type: reasonType,
          feedback,
          trajectory_path: trajectoryPath,
          bundle_id: bundleId,
          app_name: appName,
          task,
          created_at: new Date().toISOString(),
        });
        console.log(
          `[open42] takeover ${outcome} marker saved for run ${runId}`,
        );
        return;
      }
      throw new Error(
        "takeover requires: finish --run-id <id> --issue <text> --summary <text> [--outcome success|failed|cancelled]",
      );
    }
    case "cancel": {
      const runId = args[1];
      if (!runId) throw new Error("cancel requires <run-id>");
      const { requestRunCancel } = await import("./trace.ts");
      requestRunCancel(runId);
      console.log(`[open42] cancellation requested for ${runId}`);
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
          "[open42] WARNING: --agent uses the legacy higher-cost Agent SDK path and does not support the prompt-first verifier loop. Prefer the default fast path.",
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

function parseOptionalStringOption(
  args: string[],
  flag: string,
): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseRequiredStringOption(args: string[], flag: string): string {
  const value = parseOptionalStringOption(args, flag);
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseModelProviderArg(
  value: string | undefined,
): "anthropic" | "openai" {
  if (value === "anthropic" || value === "openai") return value;
  throw new Error("provider must be one of: anthropic, openai");
}

function parseModelRoleArg(
  value: string | undefined,
): "planner" | "verifier" | "result" | "compile" {
  if (
    value === "planner" ||
    value === "verifier" ||
    value === "result" ||
    value === "compile"
  ) {
    return value;
  }
  throw new Error(
    "model role must be one of: planner, verifier, result, compile",
  );
}

function parseOptionalPortOption(
  args: string[],
  flag: string,
): number | undefined {
  const value = parseOptionalStringOption(args, flag);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${flag} requires a valid TCP port`);
  }
  return parsed;
}

function parseOutcomeOption(
  args: string[],
  flag: string,
): "success" | "failed" | "cancelled" {
  const value = parseOptionalStringOption(args, flag) ?? "success";
  if (value === "success" || value === "failed" || value === "cancelled") {
    return value;
  }
  throw new Error(`${flag} must be one of: success, failed, cancelled`);
}

function parseInterventionReasonOption(
  args: string[],
  flag: string,
): InterventionReason | undefined {
  const value = parseOptionalStringOption(args, flag);
  if (!value) return undefined;
  const values: InterventionReason[] = [
    "planner_blocked",
    "needs_clarification",
    "foreground_required",
    "repeated_action_failure",
    "verification_failed",
    "permission_prompt",
    "confirmation_dialog",
    "login_or_2fa",
    "captcha",
    "native_modal",
    "low_confidence",
    "unexpected_screen_change",
    "destructive_action_risk",
    "user_requested_takeover",
  ];
  if (values.includes(value as InterventionReason))
    return value as InterventionReason;
  throw new Error(`${flag} must be a known intervention reason`);
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
