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
      throw NSError(domain: "showme-recorder", code: 1,
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
