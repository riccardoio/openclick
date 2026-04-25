import { describe, expect, test } from "bun:test";
import { sampleScreenshots } from "../src/sampler.ts";
import type { TrajectoryEvent } from "../src/trajectory.ts";

describe("sampler", () => {
  test("returns first, last, and key-change frames, capped at 6", () => {
    const events = [
      { kind: "click", screenshot: "1.jpg", post_state: "a" },
      { kind: "click", screenshot: "2.jpg", post_state: "a" },
      { kind: "click", screenshot: "3.jpg", post_state: "b" }, // change
      { kind: "click", screenshot: "4.jpg", post_state: "b" },
      { kind: "click", screenshot: "5.jpg", post_state: "c" }, // change
      { kind: "click", screenshot: "6.jpg", post_state: "c" },
      { kind: "click", screenshot: "7.jpg", post_state: "d" }, // change
    ];
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const sampled = sampleScreenshots(events as any, 6);
    expect(sampled).toContain("1.jpg"); // first
    expect(sampled).toContain("7.jpg"); // last
    expect(sampled).toContain("3.jpg"); // key-change
    expect(sampled.length).toBeLessThanOrEqual(6);
  });

  test("returns all when fewer than cap", () => {
    const events = [
      { kind: "click", screenshot: "1.jpg" },
      { kind: "click", screenshot: "2.jpg" },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const sampled = sampleScreenshots(events as any, 6);
    expect(sampled).toEqual(["1.jpg", "2.jpg"]);
  });

  test("derives state from ax_tree title when post_state is absent", () => {
    // Real Swift recordings don't emit post_state. Sampler should still detect
    // window-transition frames using the AX tree.
    const events = [
      {
        kind: "click",
        screenshot: "1.jpg",
        pid: 1,
        ax_tree: { role: "AXWindow", title: "Calc", children: [] },
      },
      {
        kind: "click",
        screenshot: "2.jpg",
        pid: 1,
        ax_tree: { role: "AXWindow", title: "Calc", children: [] },
      },
      {
        kind: "click",
        screenshot: "3.jpg",
        pid: 1,
        ax_tree: { role: "AXWindow", title: "Mail", children: [] },
      }, // change
      {
        kind: "click",
        screenshot: "4.jpg",
        pid: 1,
        ax_tree: { role: "AXWindow", title: "Mail", children: [] },
      },
      {
        kind: "click",
        screenshot: "5.jpg",
        pid: 1,
        ax_tree: { role: "AXWindow", title: "Mail", children: [] },
      },
      {
        kind: "click",
        screenshot: "6.jpg",
        pid: 1,
        ax_tree: { role: "AXWindow", title: "Mail", children: [] },
      },
      {
        kind: "click",
        screenshot: "7.jpg",
        pid: 1,
        ax_tree: { role: "AXWindow", title: "Notes", children: [] },
      }, // change
    ] as unknown as TrajectoryEvent[];
    const sampled = sampleScreenshots(events, 6);
    expect(sampled).toContain("1.jpg");
    expect(sampled).toContain("7.jpg");
    expect(sampled).toContain("3.jpg"); // Calc -> Mail transition
    expect(sampled).toContain("7.jpg"); // Mail -> Notes transition (= last anyway)
  });

  test("falls back to first+last when no key changes (no post_state, single window)", () => {
    const events = [
      {
        kind: "click",
        screenshot: "1.jpg",
        pid: 1,
        ax_tree: { role: "AXWindow", title: "Same", children: [] },
      },
      {
        kind: "click",
        screenshot: "2.jpg",
        pid: 1,
        ax_tree: { role: "AXWindow", title: "Same", children: [] },
      },
      {
        kind: "click",
        screenshot: "3.jpg",
        pid: 1,
        ax_tree: { role: "AXWindow", title: "Same", children: [] },
      },
      {
        kind: "click",
        screenshot: "4.jpg",
        pid: 1,
        ax_tree: { role: "AXWindow", title: "Same", children: [] },
      },
      {
        kind: "click",
        screenshot: "5.jpg",
        pid: 1,
        ax_tree: { role: "AXWindow", title: "Same", children: [] },
      },
      {
        kind: "click",
        screenshot: "6.jpg",
        pid: 1,
        ax_tree: { role: "AXWindow", title: "Same", children: [] },
      },
      {
        kind: "click",
        screenshot: "7.jpg",
        pid: 1,
        ax_tree: { role: "AXWindow", title: "Same", children: [] },
      },
    ] as unknown as TrajectoryEvent[];
    const sampled = sampleScreenshots(events, 6);
    expect(sampled).toEqual(["1.jpg", "7.jpg"]);
  });

  test("ignores events without screenshots", () => {
    const events = [
      { kind: "click", screenshot: "1.jpg" },
      { kind: "key" }, // no screenshot
      { kind: "click", screenshot: "2.jpg" },
    ] as unknown as TrajectoryEvent[];
    const sampled = sampleScreenshots(events, 6);
    expect(sampled).toEqual(["1.jpg", "2.jpg"]);
  });
});
