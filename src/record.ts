import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolveRecorderBinary, resolveSkillTrajectoryPath } from "./paths.ts";

export interface RecordOptions {
  skillName: string;
  description: string;
}

export async function recordCommand(opts: RecordOptions): Promise<void> {
  const dir = resolveSkillTrajectoryPath(opts.skillName);
  mkdirSync(dir, { recursive: true });

  const binary = resolveRecorderBinary();
  if (!existsSync(binary)) {
    throw new Error(
      `recorder binary not found at ${binary}\nBuild it first: cd recorder && swift build -c release`,
    );
  }

  console.log(
    "[showme] this recording will capture screenshots of your screen.",
  );
  console.log("[showme] close anything sensitive. Starting in 3...");
  await sleep(1000);
  console.log("2...");
  await sleep(1000);
  console.log("1...");
  await sleep(1000);

  const proc = spawn(
    binary,
    [
      "--output",
      dir,
      "--task",
      opts.skillName,
      "--description",
      opts.description,
    ],
    { stdio: "inherit" },
  );

  await new Promise<void>((resolve, reject) => {
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`recorder exited with code ${code}`));
    });
  });

  console.log(`[showme] trajectory written to ${dir}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
