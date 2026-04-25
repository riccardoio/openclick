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

  func testClickEventEncodesWindowIdAsSnakeCase() throws {
    let event = Event.click(ClickEvent(
      ts: "2026-04-25T10:00:00Z", pid: 71422, windowId: 8104, x: 0, y: 0, modifiers: []
    ))
    let data = try JSONEncoder().encode(event)
    let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(json["window_id"] as? Int, 8104, "wire format must be window_id (snake_case)")
    XCTAssertNil(json["windowId"], "must NOT use camelCase windowId on the wire")
  }

  func testClickEventDecodesFromRawSnakeCaseJson() throws {
    let raw = "{\"kind\":\"click\",\"ts\":\"2026-04-25T10:00:00Z\",\"pid\":71422,\"window_id\":8104,\"x\":1,\"y\":2,\"modifiers\":[]}"
    let event = try JSONDecoder().decode(Event.self, from: Data(raw.utf8))
    guard case .click(let click) = event else { return XCTFail("expected click variant") }
    XCTAssertEqual(click.windowId, 8104)
  }

  func testKeyEventEncodesKindField() throws {
    let event = Event.key(KeyEvent(ts: "2026-04-25T10:00:01Z", pid: 71422, key: "a", modifiers: []))
    let data = try JSONEncoder().encode(event)
    let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(json["kind"] as? String, "key")
  }

  func testScrollEventRoundTrips() throws {
    let event = Event.scroll(ScrollEvent(ts: "2026-04-25T10:00:02Z", pid: 1, dx: 0, dy: -3))
    let data = try JSONEncoder().encode(event)
    let decoded = try JSONDecoder().decode(Event.self, from: data)
    XCTAssertEqual(decoded, event)
  }

  func testDecodeRejectsUnknownKind() {
    let bad = "{\"kind\":\"laser\",\"ts\":\"x\",\"pid\":1}".data(using: .utf8)!
    XCTAssertThrowsError(try JSONDecoder().decode(Event.self, from: bad))
  }
}
