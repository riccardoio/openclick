import { describe, expect, test } from "bun:test";
import { _internals } from "../src/run.ts";

const { extractBundleId } = _internals;

describe("--fast pre-discovery: extractBundleId", () => {
  test("finds bundle id from a backtick code span (calc compile output)", () => {
    const skill = `
1. Launch Calculator (bundle id \`com.apple.calculator\`).
2. Click the AXButton titled "1".
`;
    expect(extractBundleId(skill)).toBe("com.apple.calculator");
  });

  test("finds bundle id without backticks", () => {
    const skill = "Launch the Reminders app (bundle id com.apple.reminders).";
    expect(extractBundleId(skill)).toBe("com.apple.reminders");
  });

  test("returns null when no bundle-id-shaped string is present", () => {
    const skill =
      "1. Open Calculator.\n2. Type 17.\n3. Type *.\n4. Press equals.";
    expect(extractBundleId(skill)).toBeNull();
  });

  test("matches several common reverse-DNS prefixes", () => {
    expect(extractBundleId("`org.mozilla.firefox`")).toBe(
      "org.mozilla.firefox",
    );
    expect(extractBundleId("`io.warp.Warp`")).toBe("io.warp.Warp");
    expect(extractBundleId("`net.kovidgoyal.kitty`")).toBe(
      "net.kovidgoyal.kitty",
    );
    expect(extractBundleId("`com.google.Chrome`")).toBe("com.google.Chrome");
  });

  test("returns the FIRST bundle id when several appear", () => {
    const skill =
      "Launch `com.apple.calculator`. Then maybe later `org.mozilla.firefox`.";
    expect(extractBundleId(skill)).toBe("com.apple.calculator");
  });

  test("doesn't match prose that happens to contain dots", () => {
    expect(extractBundleId("Press 1.7 then equals.")).toBeNull();
    expect(extractBundleId("This is text.")).toBeNull();
    expect(extractBundleId("foo.bar.baz")).toBeNull(); // not a known prefix
  });
});
