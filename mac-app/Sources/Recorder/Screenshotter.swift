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

  /// Capture a screenshot synchronously and return the name written to disk
  /// (or nil if there's no current target or the cua-driver call failed).
  /// main.swift uses the return value as the screenshotRef for events.jsonl
  /// so the on-disk file and the JSONL line stay in lockstep.
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
