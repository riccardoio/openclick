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
