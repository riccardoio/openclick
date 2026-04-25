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
    case "compile":
    case "run":
      console.log(`(${cmd} not implemented yet)`);
      return;
    default:
      throw new Error(`unknown subcommand: ${cmd}`);
  }
}
