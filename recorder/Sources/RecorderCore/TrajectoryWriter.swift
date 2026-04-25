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
