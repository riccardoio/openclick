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
