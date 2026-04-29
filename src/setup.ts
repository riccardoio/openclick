import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  Badge,
  Box,
  Spinner,
  colorize,
  fg,
  input,
  style,
  select as tuiSelect,
} from "@vr_patel/tui";
import {
  type CheckResult,
  type DoctorReport,
  RealSystemProbe,
  formatDoctorReport,
  runDoctor,
  tryAutoStartDaemon,
  watchDoctor,
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
  select<T extends string>(
    question: string,
    options: SetupSelectOption<T>[],
    defaultValue?: T,
  ): Promise<T>;
}

export interface SetupSelectOption<T extends string> {
  label: string;
  value: T;
  description?: string;
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
  io.write(renderSetupWelcome());

  const provider = await chooseProvider(opts, io);
  setModelProvider(provider);
  io.write(
    `${Badge.success("SET")} ${colorize("Model provider", fg.gray)} ${provider}`,
  );

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
      if (isInteractiveTerminal()) {
        return (
          await input({
            message: question.replace(/:\s*$/, ""),
            placeholder: "Type a value",
          })
        ).trim();
      }
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
    async select(question, options, defaultValue) {
      return await selectOption(question, options, defaultValue);
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
  return await io.select<ModelProvider>(
    "Choose a model provider",
    [
      {
        label: "Anthropic",
        value: "anthropic",
        description: "Claude models for planning and vision.",
      },
      {
        label: "OpenAI",
        value: "openai",
        description: "GPT models for planning and vision.",
      },
    ],
    current,
  );
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
  const setup = await io.select<"recommended" | "custom">(
    "Choose model setup",
    [
      {
        label: `Recommended defaults (${currentPlanner})`,
        value: "recommended",
        description: "Use OpenClick's default model for this provider.",
      },
      {
        label: "Custom model",
        value: "custom",
        description: "Use one model for planner, verifier, and result output.",
      },
    ],
    "recommended",
  );
  if (setup === "recommended") {
    io.write(`Model: ${currentPlanner} (default)`);
    return false;
  }
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
    const action = await io.select<"keep" | "replace">(
      "API key already exists",
      [
        {
          label: "Keep current key",
          value: "keep",
          description: "Leave the existing key unchanged.",
        },
        {
          label: "Replace key",
          value: "replace",
          description: "Paste a new key for this provider.",
        },
      ],
      "keep",
    );
    if (action === "keep") return true;
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
  const spinner = isInteractiveTerminal()
    ? new Spinner({
        text: "Checking macOS permissions and local helpers",
        style: "dots",
        color: fg.cyan,
      }).start()
    : null;
  const probe = new RealSystemProbe();
  let report = await runDoctor(probe);
  const daemon = report.results.find((r) => r.name === "cua-driver daemon");
  if (daemon?.status === "fail") {
    spinner?.update("Starting the local CuaDriver helper");
    const started = await tryAutoStartDaemon(probe);
    if (!spinner) io.write(started.message);
    report = await runDoctor(probe);
  }
  if (report.allOk) spinner?.stop("macOS checks passed");
  else spinner?.warn("macOS still needs a few permissions");
  io.write(formatDoctorReport(report));
  if (!report.allOk && process.stdin.isTTY && process.stdout.isTTY) {
    io.write(
      "Keeping this status live while you grant permissions. Press Ctrl-C to stop.",
    );
    report = await watchDoctor(probe);
  }
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
  if (isInteractiveTerminal()) {
    return (
      await input({
        message: question.replace(/:\s*$/, ""),
        placeholder: "Paste your API key",
        mask: "*",
        validate: (value) => value.trim().length > 0 || "API key is required",
      })
    ).trim();
  }
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

async function selectOption<T extends string>(
  question: string,
  options: SetupSelectOption<T>[],
  defaultValue?: T,
): Promise<T> {
  if (options.length === 0) throw new Error("select requires options");
  const defaultIndex = Math.max(
    0,
    options.findIndex((option) => option.value === defaultValue),
  );
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    !process.stdin.setRawMode
  ) {
    return await selectOptionFallback(question, options, defaultIndex);
  }

  return await tuiSelect<T>({
    message: question,
    options,
    initialIndex: defaultIndex,
    pointer: "❯",
    activeColor: fg.cyan,
  });
}

async function selectOptionFallback<T extends string>(
  question: string,
  options: SetupSelectOption<T>[],
  defaultIndex: number,
): Promise<T> {
  console.log(`${question}:`);
  for (const [index, option] of options.entries()) {
    const detail = option.description ? ` - ${option.description}` : "";
    console.log(`  ${index + 1}. ${option.label}${detail}`);
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question(`Select [${defaultIndex + 1}]: `)).trim();
    if (!answer) return optionAt(options, defaultIndex).value;
    const selectedNumber = Number.parseInt(answer, 10);
    if (
      Number.isInteger(selectedNumber) &&
      selectedNumber >= 1 &&
      selectedNumber <= options.length
    ) {
      return optionAt(options, selectedNumber - 1).value;
    }
    const selected = options.find(
      (option) =>
        option.value.toLowerCase() === answer.toLowerCase() ||
        option.label.toLowerCase() === answer.toLowerCase(),
    );
    if (selected) return selected.value;
    throw new Error(`invalid selection: ${answer}`);
  } finally {
    rl.close();
  }
}

function optionAt<T extends string>(
  options: SetupSelectOption<T>[],
  index: number,
): SetupSelectOption<T> {
  const option = options[index];
  if (!option) throw new Error(`invalid selection index: ${index}`);
  return option;
}

function isInteractiveTerminal(): boolean {
  return Boolean(
    process.stdin.isTTY && process.stdout.isTTY && process.stdin.setRawMode,
  );
}

function renderSetupWelcome(): string {
  const box = new Box({
    title: "OpenClick setup",
    borderStyle: "round",
    borderColor: fg.cyan,
    titleColor: fg.cyan,
    paddingX: 1,
    paddingY: 1,
    dimBorder: true,
  });
  return `\n${box.render(
    [
      `${Badge.info("CLI")} ${colorize("Configure OpenClick in a few steps.", fg.white, style.bold)}`,
      colorize(
        "Choose a model, save your API key, and verify macOS permissions.",
        fg.gray,
      ),
    ].join("\n"),
  )}\n`;
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
