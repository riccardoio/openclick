import { describe, expect, test } from "bun:test";
import { sampleScreenshots } from "../src/sampler.ts";

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
});
