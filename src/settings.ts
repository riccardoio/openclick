import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveOpen42Home } from "./paths.ts";

const KEYCHAIN_SERVICE = "dev.open42.anthropic";
const KEYCHAIN_ACCOUNT = "ANTHROPIC_API_KEY";

export type ModelProvider = "anthropic" | "openai";
export type ModelRole = "planner" | "verifier" | "result" | "compile";

export interface Open42Settings {
  provider?: ModelProvider;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  models?: Partial<Record<ModelRole, string>>;
}

export function resolveSettingsPath(): string {
  return join(resolveOpen42Home(), "settings.json");
}

export function readSettings(): Open42Settings {
  const path = resolveSettingsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const provider = parseModelProvider(parsed.provider);
    const anthropicApiKey =
      typeof parsed.anthropicApiKey === "string"
        ? parsed.anthropicApiKey
        : undefined;
    const openaiApiKey =
      typeof parsed.openaiApiKey === "string" ? parsed.openaiApiKey : undefined;
    const models =
      parsed.models && typeof parsed.models === "object"
        ? parseModelRoleMap(parsed.models as Record<string, unknown>)
        : undefined;
    return { provider, anthropicApiKey, openaiApiKey, models };
  } catch {
    return {};
  }
}

export function writeSettings(settings: Open42Settings): void {
  const path = resolveSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function resolveApiKey(): string {
  return resolveProviderApiKey("anthropic");
}

export function resolveProviderApiKey(provider: ModelProvider): string {
  const envKey = envApiKey(provider);
  if (envKey.trim()) return envKey.trim();
  const keychainKey = readMacKeychainApiKey(provider);
  if (keychainKey.trim()) return keychainKey.trim();
  const settings = readSettings();
  const settingsKey = settingsApiKey(settings, provider).trim();
  if (settingsKey) return settingsKey;
  return "";
}

export function apiKeyStatus(provider: ModelProvider = "anthropic"): {
  available: boolean;
  source: "env" | "keychain" | "settings" | "missing";
  masked: string;
} {
  const envKey = envApiKey(provider);
  if (envKey.trim()) {
    return {
      available: true,
      source: "env",
      masked: maskApiKey(envKey),
    };
  }
  const keychainKey = readMacKeychainApiKey(provider);
  if (keychainKey.trim()) {
    return {
      available: true,
      source: "keychain",
      masked: maskApiKey(keychainKey),
    };
  }
  const settingsKey = settingsApiKey(readSettings(), provider);
  if (settingsKey.trim()) {
    return {
      available: true,
      source: "settings",
      masked: maskApiKey(settingsKey),
    };
  }
  return { available: false, source: "missing", masked: "" };
}

export function maskApiKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return "*".repeat(Math.max(12, Math.min(32, trimmed.length)));
}

export function saveApiKey(value: string): {
  storage: "keychain" | "settings";
} {
  return saveProviderApiKey("anthropic", value);
}

export function saveProviderApiKey(
  provider: ModelProvider,
  value: string,
): {
  storage: "keychain" | "settings";
} {
  const key = value.trim();
  if (!key) throw new Error("API key cannot be empty");
  if (writeMacKeychainApiKey(provider, key)) {
    removeSettingsApiKey(provider);
    return { storage: "keychain" };
  }
  const settings = readSettings();
  if (provider === "anthropic") settings.anthropicApiKey = key;
  else settings.openaiApiKey = key;
  writeSettings(settings);
  return { storage: "settings" };
}

export function clearApiKey(): void {
  clearProviderApiKey("anthropic");
}

export function clearProviderApiKey(provider: ModelProvider): void {
  deleteMacKeychainApiKey(provider);
  removeSettingsApiKey(provider);
}

export function resolveModelProvider(): ModelProvider {
  const envProvider = parseModelProvider(Bun.env.OPEN42_MODEL_PROVIDER);
  if (envProvider) return envProvider;
  return readSettings().provider ?? "anthropic";
}

export function setModelProvider(provider: ModelProvider): void {
  const settings = readSettings();
  settings.provider = provider;
  writeSettings(settings);
}

export function resolveModelName(
  role: ModelRole,
  provider: ModelProvider = resolveModelProvider(),
): string {
  const envRole = role.toUpperCase();
  const explicit =
    Bun.env[`OPEN42_${envRole}_MODEL`] ??
    Bun.env[`OPEN42_${provider.toUpperCase()}_${envRole}_MODEL`];
  if (explicit?.trim()) return explicit.trim();
  const saved = readSettings().models?.[role];
  if (saved?.trim()) return saved.trim();
  if (provider === "openai") {
    return role === "compile"
      ? (Bun.env.OPEN42_OPENAI_MODEL ?? "gpt-4.1")
      : (Bun.env.OPEN42_OPENAI_MODEL ?? "gpt-4.1");
  }
  if (role === "compile")
    return Bun.env.OPEN42_COMPILE_MODEL ?? "claude-opus-4-7";
  if (role === "verifier") {
    return (
      Bun.env.OPEN42_VERIFIER_MODEL ??
      Bun.env.OPEN42_PLANNER_MODEL ??
      "claude-sonnet-4-6"
    );
  }
  return Bun.env.OPEN42_PLANNER_MODEL ?? "claude-sonnet-4-6";
}

export function setModelName(role: ModelRole, model: string): void {
  const trimmed = model.trim();
  if (!trimmed) throw new Error("model cannot be empty");
  const settings = readSettings();
  settings.models = { ...(settings.models ?? {}), [role]: trimmed };
  writeSettings(settings);
}

function removeSettingsApiKey(provider: ModelProvider): void {
  const path = resolveSettingsPath();
  const settings = readSettings();
  if (provider === "anthropic") settings.anthropicApiKey = undefined;
  else settings.openaiApiKey = undefined;
  const compact: Open42Settings = {
    ...(settings.provider ? { provider: settings.provider } : {}),
    ...(settings.anthropicApiKey
      ? { anthropicApiKey: settings.anthropicApiKey }
      : {}),
    ...(settings.openaiApiKey ? { openaiApiKey: settings.openaiApiKey } : {}),
    ...(settings.models && Object.keys(settings.models).length > 0
      ? { models: settings.models }
      : {}),
  };
  if (Object.keys(compact).length === 0) rmSync(path, { force: true });
  else writeSettings(compact);
}

function keychainEnabled(): boolean {
  return (
    process.platform === "darwin" && Bun.env.OPEN42_DISABLE_KEYCHAIN !== "1"
  );
}

function readMacKeychainApiKey(provider: ModelProvider): string {
  if (!keychainEnabled()) return "";
  const service = keychainService(provider);
  const account = keychainAccount(provider);
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", service, "-a", account, "-w"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function writeMacKeychainApiKey(
  provider: ModelProvider,
  value: string,
): boolean {
  if (!keychainEnabled()) return false;
  const service = keychainService(provider);
  const account = keychainAccount(provider);
  const result = spawnSync(
    "/usr/bin/security",
    ["add-generic-password", "-U", "-s", service, "-a", account, "-w", value],
    { encoding: "utf8" },
  );
  return result.status === 0;
}

function deleteMacKeychainApiKey(provider: ModelProvider): void {
  if (!keychainEnabled()) return;
  const service = keychainService(provider);
  const account = keychainAccount(provider);
  spawnSync(
    "/usr/bin/security",
    ["delete-generic-password", "-s", service, "-a", account],
    { encoding: "utf8" },
  );
}

function keychainService(provider: ModelProvider): string {
  if (provider === "anthropic") return KEYCHAIN_SERVICE;
  return `dev.open42.${provider}`;
}

function keychainAccount(provider: ModelProvider): string {
  if (provider === "anthropic") return KEYCHAIN_ACCOUNT;
  return `${provider.toUpperCase()}_API_KEY`;
}

function envApiKey(provider: ModelProvider): string {
  if (provider === "openai") return Bun.env.OPENAI_API_KEY ?? "";
  return Bun.env.OPEN42_API_KEY ?? Bun.env.ANTHROPIC_API_KEY ?? "";
}

function settingsApiKey(
  settings: Open42Settings,
  provider: ModelProvider,
): string {
  return provider === "openai"
    ? (settings.openaiApiKey ?? "")
    : (settings.anthropicApiKey ?? "");
}

function parseModelProvider(value: unknown): ModelProvider | undefined {
  if (value === "anthropic" || value === "openai") return value;
  return undefined;
}

function parseModelRoleMap(
  value: Record<string, unknown>,
): Partial<Record<ModelRole, string>> {
  const models: Partial<Record<ModelRole, string>> = {};
  for (const role of ["planner", "verifier", "result", "compile"] as const) {
    if (typeof value[role] === "string" && value[role].trim()) {
      models[role] = value[role].trim();
    }
  }
  return models;
}
