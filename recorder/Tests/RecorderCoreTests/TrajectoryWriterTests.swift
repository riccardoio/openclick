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

  func testEnvelopeInlinesEventFieldsWithSnakeCaseAndAttachesAxTreeAndScreenshot() throws {
    let dir = try tempDir()
    let writer = try TrajectoryWriter(directory: dir, taskName: "x", taskDescription: "x")
    let event = Event.click(ClickEvent(
      ts: "2026-04-25T10:00:00Z", pid: 71422, windowId: 8104, x: 12, y: 34, modifiers: ["cmd"]
    ))
    let ax = AXNode(role: "AXButton", title: "Labels", children: [])
    try writer.appendEvent(event, axTree: ax, screenshotRef: "step_0001.jpg")
    try writer.finalize()

    let line = try XCTUnwrap(
      try String(contentsOf: dir.appendingPathComponent("events.jsonl"))
        .split(separator: "\n").first.map(String.init)
    )
    let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])

    // Discriminator + event fields inlined at top level
    XCTAssertEqual(obj["kind"] as? String, "click")
    XCTAssertEqual(obj["ts"] as? String, "2026-04-25T10:00:00Z")
    XCTAssertEqual(obj["pid"] as? Int, 71422)
    XCTAssertEqual(obj["window_id"] as? Int, 8104, "must be snake_case window_id")
    XCTAssertNil(obj["windowId"], "must NOT have camelCase windowId on the wire")

    // ax_tree + screenshot attached
    let axDict = try XCTUnwrap(obj["ax_tree"] as? [String: Any])
    XCTAssertEqual(axDict["role"] as? String, "AXButton")
    XCTAssertEqual(axDict["title"] as? String, "Labels")
    XCTAssertEqual(obj["screenshot"] as? String, "step_0001.jpg")
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

  func testFinalizeIsIdempotent() throws {
    let dir = try tempDir()
    let writer = try TrajectoryWriter(directory: dir, taskName: "x", taskDescription: "x")
    try writer.finalize()
    // SIGINT handler may call finalize again; must not throw / crash.
    XCTAssertNoThrow(try writer.finalize())
  }

  func testAppendAfterFinalizeIsNoOp() throws {
    let dir = try tempDir()
    let writer = try TrajectoryWriter(directory: dir, taskName: "x", taskDescription: "x")
    try writer.finalize()
    let event = Event.key(KeyEvent(ts: "x", pid: 1, key: "a", modifiers: []))
    XCTAssertNoThrow(try writer.appendEvent(event, axTree: nil, screenshotRef: nil))
  }

  func testConcurrentAppendsAndCounterAreSerialized() throws {
    let dir = try tempDir()
    let writer = try TrajectoryWriter(directory: dir, taskName: "x", taskDescription: "x")
    let group = DispatchGroup()
    let n = 200
    for i in 0..<n {
      DispatchQueue.global().async(group: group) {
        let event = Event.click(ClickEvent(
          ts: "2026-04-25T10:00:00Z", pid: 1, windowId: i, x: 0, y: 0, modifiers: []
        ))
        try? writer.appendEvent(event, axTree: nil, screenshotRef: writer.nextScreenshotName())
      }
    }
    group.wait()
    try writer.finalize()

    let raw = try String(contentsOf: dir.appendingPathComponent("events.jsonl"))
    let lines = raw.split(separator: "\n").map(String.init)
    XCTAssertEqual(lines.count, n, "every concurrent append must produce exactly one line")
    // Each line should parse cleanly (no interleaved bytes).
    for line in lines {
      _ = try JSONSerialization.jsonObject(with: Data(line.utf8))
    }
  }

  private func tempDir() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }
}
