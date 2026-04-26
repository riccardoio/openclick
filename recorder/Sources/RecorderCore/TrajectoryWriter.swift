import Foundation

/// Thread-safe writer for a cua-skills-format trajectory directory.
/// All public methods serialize through `queue` so the CGEventTap callback,
/// the screenshotter timer, and the SIGINT handler can call freely without
/// stepping on `eventsHandle`, `screenshotCounter`, or `eventCount`.
public final class TrajectoryWriter {
  private let directory: URL
  private let taskName: String
  private let taskDescription: String
  private let startedAt: Date
  private let eventsHandle: FileHandle
  private var screenshotCounter: Int = 0
  private var eventCount: Int = 0
  private var finalized: Bool = false
  private let queue = DispatchQueue(label: "showme.writer")

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

  public func appendEvent(
    _ event: Event,
    axTree: AXNode?,
    screenshotRef: String?,
    bundleId: String?,
    appName: String?
  ) throws {
    try queue.sync {
      guard !finalized else { return }
      let envelope = EventEnvelope(
        event: event,
        axTree: axTree,
        screenshotRef: screenshotRef,
        bundleId: bundleId,
        appName: appName
      )
      let data = try JSONEncoder().encode(envelope)
      eventsHandle.write(data)
      eventsHandle.write(Data([0x0A]))  // newline
      eventCount += 1
    }
  }

  public func nextScreenshotName() -> String {
    queue.sync {
      screenshotCounter += 1
      // cua-driver's `screenshot --image-out <path>` always writes PNG bytes
      // regardless of the chosen extension, so name files honestly. The
      // compile step sniffs magic bytes anyway, but the on-disk extension
      // should match reality so users browsing the trajectory directory
      // aren't misled.
      return String(format: "step_%04d.png", screenshotCounter)
    }
  }

  public func screenshotURL(name: String) -> URL {
    directory.appendingPathComponent(name)
  }

  public func finalize() throws {
    try queue.sync {
      guard !finalized else { return }
      finalized = true
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
}

/// Encodes the recorded event with its discriminator + fields inlined at the
/// top level of the JSON object, alongside ax_tree and screenshot keys.
/// We piggyback on Event's own encode(to:) to avoid a JSONSerialization round-trip
/// (which corrupts Bool fields via NSNumber bridging).
private struct EventEnvelope: Encodable {
  let event: Event
  let axTree: AXNode?
  let screenshotRef: String?
  let bundleId: String?
  let appName: String?

  func encode(to encoder: Encoder) throws {
    // Event.encode writes "kind" + the inner event's fields into the encoder's
    // underlying object. ClickEvent uses CodingKeys with windowId="window_id"
    // so snake_case is preserved on the wire.
    try event.encode(to: encoder)
    var container = encoder.container(keyedBy: DynamicKey.self)
    if let axTree = axTree {
      try container.encode(axTree, forKey: DynamicKey(stringValue: "ax_tree")!)
    }
    if let ref = screenshotRef {
      try container.encode(ref, forKey: DynamicKey(stringValue: "screenshot")!)
    }
    if let bundleId = bundleId {
      try container.encode(bundleId, forKey: DynamicKey(stringValue: "bundle_id")!)
    }
    if let appName = appName {
      try container.encode(appName, forKey: DynamicKey(stringValue: "app_name")!)
    }
  }
}

private struct DynamicKey: CodingKey {
  var stringValue: String
  var intValue: Int? { nil }
  init?(stringValue: String) { self.stringValue = stringValue }
  init?(intValue: Int) { return nil }
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
