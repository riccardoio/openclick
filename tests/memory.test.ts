import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAppMemoryFact,
  exportMemoryBundle,
  importMemoryBundle,
  listAppMemories,
  recordTakeoverLearning,
  renderRelevantMemoriesForPrompt,
  writeMemoryBundle,
} from "../src/memory.ts";

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "openclick-memory-"));
  originalHome = Bun.env.OPENCLICK_HOME;
  Bun.env.OPENCLICK_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) Bun.env.OPENCLICK_HOME = undefined;
  else Bun.env.OPENCLICK_HOME = originalHome;
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

  test("merges repeated facts incrementally instead of replacing the lesson", () => {
    addAppMemoryFact({
      bundleId: "com.example.App",
      appName: "Example",
      kind: "affordance",
      description: "Click Continue after the Gmail confirmation prompt.",
      confidence: 0.61,
      evidence: ["first takeover"],
    });
    addAppMemoryFact({
      bundleId: "com.example.App",
      appName: "Example",
      kind: "affordance",
      description: "Click Continue after the Gmail confirmation prompt.",
      confidence: 0.9,
      evidence: ["second takeover"],
    });

    const memory = exportMemoryBundle().memories[0];
    const fact = memory?.affordances[0];
    expect(memory?.affordances).toHaveLength(1);
    expect(fact?.description).toBe(
      "Click Continue after the Gmail confirmation prompt.",
    );
    expect(fact?.evidence_count).toBe(2);
    expect(fact?.confidence).toBe(0.9);
    expect(fact?.evidence).toContain("first takeover");
    expect(fact?.evidence).toContain("second takeover");
  });

  test("keeps distinct lessons side by side for the same app", () => {
    addAppMemoryFact({
      bundleId: "com.example.App",
      appName: "Example",
      kind: "affordance",
      description: "Use Cmd-L before entering Gmail URLs.",
      confidence: 0.7,
    });
    addAppMemoryFact({
      bundleId: "com.example.App",
      appName: "Example",
      kind: "affordance",
      description: "Open the unread filter before selecting the latest email.",
      confidence: 0.72,
    });

    const descriptions =
      exportMemoryBundle().memories[0]?.affordances.map(
        (fact) => fact.description,
      ) ?? [];
    expect(descriptions).toContain("Use Cmd-L before entering Gmail URLs.");
    expect(descriptions).toContain(
      "Open the unread filter before selecting the latest email.",
    );
  });

  test("retains stored lessons beyond the prompt-rendering budget", () => {
    for (let i = 0; i < 55; i++) {
      addAppMemoryFact({
        bundleId: "com.example.App",
        appName: "Example",
        kind: "affordance",
        description: `Long-term lesson ${i}`,
        confidence: 0.6,
      });
    }

    const memory = exportMemoryBundle().memories[0];
    expect(memory?.affordances).toHaveLength(55);

    const rendered = renderRelevantMemoriesForPrompt([
      { name: "Example", bundleId: "com.example.App" },
    ]);
    expect(rendered?.match(/Long-term lesson/g)).toHaveLength(5);
  });

  test("imports merge with existing local lessons instead of replacing them", () => {
    addAppMemoryFact({
      bundleId: "com.example.App",
      appName: "Example",
      kind: "affordance",
      description: "Local lesson remains available.",
      confidence: 0.8,
    });

    const otherHome = mkdtempSync(join(tmpdir(), "openclick-memory-import-"));
    try {
      const original = Bun.env.OPENCLICK_HOME;
      Bun.env.OPENCLICK_HOME = otherHome;
      addAppMemoryFact({
        bundleId: "com.example.App",
        appName: "Example",
        kind: "affordance",
        description: "Imported lesson is added as a candidate.",
        confidence: 0.9,
      });
      const path = join(otherHome, "bundle.json");
      writeMemoryBundle(path);

      Bun.env.OPENCLICK_HOME = home;
      importMemoryBundle(path);
      Bun.env.OPENCLICK_HOME = original;
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }

    const facts = exportMemoryBundle().memories[0]?.affordances ?? [];
    expect(facts.map((fact) => fact.description)).toContain(
      "Local lesson remains available.",
    );
    expect(facts.map((fact) => fact.description)).toContain(
      "Imported lesson is added as a candidate.",
    );
    expect(
      facts.find(
        (fact) => fact.description === "Local lesson remains available.",
      )?.source,
    ).toBe("local");
    expect(
      facts.find(
        (fact) =>
          fact.description === "Imported lesson is added as a candidate.",
      )?.source,
    ).toBe("imported");
  });

  test("takeover outcomes add better-scoped lessons without overwriting successes", () => {
    recordTakeoverLearning({
      bundleId: "com.example.App",
      appName: "Example",
      task: "Open the latest unread Gmail email",
      issue: "Confirmation click required",
      summary: "Clicked Continue, then Gmail returned to the inbox.",
      outcome: "success",
    });
    recordTakeoverLearning({
      bundleId: "com.example.App",
      appName: "Example",
      task: "Open the latest unread Gmail email",
      issue: "Wrong screen after takeover",
      summary: "The takeover ended on Chrome settings, not Gmail.",
      outcome: "failed",
    });

    const memory = exportMemoryBundle().memories[0];
    expect(memory?.affordances[0]?.description).toContain(
      "successful user takeover",
    );
    expect(memory?.avoid[0]?.description).toContain("did not fully resolve it");
  });
});
