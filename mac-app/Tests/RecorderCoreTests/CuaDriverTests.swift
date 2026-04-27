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
