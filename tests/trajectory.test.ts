import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readTrajectory } from "../src/trajectory.ts";

describe("trajectory", () => {
  test("reads events.jsonl and session.json", async () => {
    const t = await readTrajectory(
      join(import.meta.dir, "fixtures/calc/trajectory"),
    );
    expect(t.session.task_name).toBe("calc");
    expect(t.events.length).toBeGreaterThan(0);
    expect(t.events[0]).toHaveProperty("kind");
  });
});
