import { describe, expect, test } from "bun:test";
import { _internals } from "../src/run.ts";

const {
  extractBundleId,
  parseListAppsOutput,
  pickBundleIdByEarliestMention,
  pickInitialWindowId,
} = _internals;

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

describe("--fast pre-discovery: parseListAppsOutput", () => {
  test("parses real cua-driver list_apps output (running + installed)", () => {
    const stdout = `✅ Found 4 app(s): 2 running, 2 installed-not-running.
- App Store (pid 85965) [com.apple.AppStore]
- Calculator (pid 43349) [com.apple.calculator]
- Safari [com.apple.Safari]
- Finder [com.apple.finder]
`;
    const apps = parseListAppsOutput(stdout);
    expect(apps).toEqual([
      { name: "App Store", bundleId: "com.apple.AppStore", pid: 85965 },
      { name: "Calculator", bundleId: "com.apple.calculator", pid: 43349 },
      { name: "Safari", bundleId: "com.apple.Safari", pid: undefined },
      { name: "Finder", bundleId: "com.apple.finder", pid: undefined },
    ]);
  });

  test("ignores the summary header line", () => {
    const stdout =
      "✅ Found 1 app(s): 1 running, 0 installed-not-running.\n- Calculator (pid 1) [com.apple.calculator]\n";
    expect(parseListAppsOutput(stdout)).toEqual([
      { name: "Calculator", bundleId: "com.apple.calculator", pid: 1 },
    ]);
  });

  test("returns empty array when stdout has no app lines", () => {
    expect(parseListAppsOutput("")).toEqual([]);
    expect(parseListAppsOutput("error: connection refused\n")).toEqual([]);
  });
});

describe("--fast pre-discovery: pickBundleIdByEarliestMention", () => {
  const apps = [
    { name: "Calculator", bundleId: "com.apple.calculator" },
    { name: "Finder", bundleId: "com.apple.finder" },
    { name: "Safari", bundleId: "com.apple.Safari" },
  ];

  test("picks the app whose name appears first in the SKILL.md", () => {
    const skill = `# Calculator: 17 × 23
Use the Calculator to compute 17 × 23. Save the result to Finder.`;
    expect(pickBundleIdByEarliestMention(skill, apps)).toBe(
      "com.apple.calculator",
    );
  });

  test("returns null when no app name appears in the SKILL.md", () => {
    expect(
      pickBundleIdByEarliestMention("Open Notes and type a thing.", apps),
    ).toBeNull();
  });

  test("matches case-insensitively", () => {
    const skill = "use the calculator to compute 17 × 23";
    expect(pickBundleIdByEarliestMention(skill, apps)).toBe(
      "com.apple.calculator",
    );
  });

  test("when multiple app names appear, picks the EARLIEST", () => {
    // Finder mentioned first; Calculator mentioned later. Finder wins.
    const skill = "Open Finder, then later open Calculator.";
    expect(pickBundleIdByEarliestMention(skill, apps)).toBe("com.apple.finder");
  });
});

describe("--fast pre-discovery: pickInitialWindowId", () => {
  test("prefers the focused/frontmost content window over a larger stale window", () => {
    expect(
      pickInitialWindowId([
        {
          window_id: 111,
          title: "Existing Figma file",
          bounds: { width: 2200, height: 1300 },
          is_on_screen: true,
          on_current_space: true,
          z_index: 1,
        },
        {
          window_id: 222,
          title: "Target Figma file",
          bounds: { width: 1100, height: 800 },
          is_on_screen: true,
          on_current_space: false,
          is_focused: true,
          z_index: 100,
        },
      ]),
    ).toBe(222);
  });

  test("falls back to any reported window when bounds are missing", () => {
    expect(
      pickInitialWindowId([
        { window_id: 111, title: "Palette", z_index: 1 },
        { window_id: 222, title: "Untitled", z_index: 20 },
      ]),
    ).toBe(222);
  });

  test("uses task title tokens when no foreground signal is reliable", () => {
    expect(
      pickInitialWindowId(
        [
          {
            window_id: 111,
            title: "Landing page mockup",
            bounds: { width: 1600, height: 1000 },
            is_on_screen: true,
            z_index: 50,
          },
          {
            window_id: 222,
            title: "Pricing redesign",
            bounds: { width: 1200, height: 800 },
            is_on_screen: true,
            on_current_space: false,
            z_index: 1,
          },
        ],
        "In Figma, update the Pricing redesign file",
      ),
    ).toBe(222);
  });
});
