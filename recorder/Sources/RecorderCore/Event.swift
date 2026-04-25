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
    self.ts = ts
    self.pid = pid
    self.windowId = windowId
    self.x = x
    self.y = y
    self.modifiers = modifiers
  }

  enum CodingKeys: String, CodingKey {
    case ts, pid, x, y, modifiers
    case windowId = "window_id"
  }
}

public struct KeyEvent: Codable, Equatable {
  public let ts: String
  public let pid: Int32
  public let key: String
  public let modifiers: [String]
  public init(ts: String, pid: Int32, key: String, modifiers: [String]) {
    self.ts = ts
    self.pid = pid
    self.key = key
    self.modifiers = modifiers
  }
}

public struct ScrollEvent: Codable, Equatable {
  public let ts: String
  public let pid: Int32
  public let dx: Double
  public let dy: Double
  public init(ts: String, pid: Int32, dx: Double, dy: Double) {
    self.ts = ts
    self.pid = pid
    self.dx = dx
    self.dy = dy
  }
}
