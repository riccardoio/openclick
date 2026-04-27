# open42 — Record-to-Skill Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a macOS CLI that lets a user demonstrate a task once, compiles the recording into a hybrid cua+agentskills SKILL.md via Claude, and replays it on the host Mac through cua-driver.

**Architecture:** Swift binary captures human input via `CGEventTap`, snapshots AX state per event via `cua-driver get_window_state`, takes periodic screenshots via `cua-driver screenshot`. TS+bun CLI orchestrates record/compile/run. `compile` calls Claude API once for SKILL.md generation, again for schema validation. `run` uses the Claude Agent SDK with cua-driver MCP attached.

**Tech Stack:** TypeScript + bun (CLI, compile, run), Swift Package Manager (recorder binary, XCTest), `@anthropic-ai/claude-agent-sdk` (run loop), `@anthropic-ai/sdk` (compile), cua-driver (existing, installed separately).

**Locked-in decisions (from /plan-eng-review 2026-04-25):**
1. **Recorder dist:** ship Swift source for build-from-source; ship notarized DMG via GitHub Releases for casual users.
2. **Output format:** single hybrid SKILL.md satisfying BOTH cua and agentskills schemas. Validator runs both checks before write.
3. **Run runtime:** Claude Agent SDK (TypeScript), cua-driver MCP attached via SDK's MCP support.

**Reference repos on disk** (read before reimplementing equivalents):
- `/Users/riccardo/Desktop/interface/clicky/` — `GlobalPushToTalkShortcutMonitor.swift` (CGEventTap), `WindowPositionManager.swift` (TCC), `ClaudeAPI.swift` (Claude streaming).
- `/Users/riccardo/Desktop/interface/agentskills/skills-ref/` — Python reference SDK; SKILL.md schema source of truth.
- `/Users/riccardo/Desktop/interface/cua-driver-docs/` — CLI reference + MCP tool schemas.

**Verified facts (don't re-verify during execution):**
- `@anthropic-ai/claude-agent-sdk` exists on npm. Latest: 0.2.119. Pin `^0.2.119`. Opus 4.7 requires ≥0.2.111 (per Anthropic docs).
- `@anthropic-ai/sdk` latest: 0.91.1. Pin `^0.91.1`.
- Model ID: `claude-opus-4-7` (Opus 4.7) is the correct identifier per Anthropic docs.
- Agent SDK entry: `import { query } from "@anthropic-ai/claude-agent-sdk"` — async iterable of messages. Options include `mcpServers`, `allowedTools`, `hooks` (PreToolUse for our preview/dry-run), `permissionMode`.
- `cua-driver` is installed on this machine at `/usr/local/bin/cua-driver` (symlink to `/Applications/CuaDriver.app/Contents/MacOS/cua-driver`).

**Project root:** `/Users/riccardo/Desktop/interface/rclick`. All paths in this plan are relative to this root unless noted.

## Prerequisites (set up before Task 0)

These are external accounts and one-time setups the dev must complete before the build can finish. Do them up front, not buried in Task 19.

- [ ] **`bun` installed** (`curl -fsSL https://bun.sh/install | bash` if missing). Verify: `bun --version`.
- [ ] **Xcode CLI tools installed.** Verify: `xcode-select -p` returns a path. Otherwise `xcode-select --install`.
- [ ] **`cua-driver` installed and granted Accessibility + Screen Recording permissions.** Verify: `cua-driver check_permissions` reports both granted.
- [ ] **`ANTHROPIC_API_KEY` exported** in shell (or saved to `.envrc` / `~/.zshrc`). Used by `compile`, `run`, and live eval tests.
- [ ] **Apple Developer Program membership active** — required for notarization. ~24-48hr lead time if signing up new. https://developer.apple.com/programs/
- [ ] **Apple Developer ID Application certificate created** in Xcode (or via developer.apple.com → Certificates). Export as `.p12`.
- [ ] **App-specific password generated** at https://appleid.apple.com (used by `xcrun notarytool`).
- [ ] **Apple Team ID** noted (find at https://developer.apple.com/account → Membership).

If you don't have the Apple Developer pieces yet: scaffold + build (Tasks 0–18) work without them. They become blocking only at Task 19 (release the notarized DMG). Source-distribution path works without them at any time.

---

## File Structure

```
open42/
├── package.json                      # bun + TS, defines `open42` bin
├── tsconfig.json                     # strict TS config
├── biome.json                        # lint+format (Biome, single tool)
├── .gitignore
├── README.md                         # populated in Task 20
├── bin/
│   └── open42                        # TS entry shim, calls into src/cli.ts
├── src/
│   ├── cli.ts                        # subcommand parser
│   ├── types.ts                      # shared types (Trajectory, SkillMd, etc.)
│   ├── paths.ts                      # ~/.cua/skills/<name>/ resolver
│   ├── record.ts                     # record subcommand: spawns Swift binary
│   ├── trajectory.ts                 # reader for events.jsonl + session.json
│   ├── sampler.ts                    # screenshot key-change sampler
│   ├── axtree.ts                     # AX-tree truncator
│   ├── prompt.ts                     # compile prompt builder + token guard
│   ├── schema.ts                     # hybrid SKILL.md validator (cua + agentskills)
│   ├── compile.ts                    # compile subcommand
│   └── run.ts                        # run subcommand (Claude Agent SDK)
├── tests/
│   ├── cli.test.ts
│   ├── trajectory.test.ts
│   ├── sampler.test.ts
│   ├── axtree.test.ts
│   ├── prompt.test.ts
│   ├── schema.test.ts
│   ├── compile.test.ts
│   ├── run.test.ts
│   ├── eval.test.ts                  # 3 golden-fixture eval
│   └── fixtures/
│       ├── calc/                     # known-good trajectory + expected SKILL.md shape
│       ├── triage/
│       └── todo/
├── recorder/
│   ├── Package.swift
│   ├── Sources/
│   │   ├── RecorderCore/
│   │   │   ├── Event.swift           # Codable event types
│   │   │   ├── AXTree.swift          # cua-driver get_window_state response
│   │   │   ├── TrajectoryWriter.swift
│   │   │   └── CuaDriver.swift       # shell-out to cua-driver
│   │   └── Recorder/
│   │       ├── main.swift            # entry: parse args, wire it all
│   │       ├── EventTap.swift        # CGEventTap wrapper
│   │       └── Screenshotter.swift   # 2s timer → cua-driver screenshot
│   └── Tests/
│       └── RecorderCoreTests/
│           ├── EventTests.swift
│           ├── AXTreeTests.swift
│           └── TrajectoryWriterTests.swift
├── skills/                           # bundled example skills (filled in Task 19)
│   └── triage-issues/
│       └── SKILL.md
└── .github/
    └── workflows/
        ├── ci.yml                    # typecheck + tests + Swift tests on macos
        └── release.yml               # tag → build DMG → notarize → publish
```

**Decomposition rationale:** small focused TS files (sampler, axtree, prompt, schema, compile each have one clear job). Swift split into Core (testable, no system APIs) and main module (system-level, manual smoke). Tests mirror source layout 1:1.

---

## Chunk 1: Foundation

Goal: scaffold builds cleanly, CLI prints help/version, Swift binary builds with `swift build`.

### Task 0: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `.gitignore`, `bin/open42`, `src/cli.ts`, `src/types.ts`, `recorder/Package.swift`, `recorder/Sources/Recorder/main.swift`, `recorder/Sources/RecorderCore/.gitkeep`, `recorder/Tests/RecorderCoreTests/.gitkeep`, `tests/.gitkeep`

- [ ] **Step 1: Create `.gitignore`**
```
node_modules/
.DS_Store
.bun/
dist/
recorder/.build/
recorder/.swiftpm/
*.log
```

- [ ] **Step 2: Create `package.json`**
```json
{
  "name": "open42",
  "version": "0.0.1",
  "description": "Record a task once, replay it on macOS via cua-driver.",
  "type": "module",
  "bin": { "open42": "./bin/open42" },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src tests",
    "format": "biome format --write src tests"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.91.1",
    "@anthropic-ai/claude-agent-sdk": "^0.2.119",
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
}
```
**Versions verified during planning (npm view).** No deferred verification needed.

- [ ] **Step 3: Create `tsconfig.json`**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["src", "bin", "tests"]
}
```

- [ ] **Step 4: Create `biome.json`**
```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "linter": { "enabled": true, "rules": { "recommended": true } }
}
```

- [ ] **Step 5: Create `bin/open42`**
```ts
#!/usr/bin/env bun
import { main } from "../src/cli.ts";
main(Bun.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
```
Then `chmod +x bin/open42`.

- [ ] **Step 6: Create stub `src/cli.ts`**
```ts
export async function main(args: string[]): Promise<void> {
  console.log("open42 0.0.1 (stub)");
}
```

- [ ] **Step 7: Create stub `src/types.ts`**
```ts
// Filled in across later tasks.
export type Empty = Record<string, never>;
```

- [ ] **Step 8: Create `recorder/Package.swift`**
```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "open42-recorder",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "open42-recorder", targets: ["Recorder"]),
    .library(name: "RecorderCore", targets: ["RecorderCore"]),
  ],
  targets: [
    .executableTarget(name: "Recorder", dependencies: ["RecorderCore"]),
    .target(name: "RecorderCore"),
    .testTarget(name: "RecorderCoreTests", dependencies: ["RecorderCore"]),
  ]
)
```

- [ ] **Step 9: Create stub `recorder/Sources/Recorder/main.swift`**
```swift
import Foundation

let args = CommandLine.arguments
if args.contains("--version") {
  print("open42-recorder 0.0.1")
  exit(0)
}
print("open42-recorder: stub. Use --version.")
```

- [ ] **Step 10: Install + verify**

Run: `bun install`
Expected: dependencies installed, `node_modules/` populated.

Run: `bun bin/open42`
Expected output: `open42 0.0.1 (stub)`

Run: `cd recorder && swift build -c release && ./.build/release/open42-recorder --version && cd ..`
Expected output: `open42-recorder 0.0.1`

- [ ] **Step 11: Commit**
```bash
git add .gitignore package.json tsconfig.json biome.json bin/ src/ recorder/ tests/
git commit -m "chore: scaffold open42 (TS+bun CLI + Swift recorder skeleton)"
```

---

### Task 1: TS CLI subcommand parser

**Files:**
- Modify: `src/cli.ts`
- Create: `tests/cli.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// tests/cli.test.ts
import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";

describe("cli", () => {
  test("--help prints usage with all three subcommands", async () => {
    const log = captureLog();
    await main(["--help"]);
    expect(log.text()).toContain("record");
    expect(log.text()).toContain("compile");
    expect(log.text()).toContain("run");
  });

  test("--version prints version", async () => {
    const log = captureLog();
    await main(["--version"]);
    expect(log.text()).toMatch(/^open42 \d+\.\d+\.\d+/);
  });

  test("unknown subcommand exits non-zero", async () => {
    await expect(main(["bogus"])).rejects.toThrow(/unknown subcommand/i);
  });

  test("no args prints help", async () => {
    const log = captureLog();
    await main([]);
    expect(log.text()).toContain("Usage:");
  });
});

function captureLog() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return {
    text: () => {
      console.log = original;
      return lines.join("\n");
    },
  };
}
```

- [ ] **Step 2: Run tests, expect failure**
Run: `bun test tests/cli.test.ts`
Expected: 4 failures (current `main` only prints stub).

- [ ] **Step 3: Implement `src/cli.ts`**
```ts
const VERSION = "0.0.1";

const USAGE = `Usage: open42 <command> [options]

Commands:
  record <task-name>     Record a task by demonstration
  compile <skill-name>   Compile a recording into a SKILL.md
  run <skill-name>       Run a compiled skill (default: --dry-run)

Options:
  --help, -h             Show this help
  --version, -v          Show version
`;

export async function main(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    return;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(`open42 ${VERSION}`);
    return;
  }
  const cmd = args[0];
  switch (cmd) {
    case "record":
    case "compile":
    case "run":
      console.log(`(${cmd} not implemented yet)`);
      return;
    default:
      throw new Error(`unknown subcommand: ${cmd}`);
  }
}
```

- [ ] **Step 4: Run tests, expect pass**
Run: `bun test tests/cli.test.ts`
Expected: all 4 pass.

- [ ] **Step 5: Commit**
```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat(cli): subcommand parser with help/version"
```

---

### Task 2: Swift recorder package + first test

**Files:**
- Create: `recorder/Sources/RecorderCore/Event.swift`, `recorder/Tests/RecorderCoreTests/EventTests.swift`

- [ ] **Step 1: Write the failing test**
```swift
// recorder/Tests/RecorderCoreTests/EventTests.swift
import XCTest
@testable import RecorderCore

final class EventTests: XCTestCase {
  func testClickEventRoundTrips() throws {
    let event = Event.click(ClickEvent(
      ts: "2026-04-25T10:00:00Z",
      pid: 71422,
      windowId: 8104,
      x: 412,
      y: 318,
      modifiers: ["cmd"]
    ))
    let data = try JSONEncoder().encode(event)
    let decoded = try JSONDecoder().decode(Event.self, from: data)
    XCTAssertEqual(decoded, event)
  }

  func testKeyEventEncodesKindField() throws {
    let event = Event.key(KeyEvent(ts: "2026-04-25T10:00:01Z", pid: 71422, key: "a", modifiers: []))
    let data = try JSONEncoder().encode(event)
    let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(json["kind"] as? String, "key")
  }
}
```

- [ ] **Step 2: Run tests, expect failure**
Run: `cd recorder && swift test`
Expected: compile errors (Event types don't exist).

- [ ] **Step 3: Implement `recorder/Sources/RecorderCore/Event.swift`**
```swift
import Foundation

public enum Event: Codable, Equatable {
  case click(ClickEvent)
  case key(KeyEvent)
  case scroll(ScrollEvent)

  enum CodingKeys: String, CodingKey { case kind }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .click(let e):
      try container.encode("click", forKey: .kind)
      try e.encode(to: encoder)
    case .key(let e):
      try container.encode("key", forKey: .kind)
      try e.encode(to: encoder)
    case .scroll(let e):
      try container.encode("scroll", forKey: .kind)
      try e.encode(to: encoder)
    }
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let kind = try container.decode(String.self, forKey: .kind)
    switch kind {
    case "click":  self = .click(try ClickEvent(from: decoder))
    case "key":    self = .key(try KeyEvent(from: decoder))
    case "scroll": self = .scroll(try ScrollEvent(from: decoder))
    default: throw DecodingError.dataCorruptedError(
      forKey: .kind, in: container, debugDescription: "unknown event kind: \(kind)"
    )
    }
  }
}

public struct ClickEvent: Codable, Equatable {
  public let ts: String
  public let pid: Int32
  public let windowId: Int
  public let x: Double
  public let y: Double
  public let modifiers: [String]
  public init(ts: String, pid: Int32, windowId: Int, x: Double, y: Double, modifiers: [String]) {
    self.ts = ts; self.pid = pid; self.windowId = windowId
    self.x = x; self.y = y; self.modifiers = modifiers
  }
}

public struct KeyEvent: Codable, Equatable {
  public let ts: String
  public let pid: Int32
  public let key: String
  public let modifiers: [String]
  public init(ts: String, pid: Int32, key: String, modifiers: [String]) {
    self.ts = ts; self.pid = pid; self.key = key; self.modifiers = modifiers
  }
}

public struct ScrollEvent: Codable, Equatable {
  public let ts: String
  public let pid: Int32
  public let dx: Double
  public let dy: Double
  public init(ts: String, pid: Int32, dx: Double, dy: Double) {
    self.ts = ts; self.pid = pid; self.dx = dx; self.dy = dy
  }
}
```

- [ ] **Step 4: Run tests, expect pass**
Run: `cd recorder && swift test`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**
```bash
git add recorder/Sources/RecorderCore/ recorder/Tests/
git commit -m "feat(recorder): Event Codable types with round-trip tests"
```

---

## Chunk 2: Swift Recorder

Goal: a working `open42-recorder` binary that captures real CGEvents, snapshots AX state per event, takes periodic screenshots, and writes a valid trajectory directory. Exits cleanly on SIGINT.

### Task 3: cua-driver bridge (Swift)

**Files:**
- Create: `recorder/Sources/RecorderCore/CuaDriver.swift`, `recorder/Sources/RecorderCore/AXTree.swift`, `recorder/Tests/RecorderCoreTests/CuaDriverTests.swift`

- [ ] **Step 1: Write the failing test**
```swift
// recorder/Tests/RecorderCoreTests/CuaDriverTests.swift
import XCTest
@testable import RecorderCore

final class CuaDriverTests: XCTestCase {
  func testParseGetWindowStateOutput() throws {
    let json = """
    {"pid":71422,"window_id":8104,"ax_tree":{"role":"AXWindow","title":"Calculator","children":[]},"has_screenshot":true}
    """.data(using: .utf8)!
    let result = try CuaDriver.parseWindowState(json)
    XCTAssertEqual(result.pid, 71422)
    XCTAssertEqual(result.windowId, 8104)
    XCTAssertEqual(result.axTree.role, "AXWindow")
  }

  func testParseFailsOnMissingFields() {
    let json = "{}".data(using: .utf8)!
    XCTAssertThrowsError(try CuaDriver.parseWindowState(json))
  }
}
```

- [ ] **Step 2: Run tests, expect failure**
Run: `cd recorder && swift test`
Expected: compile errors.

- [ ] **Step 3: Implement `AXTree.swift` and `CuaDriver.swift`**

```swift
// AXTree.swift
import Foundation

public struct AXNode: Codable, Equatable {
  public let role: String
  public let title: String?
  public let children: [AXNode]
}

public struct WindowState: Codable, Equatable {
  public let pid: Int32
  public let windowId: Int
  public let axTree: AXNode
  public let hasScreenshot: Bool

  enum CodingKeys: String, CodingKey {
    case pid
    case windowId = "window_id"
    case axTree = "ax_tree"
    case hasScreenshot = "has_screenshot"
  }
}
```

```swift
// CuaDriver.swift
import Foundation

public enum CuaDriverError: Error {
  case binaryNotFound
  case nonZeroExit(Int32, String)
  case parseError(String)
}

public enum CuaDriver {
  public static func parseWindowState(_ data: Data) throws -> WindowState {
    do {
      return try JSONDecoder().decode(WindowState.self, from: data)
    } catch {
      throw CuaDriverError.parseError("\(error)")
    }
  }

  public static func getWindowState(pid: Int32, windowId: Int) throws -> WindowState {
    let args = "{\"pid\":\(pid),\"window_id\":\(windowId)}"
    let data = try run(["get_window_state", args])
    return try parseWindowState(data)
  }

  public static func screenshot(pid: Int32, windowId: Int, outPath: String) throws {
    let args = "{\"pid\":\(pid),\"window_id\":\(windowId)}"
    _ = try run(["screenshot", args, "--image-out", outPath])
  }

  private static func run(_ args: [String]) throws -> Data {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: try resolveBinary())
    process.arguments = args
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    do { try process.run() } catch { throw CuaDriverError.binaryNotFound }
    process.waitUntilExit()
    let data = stdout.fileHandleForReading.readDataToEndOfFile()
    if process.terminationStatus != 0 {
      let err = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      throw CuaDriverError.nonZeroExit(process.terminationStatus, err)
    }
    return data
  }

  private static func resolveBinary() throws -> String {
    if let env = ProcessInfo.processInfo.environment["CUA_DRIVER"], FileManager.default.isExecutableFile(atPath: env) {
      return env
    }
    let candidates = [
      "/usr/local/bin/cua-driver",
      "/opt/homebrew/bin/cua-driver",
      "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    ]
    for path in candidates {
      if FileManager.default.isExecutableFile(atPath: path) { return path }
    }
    throw CuaDriverError.binaryNotFound
  }
}
```

- [ ] **Step 4: Run tests, expect pass**
Run: `cd recorder && swift test`
Expected: 4 tests pass (2 prior + 2 new).

- [ ] **Step 5: Commit**
```bash
git add recorder/Sources/RecorderCore/AXTree.swift recorder/Sources/RecorderCore/CuaDriver.swift recorder/Tests/RecorderCoreTests/CuaDriverTests.swift
git commit -m "feat(recorder): cua-driver bridge with parsing tests"
```

---

### Task 4: Trajectory writer (Swift)

**Files:**
- Create: `recorder/Sources/RecorderCore/TrajectoryWriter.swift`, `recorder/Tests/RecorderCoreTests/TrajectoryWriterTests.swift`

The trajectory directory layout matches `cua skills record` output (per design premise 1). Layout:

```
~/.cua/skills/<name>/trajectory/
├── session.json                # task description, started_at, ended_at, app_bundles
├── events.jsonl                # one event per line, includes attached AX tree + screenshot ref
└── step_NNN.jpg                # periodic + per-event screenshots
```

- [ ] **Step 1: Write the failing test**
```swift
// recorder/Tests/RecorderCoreTests/TrajectoryWriterTests.swift
import XCTest
@testable import RecorderCore

final class TrajectoryWriterTests: XCTestCase {
  func testAppendEventWritesJSONLine() throws {
    let dir = try tempDir()
    let writer = try TrajectoryWriter(directory: dir, taskName: "test", taskDescription: "demo")
    let event = Event.click(ClickEvent(
      ts: "2026-04-25T10:00:00Z", pid: 1, windowId: 1, x: 1, y: 1, modifiers: []
    ))
    try writer.appendEvent(event, axTree: nil, screenshotRef: nil)
    try writer.finalize()

    let lines = try String(contentsOf: dir.appendingPathComponent("events.jsonl"))
    let parsed = lines.split(separator: "\n").compactMap { line in
      try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
    }
    XCTAssertEqual(parsed.count, 1)
    XCTAssertEqual(parsed[0]["kind"] as? String, "click")
  }

  func testFinalizeWritesSessionJson() throws {
    let dir = try tempDir()
    let writer = try TrajectoryWriter(directory: dir, taskName: "test", taskDescription: "demo")
    try writer.finalize()
    let session = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("session.json"))) as? [String: Any]
    XCTAssertEqual(session?["task_name"] as? String, "test")
    XCTAssertNotNil(session?["started_at"])
    XCTAssertNotNil(session?["ended_at"])
  }

  private func tempDir() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }
}
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd recorder && swift test`
Expected: compile errors.

- [ ] **Step 3: Implement `TrajectoryWriter.swift`**
```swift
import Foundation

public final class TrajectoryWriter {
  private let directory: URL
  private let taskName: String
  private let taskDescription: String
  private let startedAt: Date
  private let eventsHandle: FileHandle
  private var screenshotCounter: Int = 0
  private var eventCount: Int = 0

  public init(directory: URL, taskName: String, taskDescription: String) throws {
    self.directory = directory
    self.taskName = taskName
    self.taskDescription = taskDescription
    self.startedAt = Date()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let eventsURL = directory.appendingPathComponent("events.jsonl")
    FileManager.default.createFile(atPath: eventsURL.path, contents: nil)
    self.eventsHandle = try FileHandle(forWritingTo: eventsURL)
  }

  public func appendEvent(_ event: Event, axTree: AXNode?, screenshotRef: String?) throws {
    let envelope = EventEnvelope(event: event, axTree: axTree, screenshotRef: screenshotRef)
    let data = try JSONEncoder().encode(envelope)
    eventsHandle.write(data)
    eventsHandle.write(Data([0x0A]))  // newline
    eventCount += 1
  }

  public func nextScreenshotName() -> String {
    screenshotCounter += 1
    return String(format: "step_%04d.jpg", screenshotCounter)
  }

  public func screenshotURL(name: String) -> URL {
    directory.appendingPathComponent(name)
  }

  public func finalize() throws {
    try eventsHandle.close()
    let session = SessionMetadata(
      taskName: taskName,
      taskDescription: taskDescription,
      startedAt: ISO8601DateFormatter().string(from: startedAt),
      endedAt: ISO8601DateFormatter().string(from: Date()),
      eventCount: eventCount,
      screenshotCount: screenshotCounter
    )
    let data = try JSONEncoder().encode(session)
    try data.write(to: directory.appendingPathComponent("session.json"))
  }
}

private struct EventEnvelope: Encodable {
  let event: Event
  let axTree: AXNode?
  let screenshotRef: String?

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: DynamicKey.self)
    // Inline event fields by re-encoding through the event's own encoder
    let eventData = try JSONEncoder().encode(event)
    let eventDict = try JSONSerialization.jsonObject(with: eventData) as? [String: Any] ?? [:]
    for (k, v) in eventDict {
      try container.encode(AnyEncodable(v), forKey: DynamicKey(stringValue: k)!)
    }
    if let axTree = axTree {
      try container.encode(axTree, forKey: DynamicKey(stringValue: "ax_tree")!)
    }
    if let ref = screenshotRef {
      try container.encode(ref, forKey: DynamicKey(stringValue: "screenshot")!)
    }
  }
}

private struct DynamicKey: CodingKey {
  var stringValue: String
  var intValue: Int? { nil }
  init?(stringValue: String) { self.stringValue = stringValue }
  init?(intValue: Int) { return nil }
}

private struct AnyEncodable: Encodable {
  let value: Any
  init(_ value: Any) { self.value = value }
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch value {
    case let v as String: try container.encode(v)
    case let v as Int: try container.encode(v)
    case let v as Double: try container.encode(v)
    case let v as Bool: try container.encode(v)
    case let v as [Any]: try container.encode(v.map(AnyEncodable.init))
    case let v as [String: Any]:
      var keyed = encoder.container(keyedBy: DynamicKey.self)
      for (k, vv) in v { try keyed.encode(AnyEncodable(vv), forKey: DynamicKey(stringValue: k)!) }
    default: try container.encodeNil()
    }
  }
}

private struct SessionMetadata: Encodable {
  let taskName: String
  let taskDescription: String
  let startedAt: String
  let endedAt: String
  let eventCount: Int
  let screenshotCount: Int

  enum CodingKeys: String, CodingKey {
    case taskName = "task_name"
    case taskDescription = "task_description"
    case startedAt = "started_at"
    case endedAt = "ended_at"
    case eventCount = "event_count"
    case screenshotCount = "screenshot_count"
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cd recorder && swift test`
Expected: 2 new tests pass; 4 prior pass; 6 total.

- [ ] **Step 5: Commit**
```bash
git add recorder/Sources/RecorderCore/TrajectoryWriter.swift recorder/Tests/RecorderCoreTests/TrajectoryWriterTests.swift
git commit -m "feat(recorder): trajectory writer with events.jsonl + session.json"
```

---

### Task 5: CGEventTap + permission flow (manual smoke)

**Files:**
- Create: `recorder/Sources/Recorder/EventTap.swift`, `recorder/Sources/Recorder/Permissions.swift`

Reference: `clicky/leanring-buddy/leanring-buddy/GlobalPushToTalkShortcutMonitor.swift` (read it first — listen-only `CGEventTap`, callback C function pattern, location enum).

- [ ] **Step 1: Implement `Permissions.swift`**
```swift
import ApplicationServices
import Foundation

public enum Permissions {
  public static func hasAccessibility() -> Bool {
    return AXIsProcessTrusted()
  }

  public static func promptIfMissing() {
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(opts)
  }

  public static func ensureOrDie() {
    if hasAccessibility() { return }
    print("""
    open42-recorder requires Accessibility permission to capture human input.

    1. macOS just opened System Settings → Privacy & Security → Accessibility.
    2. Click the + and add this binary at:
       \(CommandLine.arguments[0])
    3. Re-run open42-recorder.
    """)
    promptIfMissing()
    exit(2)
  }
}
```

- [ ] **Step 2: Implement `EventTap.swift`**
```swift
import CoreGraphics
import Foundation
import RecorderCore

public final class EventTap {
  public typealias Handler = (Event) -> Void
  private var tap: CFMachPort?
  private var runLoopSource: CFRunLoopSource?
  private let handler: Handler

  public init(handler: @escaping Handler) {
    self.handler = handler
  }

  public func start() throws {
    let mask: CGEventMask = (1 << CGEventType.leftMouseDown.rawValue)
                          | (1 << CGEventType.rightMouseDown.rawValue)
                          | (1 << CGEventType.keyDown.rawValue)
                          | (1 << CGEventType.scrollWheel.rawValue)

    let userInfo = Unmanaged.passUnretained(self).toOpaque()
    guard let tap = CGEvent.tapCreate(
      tap: .cgSessionEventTap,
      place: .headInsertEventTap,
      options: .listenOnly,
      eventsOfInterest: mask,
      callback: EventTap.callback,
      userInfo: userInfo
    ) else {
      throw NSError(domain: "open42-recorder", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "CGEvent.tapCreate failed (Accessibility likely revoked)"])
    }
    self.tap = tap
    self.runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), self.runLoopSource, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
  }

  public func stop() {
    if let tap = tap { CGEvent.tapEnable(tap: tap, enable: false) }
    if let src = runLoopSource { CFRunLoopRemoveSource(CFRunLoopGetCurrent(), src, .commonModes) }
    tap = nil; runLoopSource = nil
  }

  private static let callback: CGEventTapCallBack = { _, type, event, userInfo in
    guard let userInfo = userInfo else { return Unmanaged.passUnretained(event) }
    let me = Unmanaged<EventTap>.fromOpaque(userInfo).takeUnretainedValue()
    let ts = ISO8601DateFormatter().string(from: Date())
    let pid = event.getIntegerValueField(.eventTargetUnixProcessID)
    let location = event.location

    switch type {
    case .leftMouseDown, .rightMouseDown:
      me.handler(.click(ClickEvent(
        ts: ts, pid: Int32(pid), windowId: 0,
        x: Double(location.x), y: Double(location.y), modifiers: []
      )))
    case .keyDown:
      let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
      me.handler(.key(KeyEvent(
        ts: ts, pid: Int32(pid), key: "kc:\(keyCode)", modifiers: []
      )))
    case .scrollWheel:
      me.handler(.scroll(ScrollEvent(
        ts: ts, pid: Int32(pid),
        dx: Double(event.getIntegerValueField(.scrollWheelEventDeltaAxis2)),
        dy: Double(event.getIntegerValueField(.scrollWheelEventDeltaAxis1))
      )))
    default: break
    }
    return Unmanaged.passUnretained(event)
  }
}
```

Note: this captures `windowId: 0` for now (CGEvent doesn't carry window id). Task 7 wires AX-snapshotting which fills the real window id.

- [ ] **Step 3: Manual smoke test**

Modify `main.swift` to:
```swift
import Foundation
import RecorderCore

if CommandLine.arguments.contains("--smoke-tap") {
  Permissions.ensureOrDie()
  let tap = EventTap { event in
    let data = try? JSONEncoder().encode(event)
    if let s = data.flatMap({ String(data: $0, encoding: .utf8) }) {
      FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
    }
  }
  try tap.start()
  print("[smoke] tap running. Click around, press keys. Ctrl-C to exit.")
  CFRunLoopRun()
}
```

Build + run:
```bash
cd recorder && swift build -c release
./.build/release/open42-recorder --smoke-tap
```

Expected: macOS prompts for Accessibility (first run only). After granting, click somewhere — JSON event prints to stdout. Press Ctrl-C to exit.

If you see no events after granting Accessibility: re-launch the binary (TCC sometimes requires a relaunch). If the binary moved/rebuilt and prompts again, that's expected (cdhash changed).

- [ ] **Step 4: Commit**
```bash
git add recorder/Sources/Recorder/EventTap.swift recorder/Sources/Recorder/Permissions.swift recorder/Sources/Recorder/main.swift
git commit -m "feat(recorder): CGEventTap + Accessibility permission flow"
```

---

### Task 6: Periodic screenshot timer (Swift)

**Files:**
- Create: `recorder/Sources/Recorder/Screenshotter.swift`

- [ ] **Step 1: Implement `Screenshotter.swift`**
```swift
import Foundation
import RecorderCore

public final class Screenshotter {
  private let writer: TrajectoryWriter
  private let intervalSeconds: TimeInterval
  private var timer: DispatchSourceTimer?
  private let queue = DispatchQueue(label: "open42.screenshotter")
  private var currentTarget: (pid: Int32, windowId: Int)? = nil

  public init(writer: TrajectoryWriter, intervalSeconds: TimeInterval = 2.0) {
    self.writer = writer
    self.intervalSeconds = intervalSeconds
  }

  public func setTarget(pid: Int32, windowId: Int) {
    self.currentTarget = (pid, windowId)
  }

  public func start() {
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now(), repeating: .milliseconds(Int(intervalSeconds * 1000)))
    t.setEventHandler { [weak self] in self?.tick() }
    t.resume()
    self.timer = t
  }

  public func captureNow() {
    queue.async { [weak self] in self?.tick() }
  }

  public func stop() {
    timer?.cancel(); timer = nil
  }

  private func tick() {
    guard let target = currentTarget else { return }
    let name = writer.nextScreenshotName()
    let url = writer.screenshotURL(name: name)
    do {
      try CuaDriver.screenshot(pid: target.pid, windowId: target.windowId, outPath: url.path)
    } catch {
      FileHandle.standardError.write("screenshot failed: \(error)\n".data(using: .utf8)!)
    }
  }
}
```

- [ ] **Step 2: Manual smoke**
Add a `--smoke-screenshot` mode in main.swift that runs the screenshotter for 6s against the frontmost window (ask cua-driver `list_windows` for the front pid/window_id, or hardcode a test pid). Verify 3 `step_NNNN.jpg` files appear.

- [ ] **Step 3: Commit**
```bash
git add recorder/Sources/Recorder/Screenshotter.swift recorder/Sources/Recorder/main.swift
git commit -m "feat(recorder): periodic screenshot timer via cua-driver"
```

---

### Task 7: Recorder main wires it all together

**Files:**
- Modify: `recorder/Sources/Recorder/main.swift`

**Counter ownership:** the screenshotter owns `nextScreenshotName()` calls. main.swift never calls it directly — it gets the name back from `captureNow()` synchronously. This avoids the off-by-one between what's written to events.jsonl and what's on disk.

**Window resolution:** factored out of main.swift into `RecorderCore/CuaDriver.swift` so it has a stable test surface (covered by Task 5 once we add the `listWindows` test).

- [ ] **Step 1: Add `listWindows` to `RecorderCore/CuaDriver.swift`**

Append to the `CuaDriver` enum:
```swift
public struct WindowInfo: Codable, Equatable {
  public let pid: Int32
  public let windowId: Int
  enum CodingKeys: String, CodingKey { case pid; case windowId = "window_id" }
}

public static func listWindows(pid: Int32) throws -> [WindowInfo] {
  let args = "{\"pid\":\(pid)}"
  let data = try run(["list_windows", args])
  struct Resp: Codable { let windows: [WindowInfo] }
  return try JSONDecoder().decode(Resp.self, from: data).windows
}
```

- [ ] **Step 2: Make `Screenshotter.captureNow()` return the name it wrote (or nil)**

Replace the body of `captureNow()` in `Screenshotter.swift`:
```swift
public func captureNow() -> String? {
  guard let target = currentTarget else { return nil }
  let name = writer.nextScreenshotName()
  let url = writer.screenshotURL(name: name)
  do {
    try CuaDriver.screenshot(pid: target.pid, windowId: target.windowId, outPath: url.path)
    return name
  } catch {
    FileHandle.standardError.write("screenshot failed: \(error)\n".data(using: .utf8)!)
    return nil
  }
}
```
(The periodic `tick()` continues to use `nextScreenshotName()` directly since it doesn't need to surface the name to a caller.)

- [ ] **Step 3: Replace `main.swift` with the full implementation**
```swift
import Foundation
import RecorderCore

func usage() -> Never {
  print("""
  Usage: open42-recorder --output <dir> --task <name> --description <text>

  Captures CGEvents + AX snapshots + periodic screenshots into <dir>/events.jsonl
  and <dir>/session.json. Stop with Ctrl-C.
  """)
  exit(0)
}

let args = CommandLine.arguments
if args.contains("--version") { print("open42-recorder 0.0.1"); exit(0) }
if args.contains("--help") { usage() }

func arg(_ flag: String) -> String? {
  guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
  return args[i + 1]
}

guard let outDir = arg("--output"),
      let taskName = arg("--task"),
      let taskDesc = arg("--description") else { usage() }

Permissions.ensureOrDie()

let outURL = URL(fileURLWithPath: (outDir as NSString).expandingTildeInPath)
let writer = try TrajectoryWriter(
  directory: outURL, taskName: taskName, taskDescription: taskDesc
)
let screenshotter = Screenshotter(writer: writer)

let tap = EventTap { event in
  let pid: Int32
  switch event {
  case .click(let e): pid = e.pid
  case .key(let e): pid = e.pid
  case .scroll(let e): pid = e.pid
  }

  var axNode: AXNode? = nil
  if pid > 0 {
    if let windows = try? CuaDriver.listWindows(pid: pid), let first = windows.first {
      screenshotter.setTarget(pid: pid, windowId: first.windowId)
      if let state = try? CuaDriver.getWindowState(pid: pid, windowId: first.windowId) {
        axNode = state.axTree
      }
    }
  }

  // Single source of truth for the screenshot name: captureNow() writes the file
  // AND returns the name. If it fails or there's no target, screenshotRef is nil
  // and the LLM can correlate frames by timestamp.
  let screenshotRef = screenshotter.captureNow()

  do {
    try writer.appendEvent(event, axTree: axNode, screenshotRef: screenshotRef)
  } catch {
    FileHandle.standardError.write("append failed: \(error)\n".data(using: .utf8)!)
  }
}

screenshotter.start()
try tap.start()

signal(SIGINT, SIG_IGN)
let sigSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigSrc.setEventHandler {
  print("\nFinalizing trajectory...")
  tap.stop()
  screenshotter.stop()
  try? writer.finalize()
  print("Wrote: \(outURL.path)")
  exit(0)
}
sigSrc.resume()

print("[open42-recorder] recording → \(outURL.path)")
print("[open42-recorder] perform your task. Ctrl-C when done.")
CFRunLoopRun()
```

**Note on `pid > 0` degradation:** listen-only `CGEventTap`s sometimes return pid=0 for synthesized events or specific app states. When pid=0, ax_tree falls back to null and the LLM correlates from screenshots alone. Add an assertion in Task 17's iteration loop: at least 60% of events should have a non-null `ax_tree` on a clean recording. If not, investigate why the foreground pid isn't propagating.

- [ ] **Step 2: E2E smoke test**

Run cua-driver daemon: `open -n -g -a CuaDriver --args serve`

Run recorder against a test directory:
```bash
mkdir -p /tmp/open42-test
cd recorder && swift build -c release
./.build/release/open42-recorder \
  --output /tmp/open42-test \
  --task calc-test \
  --description "calculator 17 times 23"
```

Open Calculator, type `17 * 23 =`, then `Ctrl-C` in the recorder terminal.

Verify:
- `/tmp/open42-test/events.jsonl` has 8+ lines (one per click/key)
- `/tmp/open42-test/session.json` exists with task_name + task_description
- `/tmp/open42-test/step_*.jpg` files exist
- Sample one event line — `kind` is set; `ax_tree` field present (may be null if cua-driver couldn't snapshot)

- [ ] **Step 3: Commit**
```bash
git add recorder/Sources/Recorder/main.swift
git commit -m "feat(recorder): wire EventTap + AX snapshot + screenshotter + writer"
```

---

## Chunk 3: Compile + Run

Goal: TS subcommands that turn a trajectory directory into a SKILL.md and replay it via the Claude Agent SDK.

### Task 8: TS `record` subcommand

**Files:**
- Create: `src/paths.ts`, `src/record.ts`, `tests/record.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// tests/record.test.ts
import { describe, expect, test } from "bun:test";
import { resolveSkillTrajectoryPath } from "../src/paths.ts";

describe("paths", () => {
  test("resolveSkillTrajectoryPath returns ~/.cua/skills/<name>/trajectory", () => {
    const result = resolveSkillTrajectoryPath("triage-issues");
    expect(result).toMatch(/\.cua\/skills\/triage-issues\/trajectory$/);
  });
});
```

- [ ] **Step 2: Implement `src/paths.ts`**
```ts
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveSkillTrajectoryPath(skillName: string): string {
  return join(homedir(), ".cua", "skills", skillName, "trajectory");
}

export function resolveSkillRoot(skillName: string): string {
  return join(homedir(), ".cua", "skills", skillName);
}

export function resolveRecorderBinary(): string {
  // First check vendored binary in the repo (built via `swift build`).
  const repoBin = join(import.meta.dir, "..", "recorder", ".build", "release", "open42-recorder");
  return repoBin;
}
```

- [ ] **Step 3: Implement `src/record.ts`**
```ts
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { resolveSkillTrajectoryPath, resolveRecorderBinary } from "./paths.ts";

export interface RecordOptions {
  skillName: string;
  description: string;
}

export async function recordCommand(opts: RecordOptions): Promise<void> {
  const dir = resolveSkillTrajectoryPath(opts.skillName);
  mkdirSync(dir, { recursive: true });

  const binary = resolveRecorderBinary();
  if (!existsSync(binary)) {
    throw new Error(
      `recorder binary not found at ${binary}\n` +
      `Build it first: cd recorder && swift build -c release`
    );
  }

  console.log("[open42] this recording will capture screenshots of your screen.");
  console.log("[open42] close anything sensitive. Starting in 3...");
  await sleep(1000); console.log("2..."); await sleep(1000); console.log("1..."); await sleep(1000);

  const proc = spawn(binary, [
    "--output", dir,
    "--task", opts.skillName,
    "--description", opts.description,
  ], { stdio: "inherit" });

  await new Promise<void>((resolve, reject) => {
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`recorder exited with code ${code}`));
    });
  });

  console.log(`[open42] trajectory written to ${dir}`);
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
```

- [ ] **Step 4: Wire into `src/cli.ts`**
Add to the switch:
```ts
case "record": {
  const skillName = args[1];
  if (!skillName) throw new Error("record requires <skill-name>");
  const description = args.slice(2).join(" ") || skillName;
  const { recordCommand } = await import("./record.ts");
  await recordCommand({ skillName, description });
  return;
}
```

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: all prior + new path test pass.

- [ ] **Step 6: Commit**
```bash
git add src/paths.ts src/record.ts src/cli.ts tests/record.test.ts
git commit -m "feat(cli): record subcommand spawns Swift recorder"
```

---

### Task 9: Trajectory reader + sampler + AX truncator (TS)

**Files:**
- Create: `src/trajectory.ts`, `src/sampler.ts`, `src/axtree.ts`
- Create: `tests/trajectory.test.ts`, `tests/sampler.test.ts`, `tests/axtree.test.ts`
- Create fixture: `tests/fixtures/calc/trajectory/events.jsonl`, `tests/fixtures/calc/trajectory/session.json`, `tests/fixtures/calc/trajectory/step_0001.jpg` (1px black jpg) etc.

- [ ] **Step 1: Write failing tests**
```ts
// tests/trajectory.test.ts
import { describe, expect, test } from "bun:test";
import { readTrajectory } from "../src/trajectory.ts";
import { join } from "node:path";

describe("trajectory", () => {
  test("reads events.jsonl and session.json", async () => {
    const t = await readTrajectory(join(import.meta.dir, "fixtures/calc/trajectory"));
    expect(t.session.task_name).toBe("calc");
    expect(t.events.length).toBeGreaterThan(0);
    expect(t.events[0]).toHaveProperty("kind");
  });
});
```
```ts
// tests/sampler.test.ts
import { describe, expect, test } from "bun:test";
import { sampleScreenshots } from "../src/sampler.ts";

describe("sampler", () => {
  test("returns first, last, and key-change frames, capped at 6", () => {
    const events = [
      { kind: "click", screenshot: "1.jpg", post_state: "a" },
      { kind: "click", screenshot: "2.jpg", post_state: "a" },
      { kind: "click", screenshot: "3.jpg", post_state: "b" },  // change
      { kind: "click", screenshot: "4.jpg", post_state: "b" },
      { kind: "click", screenshot: "5.jpg", post_state: "c" },  // change
      { kind: "click", screenshot: "6.jpg", post_state: "c" },
      { kind: "click", screenshot: "7.jpg", post_state: "d" },  // change
    ];
    const sampled = sampleScreenshots(events as any, 6);
    expect(sampled).toContain("1.jpg");          // first
    expect(sampled).toContain("7.jpg");          // last
    expect(sampled).toContain("3.jpg");          // key-change
    expect(sampled.length).toBeLessThanOrEqual(6);
  });

  test("returns all when fewer than cap", () => {
    const events = [
      { kind: "click", screenshot: "1.jpg" },
      { kind: "click", screenshot: "2.jpg" },
    ];
    const sampled = sampleScreenshots(events as any, 6);
    expect(sampled).toEqual(["1.jpg", "2.jpg"]);
  });
});
```
```ts
// tests/axtree.test.ts
import { describe, expect, test } from "bun:test";
import { truncateAxTree, countNodes } from "../src/axtree.ts";

describe("axtree", () => {
  test("truncates to max nodes", () => {
    const tree = makeBigTree(500);
    const truncated = truncateAxTree(tree, { maxNodes: 200, maxDepth: 6 });
    expect(countNodes(truncated)).toBeLessThanOrEqual(200);
  });

  test("truncates to max depth", () => {
    const deep = makeDeepTree(20);
    const truncated = truncateAxTree(deep, { maxNodes: 1000, maxDepth: 6 });
    expect(maxDepth(truncated)).toBeLessThanOrEqual(6);
  });
});

function makeBigTree(n: number): any {
  const children = Array.from({ length: n - 1 }, (_, i) => ({ role: "AXLink", title: `n${i}`, children: [] }));
  return { role: "AXWindow", title: "root", children };
}
function makeDeepTree(d: number): any {
  if (d === 0) return { role: "AXLeaf", title: null, children: [] };
  return { role: "AXGroup", title: null, children: [makeDeepTree(d - 1)] };
}
function maxDepth(t: any): number {
  if (!t.children?.length) return 1;
  return 1 + Math.max(...t.children.map(maxDepth));
}
```

- [ ] **Step 2: Run tests, expect failure**

Run: `bun test`
Expected: 5 new failures.

- [ ] **Step 3: Implement modules**

```ts
// src/trajectory.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionMetadata {
  task_name: string;
  task_description: string;
  started_at: string;
  ended_at: string;
  event_count: number;
  screenshot_count: number;
}

export interface TrajectoryEvent {
  kind: "click" | "key" | "scroll";
  ts: string;
  pid: number;
  // ... other fields per kind
  screenshot?: string;
  ax_tree?: unknown;
  post_state?: string;
  [key: string]: unknown;
}

export interface Trajectory {
  directory: string;
  session: SessionMetadata;
  events: TrajectoryEvent[];
}

export async function readTrajectory(dir: string): Promise<Trajectory> {
  const session: SessionMetadata = JSON.parse(
    readFileSync(join(dir, "session.json"), "utf-8")
  );
  const eventsRaw = readFileSync(join(dir, "events.jsonl"), "utf-8");
  const events = eventsRaw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TrajectoryEvent);
  return { directory: dir, session, events };
}
```

```ts
// src/sampler.ts
import type { TrajectoryEvent } from "./trajectory.ts";

export function sampleScreenshots(events: TrajectoryEvent[], cap: number): string[] {
  const withScreenshot = events.filter((e) => e.screenshot);
  if (withScreenshot.length === 0) return [];
  if (withScreenshot.length <= cap) return withScreenshot.map((e) => e.screenshot!);

  // Always include first and last
  const result = new Set<string>();
  result.add(withScreenshot[0]!.screenshot!);
  result.add(withScreenshot[withScreenshot.length - 1]!.screenshot!);

  // Key-change frames: post_state changed vs previous
  const changes: string[] = [];
  for (let i = 1; i < withScreenshot.length; i++) {
    if (withScreenshot[i]!.post_state !== withScreenshot[i - 1]!.post_state) {
      changes.push(withScreenshot[i]!.screenshot!);
    }
  }
  for (const c of changes) {
    if (result.size >= cap) break;
    result.add(c);
  }
  return Array.from(result);
}
```

```ts
// src/axtree.ts
export interface AxNode {
  role: string;
  title: string | null;
  children: AxNode[];
}

export interface TruncateOpts {
  maxNodes: number;
  maxDepth: number;
}

export function countNodes(t: AxNode): number {
  return 1 + (t.children ?? []).reduce((sum, c) => sum + countNodes(c), 0);
}

export function truncateAxTree(t: AxNode, opts: TruncateOpts): AxNode {
  let budget = opts.maxNodes;
  function trunc(node: AxNode, depth: number): AxNode {
    if (budget <= 0 || depth >= opts.maxDepth) {
      budget = Math.max(0, budget - 1);
      return { ...node, children: [] };
    }
    budget--;
    const kids: AxNode[] = [];
    for (const child of node.children ?? []) {
      if (budget <= 0) break;
      kids.push(trunc(child, depth + 1));
    }
    return { ...node, children: kids };
  }
  return trunc(t, 0);
}
```

- [ ] **Step 4: Build the calc fixture**

```bash
mkdir -p tests/fixtures/calc/trajectory
cat > tests/fixtures/calc/trajectory/session.json <<'EOF'
{"task_name":"calc","task_description":"calculator 17 times 23","started_at":"2026-04-25T10:00:00Z","ended_at":"2026-04-25T10:00:30Z","event_count":7,"screenshot_count":3}
EOF
cat > tests/fixtures/calc/trajectory/events.jsonl <<'EOF'
{"kind":"click","ts":"2026-04-25T10:00:01Z","pid":501,"x":100,"y":200,"modifiers":[],"screenshot":"step_0001.jpg","post_state":"calc-open"}
{"kind":"key","ts":"2026-04-25T10:00:02Z","pid":501,"key":"1","modifiers":[],"screenshot":"step_0002.jpg","post_state":"display-1"}
{"kind":"key","ts":"2026-04-25T10:00:03Z","pid":501,"key":"7","modifiers":[],"screenshot":"step_0003.jpg","post_state":"display-17"}
EOF
# Create tiny placeholder JPGs (1x1 pixel)
printf '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\t\t\x08\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14\x1d\x1a\x1f\x1e\x1d\x1a\x1c\x1c $.\' ",#\x1c\x1c(7),01444\x1f\'9=82<.342\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00\xff\xc4\x00\x1f\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\xff\xc4\x00\xb5\x10\x00\x02\x01\x03\x03\x02\x04\x03\x05\x05\x04\x04\x00\x00\x01}\x01\x02\x03\x00\x04\x11\x05\x12!1A\x06\x13Qa\x07"q\x142\x81\x91\xa1\x08#B\xb1\xc1\x15R\xd1\xf0$3br\x82\t\n\x16\x17\x18\x19\x1a%&\'()*456789:CDEFGHIJSTUVWXYZcdefghijstuvwxyz\x83\x84\x85\x86\x87\x88\x89\x8a\x92\x93\x94\x95\x96\x97\x98\x99\x9a\xa2\xa3\xa4\xa5\xa6\xa7\xa8\xa9\xaa\xb2\xb3\xb4\xb5\xb6\xb7\xb8\xb9\xba\xc2\xc3\xc4\xc5\xc6\xc7\xc8\xc9\xca\xd2\xd3\xd4\xd5\xd6\xd7\xd8\xd9\xda\xe1\xe2\xe3\xe4\xe5\xe6\xe7\xe8\xe9\xea\xf1\xf2\xf3\xf4\xf5\xf6\xf7\xf8\xf9\xfa\xff\xda\x00\x08\x01\x01\x00\x00?\x00\xfb\xd0\x07\xff\xd9' > tests/fixtures/calc/trajectory/step_0001.jpg
cp tests/fixtures/calc/trajectory/step_0001.jpg tests/fixtures/calc/trajectory/step_0002.jpg
cp tests/fixtures/calc/trajectory/step_0001.jpg tests/fixtures/calc/trajectory/step_0003.jpg
```

- [ ] **Step 5: Run tests, expect pass**

Run: `bun test`
Expected: all pass.

- [ ] **Step 6: Commit**
```bash
git add src/trajectory.ts src/sampler.ts src/axtree.ts tests/trajectory.test.ts tests/sampler.test.ts tests/axtree.test.ts tests/fixtures/calc/
git commit -m "feat(compile): trajectory reader + screenshot sampler + AX truncator"
```

---

### Task 10: Compile prompt builder + token guard

**Files:**
- Create: `src/prompt.ts`, `tests/prompt.test.ts`

- [ ] **Step 1: Failing test**
```ts
// tests/prompt.test.ts
import { describe, expect, test } from "bun:test";
import { buildCompilePrompt, TOKEN_HARD_CAP } from "../src/prompt.ts";

describe("prompt", () => {
  test("includes task description, events, and sampled screenshots", () => {
    const prompt = buildCompilePrompt({
      taskName: "calc",
      taskDescription: "calculator 17 times 23",
      events: [{ kind: "click", ts: "x", pid: 1 } as any],
      sampledScreenshotPaths: ["/tmp/step_0001.jpg"],
      truncatedAxTrees: [{ role: "AXWindow", title: "Calc", children: [] }],
    });
    expect(prompt.text).toContain("calculator 17 times 23");
    expect(prompt.text).toContain('"kind":"click"');
    expect(prompt.imageReferences).toEqual(["/tmp/step_0001.jpg"]);
  });

  test("throws over token cap", () => {
    const huge = "x".repeat(TOKEN_HARD_CAP * 5);
    expect(() => buildCompilePrompt({
      taskName: "big", taskDescription: huge,
      events: [], sampledScreenshotPaths: [], truncatedAxTrees: [],
    })).toThrow(/too long/i);
  });
});
```

- [ ] **Step 2: Implement `src/prompt.ts`**
```ts
import type { TrajectoryEvent } from "./trajectory.ts";
import type { AxNode } from "./axtree.ts";

export const TOKEN_HARD_CAP = 80_000;
const CHARS_PER_TOKEN = 4;  // conservative estimate

export interface CompilePromptInput {
  taskName: string;
  taskDescription: string;
  events: TrajectoryEvent[];
  sampledScreenshotPaths: string[];
  truncatedAxTrees: AxNode[];
}

export interface CompilePrompt {
  text: string;
  imageReferences: string[];
}

export function buildCompilePrompt(input: CompilePromptInput): CompilePrompt {
  const text = `You are a tool that converts a recorded human demonstration on macOS into a SKILL.md file.

The SKILL.md output must satisfy BOTH formats:
- cua's format (https://cua.ai/docs — "Demonstration-Guided Skills")
- agentskills format (https://agentskills.io/specification)

Both expect frontmatter with at least \`name\` and \`description\`, and a body with a title and steps.

TASK NAME: ${input.taskName}
TASK DESCRIPTION: ${input.taskDescription}

EVENTS (chronological, JSON Lines):
${input.events.map((e) => JSON.stringify(e)).join("\n")}

AX TREES (one per unique window, truncated):
${input.truncatedAxTrees.map((t) => JSON.stringify(t, null, 2)).join("\n\n")}

You will see ${input.sampledScreenshotPaths.length} representative screenshots inline.

Produce a SKILL.md that:
1. Has frontmatter with \`name\` (kebab-case) and \`description\` (one sentence).
2. Has a top-level \`# <Title>\` heading.
3. Has a \`## Goal\` section with one paragraph explaining intent.
4. Has a \`## Steps\` section with a numbered list of high-level actions, NOT pixel coordinates.
5. Each step names the target by AX role + title (e.g. "click the AXButton titled 'Labels' in the toolbar"), NOT by pixel.
6. Has an \`## Anchors\` section with the AX paths observed in the recording, marked as hints.
7. Has a \`## Stop conditions\` section.

Output ONLY the SKILL.md content. No commentary.`;

  if (text.length / CHARS_PER_TOKEN > TOKEN_HARD_CAP) {
    throw new Error(
      `recording too long: prompt would exceed ${TOKEN_HARD_CAP} tokens. ` +
      `Try a shorter task or fewer events.`
    );
  }

  return { text, imageReferences: input.sampledScreenshotPaths };
}
```

- [ ] **Step 3: Run tests, expect pass**

Run: `bun test`
Expected: 2 new tests pass.

- [ ] **Step 4: Commit**
```bash
git add src/prompt.ts tests/prompt.test.ts
git commit -m "feat(compile): prompt builder with 80k token guard"
```

---

### Task 11: Hybrid SKILL.md schema validator

**Files:**
- Create: `src/schema.ts`, `tests/schema.test.ts`, `tests/fixtures/skills/valid-hybrid.md`, `tests/fixtures/skills/missing-name.md`, `tests/fixtures/skills/no-steps.md`

The hybrid SKILL.md must satisfy BOTH cua and agentskills schemas. Required: `name` (kebab-case), `description`, top-level `# Title`, `## Steps` (or numbered list).

- [ ] **Step 1: Create fixtures**

```markdown
<!-- tests/fixtures/skills/valid-hybrid.md -->
---
name: triage-issues
description: Triage open issues in a GitHub repo by applying labels.
---

# Triage GitHub Issues

## Goal
For each open issue, apply a label.

## Steps
1. Open the issues page.
2. For each issue, click Labels.
3. Apply the matching label.

## Anchors
- Labels button is `AXButton[title=Labels]`.

## Stop conditions
- All visible issues have a label.
```

```markdown
<!-- tests/fixtures/skills/missing-name.md -->
---
description: no name field
---
# Title
## Steps
1. step
```

```markdown
<!-- tests/fixtures/skills/no-steps.md -->
---
name: bad-skill
description: missing steps section
---
# Title
just prose
```

- [ ] **Step 2: Failing tests**
```ts
// tests/schema.test.ts
import { describe, expect, test } from "bun:test";
import { validateSkillMd } from "../src/schema.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures/skills", name), "utf-8");

describe("schema", () => {
  test("valid hybrid SKILL.md passes both validators", () => {
    const result = validateSkillMd(fx("valid-hybrid.md"));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("missing name fails with specific error", () => {
    const result = validateSkillMd(fx("missing-name.md"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /name/i.test(e))).toBe(true);
  });

  test("no steps section fails", () => {
    const result = validateSkillMd(fx("no-steps.md"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /steps/i.test(e))).toBe(true);
  });

  test("non-kebab-case name fails", () => {
    const result = validateSkillMd(`---
name: TriageIssues
description: bad casing
---
# Title
## Steps
1. step
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /kebab/i.test(e))).toBe(true);
  });
});
```

- [ ] **Step 3: Implement `src/schema.ts`**
```ts
import { parse as parseYaml } from "yaml";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  frontmatter: Record<string, unknown> | null;
}

export function validateSkillMd(md: string): ValidationResult {
  const errors: string[] = [];
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    return { valid: false, errors: ["missing YAML frontmatter (---...---)"], frontmatter: null };
  }
  let fm: Record<string, unknown>;
  try { fm = parseYaml(fmMatch[1]!) as Record<string, unknown>; }
  catch (e) {
    return { valid: false, errors: [`invalid YAML frontmatter: ${e}`], frontmatter: null };
  }
  const body = fmMatch[2]!;

  // Required: name
  if (!fm.name || typeof fm.name !== "string") {
    errors.push("frontmatter must include `name` (string)");
  } else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name)) {
    errors.push("`name` must be kebab-case (e.g. triage-issues)");
  }
  // Required: description
  if (!fm.description || typeof fm.description !== "string") {
    errors.push("frontmatter must include `description` (string)");
  }
  // Body: must have a top-level # Title
  if (!/^#\s+\S/m.test(body)) {
    errors.push("body must include a top-level `# Title` heading");
  }
  // Body: must have a ## Steps section
  if (!/^##\s+Steps\b/im.test(body)) {
    errors.push("body must include a `## Steps` section");
  }

  return { valid: errors.length === 0, errors, frontmatter: fm };
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `bun test`
Expected: 4 new tests pass.

- [ ] **Step 5: Commit**
```bash
git add src/schema.ts tests/schema.test.ts tests/fixtures/skills/
git commit -m "feat(compile): hybrid SKILL.md validator (cua + agentskills schema)"
```

---

### Task 12: `compile` subcommand

**Files:**
- Create: `src/compile.ts`, `tests/compile.test.ts`
- Modify: `src/cli.ts`

The `compile` subcommand:
1. Reads the trajectory dir
2. Builds the prompt (sampler + truncator + budget guard)
3. Calls Claude API (vision-enabled) with prompt + sampled screenshots inline
4. Validates output. If invalid, calls Claude AGAIN with the validator's error messages and "fix it"
5. Writes `~/.cua/skills/<name>/SKILL.md`

- [ ] **Step 1: Failing test (mocked Claude)**
```ts
// tests/compile.test.ts
import { describe, expect, test } from "bun:test";
import { compileSkillMd } from "../src/compile.ts";
import { join } from "node:path";

describe("compile", () => {
  test("produces a valid SKILL.md from a trajectory", async () => {
    const trajectoryDir = join(import.meta.dir, "fixtures/calc/trajectory");
    const fakeClaude = {
      callsMade: 0,
      async generate(_args: any) {
        this.callsMade++;
        return `---
name: calc
description: Use Calculator to compute 17 times 23.
---

# Calculator: 17 × 23

## Goal
Open Calculator and compute 17 × 23.

## Steps
1. Open Calculator.
2. Type 17.
3. Type *.
4. Type 23.
5. Press =.

## Anchors
- Calculator buttons are AXButton.

## Stop conditions
- The display shows the result.
`;
      },
    };

    const result = await compileSkillMd({
      trajectoryDir,
      skillName: "calc",
      claudeClient: fakeClaude,
    });
    expect(result.valid).toBe(true);
    expect(result.skillMd).toContain("name: calc");
    expect(fakeClaude.callsMade).toBe(1);
  });

  test("re-prompts Claude once when first output is invalid", async () => {
    const trajectoryDir = join(import.meta.dir, "fixtures/calc/trajectory");
    const fakeClaude = {
      callsMade: 0,
      async generate(_args: any) {
        this.callsMade++;
        if (this.callsMade === 1) return "no frontmatter at all";
        return `---
name: calc
description: ok now.
---
# C
## Steps
1. ok
`;
      },
    };
    const result = await compileSkillMd({ trajectoryDir, skillName: "calc", claudeClient: fakeClaude });
    expect(result.valid).toBe(true);
    expect(fakeClaude.callsMade).toBe(2);
  });
});
```

- [ ] **Step 2: Implement `src/compile.ts`**
```ts
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readTrajectory } from "./trajectory.ts";
import { sampleScreenshots } from "./sampler.ts";
import { truncateAxTree, type AxNode } from "./axtree.ts";
import { buildCompilePrompt } from "./prompt.ts";
import { validateSkillMd } from "./schema.ts";
import { resolveSkillRoot } from "./paths.ts";

export interface ClaudeClient {
  generate(args: { prompt: string; imagePaths: string[] }): Promise<string>;
}

export interface CompileOptions {
  trajectoryDir: string;
  skillName: string;
  claudeClient: ClaudeClient;
}

export interface CompileResult {
  valid: boolean;
  skillMd: string;
  outputPath: string;
  errors: string[];
}

const SCREENSHOT_CAP = 6;
const AX_MAX_NODES = 200;
const AX_MAX_DEPTH = 6;

export async function compileSkillMd(opts: CompileOptions): Promise<CompileResult> {
  const trajectory = await readTrajectory(opts.trajectoryDir);
  const sampled = sampleScreenshots(trajectory.events, SCREENSHOT_CAP)
    .map((name) => join(opts.trajectoryDir, name));

  const uniqueAxTrees: AxNode[] = [];
  const seen = new Set<string>();
  for (const e of trajectory.events) {
    if (!e.ax_tree) continue;
    const key = JSON.stringify((e.ax_tree as AxNode).title);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueAxTrees.push(truncateAxTree(e.ax_tree as AxNode, { maxNodes: AX_MAX_NODES, maxDepth: AX_MAX_DEPTH }));
  }

  const prompt = buildCompilePrompt({
    taskName: trajectory.session.task_name,
    taskDescription: trajectory.session.task_description,
    events: trajectory.events,
    sampledScreenshotPaths: sampled,
    truncatedAxTrees: uniqueAxTrees,
  });

  let skillMd = await opts.claudeClient.generate({ prompt: prompt.text, imagePaths: prompt.imageReferences });
  let validation = validateSkillMd(skillMd);

  if (!validation.valid) {
    // Single retry with the error feedback
    const fixPrompt = `${prompt.text}\n\nThe previous attempt failed validation:\n${validation.errors.join("\n")}\n\nFix it. Output ONLY the corrected SKILL.md.`;
    skillMd = await opts.claudeClient.generate({ prompt: fixPrompt, imagePaths: prompt.imageReferences });
    validation = validateSkillMd(skillMd);
  }

  const root = resolveSkillRoot(opts.skillName);
  mkdirSync(root, { recursive: true });
  const outputPath = join(root, "SKILL.md");
  writeFileSync(outputPath, skillMd);

  return { valid: validation.valid, skillMd, outputPath, errors: validation.errors };
}

// Production Claude client wrapper.
export class AnthropicClaudeClient implements ClaudeClient {
  constructor(private apiKey: string = Bun.env.ANTHROPIC_API_KEY ?? "") {
    if (!this.apiKey) throw new Error("ANTHROPIC_API_KEY env var required");
  }

  async generate(args: { prompt: string; imagePaths: string[] }): Promise<string> {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: this.apiKey });

    const content: Array<unknown> = [{ type: "text", text: args.prompt }];
    for (const path of args.imagePaths) {
      const data = readFileSync(path);
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: data.toString("base64") },
      });
    }
    const msg = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 4096,
      messages: [{ role: "user", content: content as any }],
    });
    const textBlock = msg.content.find((b: any) => b.type === "text") as any;
    return textBlock?.text ?? "";
  }
}
```

- [ ] **Step 3: Wire into `src/cli.ts`**
```ts
case "compile": {
  const skillName = args[1];
  if (!skillName) throw new Error("compile requires <skill-name>");
  const { compileSkillMd, AnthropicClaudeClient } = await import("./compile.ts");
  const { resolveSkillTrajectoryPath } = await import("./paths.ts");
  const result = await compileSkillMd({
    trajectoryDir: resolveSkillTrajectoryPath(skillName),
    skillName,
    claudeClient: new AnthropicClaudeClient(),
  });
  console.log(`[open42] wrote ${result.outputPath}`);
  if (!result.valid) {
    console.error(`[open42] WARNING: SKILL.md failed validation: ${result.errors.join(", ")}`);
    process.exitCode = 2;
  }
  return;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `bun test tests/compile.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**
```bash
git add src/compile.ts src/cli.ts tests/compile.test.ts
git commit -m "feat(cli): compile subcommand with Claude API + validation retry"
```

---

### Task 13: `run` subcommand (Claude Agent SDK + cua-driver MCP)

**Files:**
- Create: `src/run.ts`, `tests/run.test.ts`
- Modify: `src/cli.ts`

Safety controls (from design doc + eng review):
- Default `--dry-run` (prints actions, doesn't execute). Require `--live`.
- `⌘.` global hotkey aborts (caught via `SIGINT`-like handler — for v0.1 just accept Ctrl-C as the abort).
- Max-steps cap, default 50, override via `--max-steps`.
- Per-step preview: print intent before executing.
- `--confirm` requires Enter between steps.

**Note on Claude Agent SDK:** confirm package name during execution. If `@anthropic-ai/claude-agent-sdk` isn't published, fall back to `@anthropic-ai/sdk` with a hand-rolled tool-use loop wrapping cua-driver MCP. The test contract below is SDK-agnostic.

- [ ] **Step 1: Failing test (mocked Agent SDK query function)**
```ts
// tests/run.test.ts
import { describe, expect, test } from "bun:test";
import { runSkill, type QueryFn } from "../src/run.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

describe("run", () => {
  test("--dry-run blocks tool execution via PreToolUse hook", async () => {
    const dir = makeFakeSkill("test1");
    const recorded: { hookCalled: boolean; decision: string | undefined } = {
      hookCalled: false, decision: undefined,
    };

    const fakeQuery: QueryFn = async function* (input) {
      // Simulate the SDK invoking the user-supplied PreToolUse hook for one tool call.
      const hooks = (input.options as any).hooks?.PreToolUse;
      const hook = hooks?.[0]?.hooks?.[0];
      if (hook) {
        recorded.hookCalled = true;
        const result = await hook({ tool_name: "mcp__cua-driver__click", tool_input: { element_index: 1 } });
        recorded.decision = result?.decision;
      }
      yield { type: "result", result: "done" };
    };

    await runSkill({
      skillRoot: dir, userPrompt: "do it",
      live: false, maxSteps: 50, queryFn: fakeQuery,
    });
    expect(recorded.hookCalled).toBe(true);
    expect(recorded.decision).toBe("block");
  });

  test("--live does not block (hook returns empty)", async () => {
    const dir = makeFakeSkill("test2");
    let blockedCount = 0;

    const fakeQuery: QueryFn = async function* (input) {
      const hooks = (input.options as any).hooks?.PreToolUse;
      const hook = hooks?.[0]?.hooks?.[0];
      if (hook) {
        const result = await hook({ tool_name: "mcp__cua-driver__click", tool_input: {} });
        if (result?.decision === "block") blockedCount++;
      }
      yield { type: "result", result: "done" };
    };

    await runSkill({
      skillRoot: dir, userPrompt: "do it",
      live: true, maxSteps: 50, queryFn: fakeQuery,
    });
    expect(blockedCount).toBe(0);
  });

  test("max-steps is propagated as maxTurns to the SDK", async () => {
    const dir = makeFakeSkill("test3");
    let receivedMaxTurns = -1;

    const fakeQuery: QueryFn = async function* (input) {
      receivedMaxTurns = (input.options as any).maxTurns;
      yield { type: "result", result: "done" };
    };

    await runSkill({
      skillRoot: dir, userPrompt: "x",
      live: true, maxSteps: 7, queryFn: fakeQuery,
    });
    expect(receivedMaxTurns).toBe(7);
  });

  test("cua-driver MCP server is registered in SDK options", async () => {
    const dir = makeFakeSkill("test4");
    let registered: any = null;

    const fakeQuery: QueryFn = async function* (input) {
      registered = (input.options as any).mcpServers;
      yield { type: "result", result: "done" };
    };

    await runSkill({
      skillRoot: dir, userPrompt: "x",
      live: true, maxSteps: 50, queryFn: fakeQuery,
    });
    expect(registered).toHaveProperty("cua-driver");
    expect(registered["cua-driver"].command).toBe("cua-driver");
    expect(registered["cua-driver"].args).toEqual(["mcp"]);
  });
});

function makeFakeSkill(name: string): string {
  const dir = join("/tmp", `open42-test-${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---
name: ${name}
description: test
---
# Test
## Steps
1. do something
`);
  return dir;
}
```

- [ ] **Step 2: Implement `src/run.ts`**

The actual Claude Agent SDK API (verified at planning time):
```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
for await (const message of query({
  prompt: "...",
  options: {
    mcpServers: { "cua-driver": { command: "cua-driver", args: ["mcp"] } },
    hooks: { PreToolUse: [{ matcher: ".*", hooks: [previewOrBlock] }] },
    maxTurns: 50,
  },
})) { /* messages: tool_use, tool_result, text, etc. */ }
```

Hooks intercept tool calls. We use `PreToolUse` to:
- print the preview ("about to: click Labels button")
- when `dryRun`, return a synthetic blocked result so the tool never executes

```ts
// src/run.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RunOptions {
  skillRoot: string;
  userPrompt: string;
  live: boolean;
  maxSteps: number;
  confirm?: boolean;
  // Injectable for tests. In production, pass `realQuery`.
  queryFn?: QueryFn;
}

export type QueryFn = (input: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export async function runSkill(opts: RunOptions): Promise<void> {
  const skillMd = readFileSync(join(opts.skillRoot, "SKILL.md"), "utf-8");
  const systemPrompt = buildSystemPrompt(skillMd);

  if (!opts.live) {
    console.log("[open42] DRY RUN — no cua-driver tools will execute. Pass --live to actually run.");
  }
  console.log("[open42] press Ctrl-C to abort.");

  let aborted = false;
  const onSigint = () => {
    aborted = true;
    console.log("\n[open42] aborted by user.");
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  const previewHook = async (input: any) => {
    const tool = input.tool_name ?? "<unknown>";
    const args = input.tool_input ?? {};
    const summary = summarizeToolCall(tool, args);
    console.log(`[open42] about to: ${summary}`);
    if (!opts.live) {
      // Block execution by returning a "denied" decision.
      return { decision: "block", reason: "dry-run mode" };
    }
    if (opts.confirm) {
      const ok = await promptYesNo("execute? [y/N]: ");
      if (!ok) return { decision: "block", reason: "user declined" };
    }
    return {};
  };

  const queryFn = opts.queryFn ?? (await loadRealQuery());

  let stepCount = 0;
  try {
    for await (const message of queryFn({
      prompt: opts.userPrompt,
      options: {
        systemPrompt,
        mcpServers: { "cua-driver": { command: "cua-driver", args: ["mcp"] } },
        allowedTools: ["mcp__cua-driver__click", "mcp__cua-driver__type_text",
                       "mcp__cua-driver__get_window_state", "mcp__cua-driver__screenshot",
                       "mcp__cua-driver__press_key", "mcp__cua-driver__hotkey",
                       "mcp__cua-driver__list_apps", "mcp__cua-driver__list_windows",
                       "mcp__cua-driver__launch_app", "mcp__cua-driver__scroll"],
        hooks: { PreToolUse: [{ matcher: ".*", hooks: [previewHook] }] },
        maxTurns: opts.maxSteps,
      },
    })) {
      if (aborted) break;
      const msg = message as any;
      if (msg.type === "tool_use") stepCount++;
      if (msg.type === "result" && "result" in msg) {
        console.log(`[open42] ${msg.result}`);
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  console.log(`[open42] done. ${stepCount} tool calls.`);
}

function buildSystemPrompt(skillMd: string): string {
  return `You are an agent executing a recorded skill on the user's macOS via cua-driver.

You have access to cua-driver MCP tools: click, type_text, get_window_state, screenshot, press_key, hotkey, list_apps, list_windows, launch_app, scroll.

Before each tool call, the system will preview your intended action to the user. Be concise and intentional.

Stop when the skill's stop conditions are met OR you cannot proceed (e.g., unrecognized modal, stuck state).

SKILL:
${skillMd}`;
}

function summarizeToolCall(tool: string, args: Record<string, unknown>): string {
  if (tool.endsWith("click")) return `click element ${(args.element_index as number) ?? `${args.x},${args.y}`}`;
  if (tool.endsWith("type_text")) return `type ${JSON.stringify(args.text)}`;
  if (tool.endsWith("press_key")) return `press ${args.key}`;
  if (tool.endsWith("hotkey")) return `hotkey ${(args.modifiers as string[])?.join("+")}`;
  if (tool.endsWith("launch_app")) return `launch ${args.bundle_id}`;
  if (tool.endsWith("get_window_state")) return `snapshot window ${args.window_id}`;
  return `${tool}(${JSON.stringify(args)})`;
}

async function promptYesNo(prompt: string): Promise<boolean> {
  process.stdout.write(prompt);
  const buf = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(d.toString().trim()));
  });
  return buf.toLowerCase() === "y" || buf.toLowerCase() === "yes";
}

async function loadRealQuery(): Promise<QueryFn> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return (input) => sdk.query(input as any) as AsyncIterable<unknown>;
}
```

- [ ] **Step 3: Wire into `src/cli.ts`**
```ts
case "run": {
  const skillName = args[1];
  if (!skillName) throw new Error("run requires <skill-name>");
  const live = args.includes("--live");
  const confirm = args.includes("--confirm");
  const maxStepsIdx = args.indexOf("--max-steps");
  const maxSteps = maxStepsIdx >= 0 ? Number(args[maxStepsIdx + 1]) : 50;
  const userPromptIdx = args.indexOf("--prompt");
  const userPrompt = userPromptIdx >= 0
    ? (args[userPromptIdx + 1] ?? "now do the task")
    : "now do the task";

  const { runSkill } = await import("./run.ts");
  const { resolveSkillRoot } = await import("./paths.ts");
  await runSkill({
    skillRoot: resolveSkillRoot(skillName),
    userPrompt,
    live, confirm, maxSteps,
  });
  return;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `bun test tests/run.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Live integration smoke (must pass before Task 14)**

```bash
# Ensure ANTHROPIC_API_KEY is exported and cua-driver daemon is running.
open -n -g -a CuaDriver --args serve

# Drop a hand-written SKILL.md for sanity check.
mkdir -p ~/.cua/skills/hello
cat > ~/.cua/skills/hello/SKILL.md <<'EOF'
---
name: hello
description: Take a screenshot of the frontmost window.
---
# Hello
## Steps
1. Use list_windows to get the frontmost pid + window_id.
2. Call get_window_state on that window. Print its title.
EOF

# Dry run first
bun bin/open42 run hello --prompt "do it"
# Expected: prints "about to: ..." for each tool call. No actual execution.

# Live run
bun bin/open42 run hello --live --prompt "do it"
# Expected: cua-driver tools execute. Title of frontmost window printed.
```

If this smoke fails, the rest of the plan is blocked. Debug here; do not proceed to Task 14 with a broken `run`.

- [ ] **Step 6: Commit**
```bash
git add src/run.ts src/cli.ts tests/run.test.ts
git commit -m "feat(cli): run subcommand with safety controls + Claude Agent SDK skeleton"
```

---

## Chunk 4: Quality, E2E, Ship

Goal: eval suite, CI, README, hero gif, notarized DMG, tweet.

### Task 14: Eval suite (3 golden fixtures)

**Ordering:** This task depends on Task 16 (Calculator E2E smoke) AND Task 17 (triage iteration) producing real recordings. **Do Task 16 and Task 17 first**, then come back to Task 14. The plan is numbered 14 → 15 → 16 → 17 for narrative flow but the dependency is: 13 → 16 → 17 → 14 → 15 → 18+.

**Files:**
- Create: `tests/eval.test.ts`
- Augment: `tests/fixtures/calc/`, `tests/fixtures/triage/`, `tests/fixtures/todo/`

Each fixture has:
- `trajectory/` (a real recording, hand-edited if needed)
- `expected.md` — a canonical valid SKILL.md to compare structure against
- `assertions.json` — specific structural assertions

- [ ] **Step 1: Copy real trajectories from Task 16 and 17 into fixtures**

```bash
# After Tasks 16 + 17 have run the recorder for calc, triage, and a third task:
mkdir -p tests/fixtures/triage tests/fixtures/todo
cp -r ~/.cua/skills/calc/trajectory tests/fixtures/calc/      # if not already there from Task 9
cp -r ~/.cua/skills/triage-issues/trajectory tests/fixtures/triage/

# Pick a third task — record it now if you don't have one
bun bin/open42 record todo "add a checkbox task in Reminders"
cp -r ~/.cua/skills/todo/trajectory tests/fixtures/todo/
```

Write `assertions.json` for each fixture:
```json
{
  "must_contain_step_with": ["click", "Labels"],
  "must_contain_anchor_with_role": "AXButton",
  "step_count_min": 3,
  "step_count_max": 12
}
```

- [ ] **Step 2: Implement `tests/eval.test.ts`**
```ts
import { describe, expect, test } from "bun:test";
import { compileSkillMd, type ClaudeClient } from "../src/compile.ts";
import { validateSkillMd } from "../src/schema.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = ["calc", "triage", "todo"];

// Real Claude calls in CI: gated on ANTHROPIC_API_KEY env. Locally, skip if unset.
const RUN_LIVE = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!RUN_LIVE)("eval (live Claude API)", () => {
  for (const fx of FIXTURES) {
    test(`fixture/${fx} compiles to a valid SKILL.md matching assertions`, async () => {
      const dir = join(import.meta.dir, "fixtures", fx, "trajectory");
      const assertions = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", fx, "assertions.json"), "utf-8"));

      const { AnthropicClaudeClient } = await import("../src/compile.ts");
      const result = await compileSkillMd({
        trajectoryDir: dir, skillName: `eval-${fx}`,
        claudeClient: new AnthropicClaudeClient(),
      });

      expect(result.valid).toBe(true);
      const stepLines = result.skillMd.match(/^\d+\./gm) ?? [];
      expect(stepLines.length).toBeGreaterThanOrEqual(assertions.step_count_min);
      expect(stepLines.length).toBeLessThanOrEqual(assertions.step_count_max);
      for (const phrase of assertions.must_contain_step_with ?? []) {
        expect(result.skillMd.toLowerCase()).toContain(phrase.toLowerCase());
      }
    }, 60_000);  // 60s timeout for Claude API
  }
});

describe("eval (offline structure check)", () => {
  for (const fx of FIXTURES) {
    test(`fixture/${fx} has a valid expected.md`, () => {
      const expected = readFileSync(join(import.meta.dir, "fixtures", fx, "expected.md"), "utf-8");
      const v = validateSkillMd(expected);
      expect(v.valid).toBe(true);
    });
  }
});
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/eval.test.ts`
Expected: offline structure checks pass; live tests skip locally without API key.

Run with key: `ANTHROPIC_API_KEY=sk-ant-... bun test tests/eval.test.ts`
Expected: 3 live tests pass.

- [ ] **Step 4: Commit**
```bash
git add tests/eval.test.ts tests/fixtures/triage/ tests/fixtures/todo/ tests/fixtures/calc/expected.md tests/fixtures/calc/assertions.json
git commit -m "test(eval): 3 golden-fixture eval suite (calc, triage, todo)"
```

---

### Task 15: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**
```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
jobs:
  ts:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run lint
      - run: bun test
        env:
          # Live eval skipped in CI by default; uncomment to enable.
          # ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  swift:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - run: cd recorder && swift build -c release
      - run: cd recorder && swift test
```

- [ ] **Step 2: Create `.github/workflows/release.yml`**
```yaml
name: Release
on:
  push: { tags: ["v*.*.*"] }
jobs:
  build-dmg:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - name: Build per-arch and lipo into a universal binary
        run: |
          cd recorder
          swift build -c release --arch arm64
          swift build -c release --arch x86_64
          # Each invocation produces a separate binary under .build/<arch>-apple-macosx/release/
          mkdir -p .build/release
          lipo -create \
            .build/arm64-apple-macosx/release/open42-recorder \
            .build/x86_64-apple-macosx/release/open42-recorder \
            -output .build/release/open42-recorder
          lipo -info .build/release/open42-recorder  # verify
      - name: Codesign
        env:
          DEV_ID: ${{ secrets.APPLE_DEVELOPER_ID }}
          P12: ${{ secrets.APPLE_P12_BASE64 }}
          P12_PASSWORD: ${{ secrets.APPLE_P12_PASSWORD }}
        run: |
          # Decode + import cert
          echo "$P12" | base64 --decode > /tmp/cert.p12
          security create-keychain -p actions build.keychain
          security import /tmp/cert.p12 -k build.keychain -P "$P12_PASSWORD" -T /usr/bin/codesign
          security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k actions build.keychain
          security default-keychain -s build.keychain
          codesign --sign "$DEV_ID" --options runtime --timestamp recorder/.build/release/open42-recorder
      - name: Notarize
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_PASSWORD: ${{ secrets.APPLE_APP_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: |
          mkdir -p dmg-staging
          cp recorder/.build/release/open42-recorder dmg-staging/
          hdiutil create -volname "open42" -srcfolder dmg-staging -ov -format UDZO open42.dmg
          xcrun notarytool submit open42.dmg --apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
          xcrun stapler staple open42.dmg
      - uses: softprops/action-gh-release@v2
        with:
          files: open42.dmg
```

Required GitHub secrets (user sets these once):
- `APPLE_DEVELOPER_ID` (e.g., "Developer ID Application: Riccardo X (TEAMID)")
- `APPLE_P12_BASE64` (developer certificate exported as p12, base64-encoded)
- `APPLE_P12_PASSWORD`
- `APPLE_ID` (Apple ID email)
- `APPLE_APP_PASSWORD` (app-specific password from appleid.apple.com)
- `APPLE_TEAM_ID`

- [ ] **Step 3: Commit**
```bash
git add .github/
git commit -m "ci: add CI + notarized DMG release workflow"
```

---

### Task 16: Calculator E2E smoke

Manual end-to-end. No automated test (this is the canonical integration smoke).

- [ ] **Step 1: Run cua-driver daemon** (`open -n -g -a CuaDriver --args serve`)

- [ ] **Step 2: Build everything**
```bash
bun install
cd recorder && swift build -c release && cd ..
```

- [ ] **Step 3: Record**
```bash
bun bin/open42 record calc "calculate 17 times 23 in Calculator"
# Open Calculator. Type 17, *, 23, =. Ctrl-C in the recorder terminal.
```

Verify: `~/.cua/skills/calc/trajectory/events.jsonl` populated, `step_*.jpg` files exist, `session.json` correct.

- [ ] **Step 4: Compile**
```bash
ANTHROPIC_API_KEY=sk-ant-... bun bin/open42 compile calc
```

Verify: `~/.cua/skills/calc/SKILL.md` exists, validates, looks reasonable.

- [ ] **Step 5: Run --dry-run**
```bash
bun bin/open42 run calc --prompt "compute 17 * 23"
```

Verify: prints planned actions, doesn't execute.

- [ ] **Step 6: Run --live**
```bash
bun bin/open42 run calc --live --prompt "compute 17 * 23"
```

Verify: cursor moves, Calculator shows 391. The "demo" works end-to-end.

- [ ] **Step 7: Document observations**

Add `docs/PROGRESS.md`:
```markdown
# Build Progress

## 2026-04-25 — Calculator E2E smoke
- Record: ✅ 7 events, 4 screenshots
- Compile: ✅ valid SKILL.md, 5 steps
- Run --dry-run: ✅ planned 5 cua-driver tool calls
- Run --live: ✅ Calculator displays 391
- Notes: <anything surprising>
```

- [ ] **Step 8: Commit**
```bash
git add docs/PROGRESS.md
git commit -m "docs: calculator E2E smoke passes"
```

---

### Task 17: Triage iteration loop + bundled skill

Iterate the compile prompt against the canonical demo task until the resulting skill replays correctly on a different repo.

- [ ] **Step 1: Record triage in farzaa/clicky's issues page** (public repo)

- [ ] **Step 2: Compile → read SKILL.md → run --dry-run → critique**

Things to watch for:
- Did the LLM correctly identify the issue list as `AXList` of `AXLink`s?
- Are the steps high-level or pixel-level?
- Are anchors recorded?

- [ ] **Step 3: If quality is poor, edit `src/prompt.ts` and re-compile**

Common issues:
- Steps too literal → add "do not write pixel coordinates" emphasis
- No anchors → require `## Anchors` explicitly
- Too verbose → cap step count

- [ ] **Step 4: Run --live against a different public repo. Verify it works**

Do this with a repo whose issues differ from clicky's — e.g., a small npm library. If it triages 3 fresh issues correctly, the skill generalizes.

- [ ] **Step 5: Bundle the final skill**
```bash
mkdir -p skills/triage-issues
cp ~/.cua/skills/triage-issues/SKILL.md skills/triage-issues/
```

Add a one-line `skills/README.md` listing bundled skills.

- [ ] **Step 6: Commit**
```bash
git add src/prompt.ts skills/ docs/PROGRESS.md
git commit -m "feat: triage-issues skill working on multiple repos (compile prompt v2)"
```

---

### Task 18: README + hero gif

**Files:**
- Modify: `README.md`
- Add: `docs/open42-demo.gif`

- [ ] **Step 1: Write `README.md`**

Sections:
1. Hero gif (60s, embedded at top)
2. One-paragraph pitch: "open42 records a task once. Claude turns it into a SKILL.md. cua-driver replays it on your real Mac. macOS only. ~"
3. Install (two commands: `bun install` + cua-driver one-liner; or download DMG)
4. Quickstart (`record`, `compile`, `run`)
5. How it works (CGEventTap → Claude → cua-driver MCP)
6. Format compatibility (cua + agentskills hybrid)
7. Safety (--dry-run default, ⌘. abort, max-steps cap)
8. Roadmap (self-validating skill, more bundled skills)
9. Credits (clicky, cua, agentskills, cua-driver)

Keep under 200 lines.

- [ ] **Step 2: Record the hero gif**

60-second take showing record → compile → run on a small task. Use Kap or QuickTime. Compress to <5MB.

- [ ] **Step 3: Commit**
```bash
git add README.md docs/open42-demo.gif
git commit -m "docs: README with hero gif"
```

---

### Task 19: Release v0.1.0

- [ ] **Step 1: Set GitHub secrets** (one-time, manual via gh CLI or web UI)
```bash
gh secret set APPLE_DEVELOPER_ID --body "Developer ID Application: ..."
gh secret set APPLE_P12_BASE64 --body "$(base64 -i ~/path/to/cert.p12)"
gh secret set APPLE_P12_PASSWORD --body "..."
gh secret set APPLE_ID --body "you@example.com"
gh secret set APPLE_APP_PASSWORD --body "..."
gh secret set APPLE_TEAM_ID --body "..."
```

- [ ] **Step 2: Tag and push**
```bash
git tag v0.1.0
git push origin v0.1.0
```

- [ ] **Step 3: Verify CI builds DMG**

Watch the Release workflow in GitHub Actions. Expected: `open42.dmg` notarized + attached to the v0.1.0 release.

- [ ] **Step 4: Manual install test on a different Mac (or VM)**

Download `open42.dmg`, open, install, run. Verify no Gatekeeper warning. Run the bundled `triage-issues` skill against your own GitHub.

- [ ] **Step 5: Commit any fixes from the install test**

If the install test surfaces issues, fix and tag v0.1.1.

---

### Task 20: Tweet

- [ ] **Step 1: Compose tweet**

Format: 1 sentence + gif + repo link.

Draft: "I taught my Mac to triage GitHub issues by doing it once. Then it did it on a different repo. Built with cua-driver + agentskills. Open source. <gif> github.com/riccardo/open42"

- [ ] **Step 2: Optional 3-tweet thread**

1/ Hook (above)
2/ How: CGEventTap captures input + cua-driver snapshots AX state per click + Claude compiles to a SKILL.md (cua + agentskills compatible)
3/ Try it: `git clone && bun install` or download the notarized DMG. Drop the SKILL.md in `~/.claude/skills/` and Claude Code can use it too.

- [ ] **Step 3: Post**

---

## Risks and rollback

- **TCC permission churn during builds.** If `swift build` produces a binary at a different cdhash, Accessibility grant may invalidate. Mitigation: install location stable, rebuild path stable.
- **Claude Agent SDK API drift.** If the SDK package name or API differs from assumptions, fall back to hand-rolled loop on `@anthropic-ai/sdk` (Task 13 step 5 is the verification gate).
- **Compile prompt overfitting to triage.** Mitigation: 3-fixture eval suite (Task 14). If a future task type fails, add a 4th fixture and re-iterate the prompt.
- **macOS Sequoia + cua-driver compat.** cua-driver targets 14+. If we hit Sequoia-specific issues, document in README and pin recommended OS.

## NOT in scope

- DSL compiler (deferred Approach B from design).
- Self-validating skill loop (deferred Approach C from design).
- npm/Homebrew publishing.
- Multi-task skill library beyond bundled examples.
- Custom replay UI / cursor overlay (cua-driver's agent cursor is already good enough for v0.1).
- Cross-platform (Linux, Windows). cua-driver is macOS-only.

## What already exists (reused, not rebuilt)

- `clicky/GlobalPushToTalkShortcutMonitor.swift` — CGEventTap pattern.
- `cua skills record/replay` — SKILL.md + trajectory schema (hybrid output is compatible).
- `agentskills/skills-ref/` — agentskills SKILL.md schema.
- `cua-driver` — AX snapshots, screenshots, MCP for replay.
- `@anthropic-ai/sdk` — Claude vision API.
- `@anthropic-ai/claude-agent-sdk` — agent loop + MCP attachment (verify package name in Task 13).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 3 architectural issues found and resolved (Swift dist, format ambiguity, agent runtime) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**VERDICT:** ENG CLEARED — ready to implement.
