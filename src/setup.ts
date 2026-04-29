import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  type CheckResult,
  type DoctorReport,
  RealSystemProbe,
  formatDoctorReport,
  runDoctor,
  tryAutoStartDaemon,
} from "./doctor.ts";
import {
  type ModelProvider,
  apiKeyStatus,
  maskApiKey,
  readSettings,
  resolveModelName,
  resolveModelProvider,
  saveProviderApiKey,
  setModelName,
  setModelProvider,
} from "./settings.ts";

export interface SetupOptions {
  provider?: ModelProvider;
  apiKey?: string;
  model?: string;
  yes?: boolean;
  skipDoctor?: boolean;
}

export interface SetupIO {
  write(line: string): void;
  prompt(question: string): Promise<string>;
  secret(question: string): Promise<string>;
}

export interface SetupResult {
  provider: ModelProvider;
  apiKeyConfigured: boolean;
  modelConfigured: boolean;
  doctor?: DoctorReport;
}

export async function runSetup(
  opts: SetupOptions = {},
  io: SetupIO = defaultSetupIO(),
): Promise<SetupResult> {
  io.write("");
  io.write("Welcome to OpenClick setup.");
  io.write(
    "This will configure your model provider, API key, and macOS checks.",
  );
  io.write("");

  const provider = await chooseProvider(opts, io);
  setModelProvider(provider);
  io.write(`Model provider: ${provider}`);

  const modelConfigured = await configureModel(provider, opts, io);
  const apiKeyConfigured = await configureApiKey(provider, opts, io);

  let doctor: DoctorReport | undefined;
  if (!opts.skipDoctor) {
    doctor = await runSetupDoctor(io);
  } else {
    io.write("Skipped doctor checks.");
  }

  io.write("");
  if (!doctor || doctor.allOk) {
    io.write("Setup complete.");
    io.write(
      'Try: openclick run "open Calculator and calculate 17 times 23" --live',
    );
  } else {
    io.write(
      "Setup saved your model settings, but macOS still needs attention.",
    );
    printPermissionSummary(doctor.results, io);
    io.write("After making changes, run: openclick setup");
  }
  io.write("");

  return { provider, apiKeyConfigured, modelConfigured, doctor };
}

function defaultSetupIO(): SetupIO {
  return {
    write(line) {
      console.log(line);
    },
    async prompt(question) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    },
    async secret(question) {
      return await promptSecret(question);
    },
  };
}

async function chooseProvider(
  opts: SetupOptions,
  io: SetupIO,
): Promise<ModelProvider> {
  if (opts.provider) return opts.provider;
  const current = resolveModelProvider();
  if (opts.yes) return current;
  io.write("Choose a model provider:");
  io.write("  1. Anthropic");
  io.write("  2. OpenAI");
  const answer = await io.prompt(`Provider [${current}]: `);
  if (!answer) return current;
  if (answer === "1" || /^anthropic$/i.test(answer)) return "anthropic";
  if (answer === "2" || /^openai$/i.test(answer)) return "openai";
  throw new Error("provider must be anthropic or openai");
}

async function configureModel(
  provider: ModelProvider,
  opts: SetupOptions,
  io: SetupIO,
): Promise<boolean> {
  const currentPlanner = resolveModelName("planner", provider);
  if (opts.model?.trim()) {
    saveSingleModelForCoreRoles(opts.model.trim());
    io.write(`Model: ${opts.model.trim()}`);
    return true;
  }
  if (opts.yes) {
    io.write(`Model: ${currentPlanner} (default)`);
    return false;
  }

  io.write("");
  io.write("Choose model setup:");
  io.write(`  1. Recommended defaults (${currentPlanner})`);
  io.write("  2. Custom model for planner/verifier/result");
  const answer = await io.prompt("Model setup [1]: ");
  if (!answer || answer === "1") {
    io.write(`Model: ${currentPlanner} (default)`);
    return false;
  }
  if (answer !== "2") throw new Error("model setup must be 1 or 2");
  const model = await io.prompt("Model name: ");
  if (!model.trim()) throw new Error("model cannot be empty");
  saveSingleModelForCoreRoles(model.trim());
  io.write(`Model: ${model.trim()}`);
  return true;
}

async function configureApiKey(
  provider: ModelProvider,
  opts: SetupOptions,
  io: SetupIO,
): Promise<boolean> {
  const status = apiKeyStatus(provider);
  if (opts.apiKey?.trim()) {
    const saved = saveProviderApiKey(provider, opts.apiKey);
    io.write(
      `${provider} API key saved to ${saved.storage}: ${maskApiKey(opts.apiKey)}`,
    );
    return true;
  }

  if (status.available && !opts.yes) {
    io.write("");
    io.write(
      `${provider} API key already configured via ${status.source}: ${status.masked}`,
    );
    const answer = await io.prompt("Replace it? [y/N]: ");
    if (!/^y(es)?$/i.test(answer)) return true;
  } else if (status.available) {
    io.write(
      `${provider} API key already configured via ${status.source}: ${status.masked}`,
    );
    return true;
  }

  const envName =
    provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  io.write("");
  const key = await io.secret(`${envName}: `);
  if (!key.trim()) {
    throw new Error(`${envName} is required to complete setup`);
  }
  const saved = saveProviderApiKey(provider, key);
  io.write(`${provider} API key saved to ${saved.storage}: ${maskApiKey(key)}`);
  return true;
}

async function runSetupDoctor(io: SetupIO): Promise<DoctorReport> {
  io.write("");
  io.write("Checking macOS permissions and local helpers...");
  const probe = new RealSystemProbe();
  let report = await runDoctor(probe);
  const daemon = report.results.find((r) => r.name === "cua-driver daemon");
  if (daemon?.status === "fail") {
    const started = await tryAutoStartDaemon(probe);
    io.write(started.message);
    report = await runDoctor(probe);
  }
  io.write(formatDoctorReport(report));
  return report;
}

function printPermissionSummary(results: CheckResult[], io: SetupIO): void {
  for (const result of results) {
    if (result.status === "ok") continue;
    io.write(`- ${result.name}: ${result.detail}`);
    if (result.fixHint) io.write(`  ${result.fixHint}`);
  }
}

function saveSingleModelForCoreRoles(model: string): void {
  setModelName("planner", model);
  setModelName("verifier", model);
  setModelName("result", model);
}

async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }
  process.stdout.write(question);
  spawnSync("/bin/stty", ["-echo"], { stdio: "inherit" });
  try {
    const line = await new Promise<string>((resolve) => {
      process.stdin.once("data", (data) => {
        resolve(data.toString().trim());
      });
    });
    process.stdout.write("\n");
    return line;
  } finally {
    spawnSync("/bin/stty", ["echo"], { stdio: "inherit" });
  }
}

export function setupSummary(): string {
  const settings = readSettings();
  const provider = resolveModelProvider();
  const status = apiKeyStatus(provider);
  return [
    `provider=${provider}`,
    `api_key=${status.available ? `${status.source}:${status.masked}` : "missing"}`,
    `planner=${settings.models?.planner ?? resolveModelName("planner", provider)}`,
  ].join(" ");
}
