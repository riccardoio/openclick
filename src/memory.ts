import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveAppMemoryPath, resolveAppMemoryRoot } from "./paths.ts";

export interface AppMemoryFact {
  id: string;
  description: string;
  confidence: number;
  status: "candidate" | "active" | "retired";
  source: "local" | "imported";
  evidence_count: number;
  scope?: string;
  cause?: string;
  evidence?: string[];
  updated_at: string;
}

export interface AppMemory {
  schema_version: 1;
  bundle_id: string;
  app_name?: string;
  affordances: AppMemoryFact[];
  avoid: AppMemoryFact[];
  observations: AppMemoryFact[];
  updated_at: string;
}

export interface MemoryCandidateApp {
  name: string;
  bundleId: string;
  pid?: number;
}

export interface MemoryBundle {
  schema_version: 1;
  exported_at: string;
  memories: AppMemory[];
}

export type MemoryKind = "affordance" | "avoid" | "observation";

export function emptyAppMemory(bundleId: string, appName?: string): AppMemory {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    bundle_id: bundleId,
    app_name: appName,
    affordances: [],
    avoid: [],
    observations: [],
    updated_at: now,
  };
}

export function loadAppMemory(
  bundleId: string,
  appName?: string,
): AppMemory | null {
  const path = resolveAppMemoryPath(bundleId);
  if (!existsSync(path)) return null;
  try {
    return normalizeMemory(JSON.parse(readFileSync(path, "utf8")), appName);
  } catch {
    return null;
  }
}

export function saveAppMemory(memory: AppMemory): void {
  const path = resolveAppMemoryPath(memory.bundle_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(memory, null, 2)}\n`);
}

export function addAppMemoryFact(args: {
  bundleId: string;
  appName?: string;
  kind: MemoryKind;
  description: string;
  confidence?: number;
  status?: AppMemoryFact["status"];
  source?: AppMemoryFact["source"];
  scope?: string;
  cause?: string;
  evidence?: string[];
}): AppMemory {
  const memory =
    loadAppMemory(args.bundleId, args.appName) ??
    emptyAppMemory(args.bundleId, args.appName);
  const fact = normalizeFact({
    id: factId(args.kind, args.description),
    description: args.description,
    confidence: args.confidence ?? 0.5,
    status: args.status ?? defaultStatus(args.kind),
    source: args.source ?? "local",
    evidence_count: 1,
    scope: args.scope,
    cause: args.cause,
    evidence: args.evidence,
    updated_at: new Date().toISOString(),
  });
  if (!fact) return memory;
  const bucket = bucketFor(memory, args.kind);
  const existing = bucket.find((item) => item.id === fact.id);
  if (existing) {
    existing.evidence_count += 1;
    existing.confidence = Math.max(existing.confidence, fact.confidence);
    existing.updated_at = fact.updated_at;
    existing.source = existing.source === "local" ? "local" : fact.source;
    existing.scope = existing.scope ?? fact.scope;
    existing.cause = existing.cause ?? fact.cause;
    existing.evidence = mergeStrings(existing.evidence, fact.evidence).slice(
      -5,
    );
    maybePromoteFact(args.kind, existing);
  } else {
    maybePromoteFact(args.kind, fact);
    bucket.push(fact);
  }
  memory.app_name = args.appName ?? memory.app_name;
  memory.updated_at = fact.updated_at;
  trimMemory(memory);
  saveAppMemory(memory);
  return memory;
}

export function listAppMemories(): AppMemory[] {
  const root = resolveAppMemoryRoot();
  if (!existsSync(root)) return [];
  const memories: AppMemory[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "memory.json");
    if (!existsSync(path)) continue;
    try {
      const memory = normalizeMemory(JSON.parse(readFileSync(path, "utf8")));
      if (memory) memories.push(memory);
    } catch {
      // Ignore corrupt local memories; a future repair command can surface them.
    }
  }
  return memories.sort((a, b) => a.bundle_id.localeCompare(b.bundle_id));
}

export function exportMemoryBundle(): MemoryBundle {
  return {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    memories: listAppMemories(),
  };
}

export function writeMemoryBundle(path: string): MemoryBundle {
  const bundle = exportMemoryBundle();
  writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`);
  return bundle;
}

export function importMemoryBundle(path: string): MemoryBundle {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const bundle = normalizeBundle(raw);
  for (const incoming of bundle.memories) {
    const downgraded = downgradeImportedMemory(incoming);
    const existing =
      loadAppMemory(downgraded.bundle_id, downgraded.app_name) ??
      emptyAppMemory(downgraded.bundle_id, downgraded.app_name);
    const merged: AppMemory = {
      ...existing,
      app_name: existing.app_name ?? downgraded.app_name,
      affordances: mergeFacts(existing.affordances, downgraded.affordances),
      avoid: mergeFacts(existing.avoid, downgraded.avoid),
      observations: mergeFacts(existing.observations, downgraded.observations),
      updated_at: new Date().toISOString(),
    };
    trimMemory(merged);
    saveAppMemory(merged);
  }
  return bundle;
}

export function renderRelevantMemoriesForPrompt(
  candidates: MemoryCandidateApp[],
): string | null {
  const sections: string[] = [];
  for (const app of candidates.slice(0, 8)) {
    const memory = loadAppMemory(app.bundleId, app.name);
    if (!memory) continue;
    const lines: string[] = [];
    for (const fact of topFacts(memory.affordances, 5)) {
      lines.push(
        `  affordance (${fact.confidence.toFixed(2)}, ${fact.scope ?? "general"}): ${fact.description}`,
      );
    }
    for (const fact of topFacts(memory.avoid, 5)) {
      lines.push(
        `  caution (${fact.confidence.toFixed(2)}, ${fact.scope ?? "general"}): ${fact.description}`,
      );
    }
    for (const fact of topFacts(memory.observations, 3)) {
      lines.push(
        `  observation (${fact.confidence.toFixed(2)}): ${fact.description}`,
      );
    }
    if (lines.length === 0) continue;
    sections.push(
      `Memory for ${memory.app_name ?? app.name} [${memory.bundle_id}]:`,
      ...lines,
    );
  }
  if (sections.length === 0) return null;
  return [
    "Relevant local app memories. These are soft hints, not hard rules. Cautions should change strategy probabilities, not disable capabilities:",
    ...sections,
  ].join("\n");
}

function normalizeBundle(value: unknown): MemoryBundle {
  if (!value || typeof value !== "object")
    throw new Error("memory bundle must be an object");
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.memories))
    throw new Error("memory bundle missing memories array");
  return {
    schema_version: 1,
    exported_at:
      typeof obj.exported_at === "string"
        ? obj.exported_at
        : new Date().toISOString(),
    memories: obj.memories
      .map((memory) => normalizeMemory(memory))
      .filter((memory): memory is AppMemory => memory !== null),
  };
}

function normalizeMemory(value: unknown, appName?: string): AppMemory | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.bundle_id !== "string" || obj.bundle_id.length === 0)
    return null;
  return {
    schema_version: 1,
    bundle_id: obj.bundle_id,
    app_name:
      typeof obj.app_name === "string" && obj.app_name.length > 0
        ? obj.app_name
        : appName,
    affordances: factArray(obj.affordances),
    avoid: factArray(obj.avoid),
    observations: factArray(obj.observations),
    updated_at:
      typeof obj.updated_at === "string"
        ? obj.updated_at
        : new Date().toISOString(),
  };
}

function factArray(value: unknown): AppMemoryFact[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeFact)
    .filter((fact): fact is AppMemoryFact => !!fact);
}

function normalizeFact(value: unknown): AppMemoryFact | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.description !== "string" ||
    obj.description.trim().length === 0
  )
    return null;
  const description = obj.description.trim();
  const confidence =
    typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
      ? Math.max(0, Math.min(1, obj.confidence))
      : 0.5;
  return {
    id:
      typeof obj.id === "string" && obj.id.length > 0
        ? obj.id
        : factId("observation", description),
    description,
    confidence,
    status:
      obj.status === "active" || obj.status === "retired"
        ? obj.status
        : "candidate",
    source: obj.source === "imported" ? "imported" : "local",
    evidence_count:
      typeof obj.evidence_count === "number" &&
      Number.isFinite(obj.evidence_count)
        ? Math.max(0, Math.round(obj.evidence_count))
        : 1,
    scope: typeof obj.scope === "string" ? obj.scope : undefined,
    cause: typeof obj.cause === "string" ? obj.cause : undefined,
    evidence: Array.isArray(obj.evidence)
      ? obj.evidence.filter((item): item is string => typeof item === "string")
      : undefined,
    updated_at:
      typeof obj.updated_at === "string"
        ? obj.updated_at
        : new Date().toISOString(),
  };
}

function bucketFor(memory: AppMemory, kind: MemoryKind): AppMemoryFact[] {
  if (kind === "affordance") return memory.affordances;
  if (kind === "avoid") return memory.avoid;
  return memory.observations;
}

function mergeFacts(
  existing: AppMemoryFact[],
  incoming: AppMemoryFact[],
): AppMemoryFact[] {
  const byId = new Map<string, AppMemoryFact>();
  for (const fact of [...existing, ...incoming]) {
    const current = byId.get(fact.id);
    if (!current) {
      byId.set(fact.id, { ...fact, evidence: fact.evidence?.slice() });
      continue;
    }
    current.confidence = Math.max(current.confidence, fact.confidence);
    current.status = strongerStatus(current.status, fact.status);
    current.source = current.source === "local" ? "local" : fact.source;
    current.evidence_count += fact.evidence_count;
    current.scope = current.scope ?? fact.scope;
    current.cause = current.cause ?? fact.cause;
    current.updated_at =
      current.updated_at > fact.updated_at
        ? current.updated_at
        : fact.updated_at;
    current.evidence = mergeStrings(current.evidence, fact.evidence).slice(-5);
  }
  return [...byId.values()].sort(sortFacts);
}

function trimMemory(memory: AppMemory): void {
  memory.affordances = memory.affordances.sort(sortFacts).slice(0, 50);
  memory.avoid = memory.avoid.sort(sortFacts).slice(0, 50);
  memory.observations = memory.observations.sort(sortFacts).slice(0, 80);
}

function topFacts(facts: AppMemoryFact[], count: number): AppMemoryFact[] {
  return facts
    .filter((fact) => fact.status === "active")
    .sort(sortFacts)
    .slice(0, count);
}

function sortFacts(a: AppMemoryFact, b: AppMemoryFact): number {
  return (
    b.confidence - a.confidence || b.updated_at.localeCompare(a.updated_at)
  );
}

function mergeStrings(a: string[] = [], b: string[] = []): string[] {
  return [...new Set([...a, ...b])];
}

function factId(kind: MemoryKind, description: string): string {
  return `${kind}-${String(Bun.hash(description.toLowerCase().trim()))}`;
}

function defaultStatus(kind: MemoryKind): AppMemoryFact["status"] {
  return kind === "avoid" ? "candidate" : "active";
}

function maybePromoteFact(kind: MemoryKind, fact: AppMemoryFact): void {
  if (fact.status === "retired") return;
  if (kind !== "avoid") {
    if (fact.source === "local") fact.status = "active";
    return;
  }
  if (
    fact.source === "local" &&
    fact.evidence_count >= 2 &&
    fact.confidence >= 0.65
  ) {
    fact.status = "active";
  }
}

function strongerStatus(
  a: AppMemoryFact["status"],
  b: AppMemoryFact["status"],
): AppMemoryFact["status"] {
  const rank = { retired: 0, candidate: 1, active: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function downgradeImportedMemory(memory: AppMemory): AppMemory {
  const downgrade = (fact: AppMemoryFact): AppMemoryFact => ({
    ...fact,
    source: "imported",
    status: "candidate",
    confidence: Math.min(fact.confidence, 0.55),
  });
  return {
    ...memory,
    affordances: memory.affordances.map(downgrade),
    avoid: memory.avoid.map(downgrade),
    observations: memory.observations.map(downgrade),
  };
}
