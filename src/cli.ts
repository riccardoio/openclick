const VERSION = "0.0.1";

const USAGE = `Usage: showme <command> [options]

Commands:
  record <task-name>     Record a task by demonstration
  compile <skill-name>   Compile a recording into a SKILL.md
  run <skill-name>       Run a compiled skill (default: --dry-run)

Options:
  --help, -h             Show this help
  --version, -v          Show version
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
    case "record": {
      const skillName = args[1];
      if (!skillName) throw new Error("record requires <skill-name>");
      const description = args.slice(2).join(" ") || skillName;
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
        maxSteps,
      });
      return;
    }
    default:
      throw new Error(`unknown subcommand: ${cmd}`);
  }
}
