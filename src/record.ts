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
      `recorder binary not found at ${binary}\nBuild it first: cd mac-app && swift build -c release`,
    );
  }

  console.log(
    "[openclick] this recording will capture screenshots of your screen.",
  );
  console.log("[openclick] close anything sensitive. Starting in 3...");
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

  await waitForRecorderExit(proc);

  console.log(`[openclick] trajectory written to ${dir}`);
}

export async function waitForRecorderExit(
  proc: RecorderProcessLike,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    proc.once("error", (error) => reject(error));
    proc.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (signal) {
        reject(new Error(`recorder exited via signal ${signal}`));
        return;
      }
      reject(new Error(`recorder exited with code ${code ?? "unknown"}`));
    });
  });
}

interface RecorderProcessLike {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
