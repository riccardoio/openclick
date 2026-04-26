import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAppMemoryFact,
  exportMemoryBundle,
  importMemoryBundle,
  listAppMemories,
  renderRelevantMemoriesForPrompt,
  writeMemoryBundle,
} from "../src/memory.ts";

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "showme-memory-"));
  originalHome = Bun.env.SHOWME_HOME;
  Bun.env.SHOWME_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) Bun.env.SHOWME_HOME = undefined;
  else Bun.env.SHOWME_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("app memory", () => {
  test("stores and renders relevant app affordances", () => {
    addAppMemoryFact({
      bundleId: "com.example.App",
      appName: "Example",
      kind: "affordance",
      description: "Press n to create a new document.",
      confidence: 0.8,
      evidence: ["verified once"],
    });

    const rendered = renderRelevantMemoriesForPrompt([
      { name: "Example", bundleId: "com.example.App" },
    ]);
    expect(rendered).toContain("Memory for Example");
    expect(rendered).toContain("Press n to create a new document.");
  });

  test("exports and imports a shareable memory bundle", () => {
    addAppMemoryFact({
      bundleId: "com.example.App",
      appName: "Example",
      kind: "avoid",
      description: "Avoid tiny menu-bar windows.",
      confidence: 0.9,
    });
    const path = join(home, "bundle.json");
    const exported = writeMemoryBundle(path);
    expect(exported.memories).toHaveLength(1);

    rmSync(join(home, "apps"), { recursive: true, force: true });
    expect(listAppMemories()).toHaveLength(0);

    const imported = importMemoryBundle(path);
    expect(imported.memories).toHaveLength(1);
    const bundle = exportMemoryBundle();
    expect(bundle.memories[0]?.avoid[0]?.description).toContain("menu-bar");
    expect(bundle.memories[0]?.avoid[0]?.status).toBe("candidate");
    expect(bundle.memories[0]?.avoid[0]?.source).toBe("imported");
  });

  test("does not retrieve one-off negative memories until locally promoted", () => {
    addAppMemoryFact({
      bundleId: "com.example.App",
      appName: "Example",
      kind: "avoid",
      description: "Avoid raw drags for clock hour marks.",
      confidence: 0.9,
    });
    expect(
      renderRelevantMemoriesForPrompt([
        { name: "Example", bundleId: "com.example.App" },
      ]),
    ).toBeNull();

    addAppMemoryFact({
      bundleId: "com.example.App",
      appName: "Example",
      kind: "avoid",
      description: "Avoid raw drags for clock hour marks.",
      confidence: 0.9,
    });
    const rendered = renderRelevantMemoriesForPrompt([
      { name: "Example", bundleId: "com.example.App" },
    ]);
    expect(rendered).toContain("caution");
    expect(rendered).toContain("Avoid raw drags");
  });
});
